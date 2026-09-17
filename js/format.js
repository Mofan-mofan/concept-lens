// 格式匹配与规整：把用户/AI 给的一段文字，整理成"符合它要替换的那个正文块"的样式。
// 背景：文档被拆成 blocks（h 标题 / p 段落 / li 列表项 / quote 引用），每个块渲染时
// 自带层级符号，所以贴进来的文字不该再带 # - > 1. 这类块级标记，也不该跨多行。
// 本模块只做"安全的确定性整理"，不改语义；拿不准的一律不动，只在 notes 里说明。
// 对外暴露 window.QD_FORMAT = { normalize }，供 js/ask.js 与 js/app.js 复用。
(function () {
  "use strict";

  // 去掉整段外层包裹的 Markdown 代码围栏（AI 偶尔会套一层 ```）。
  function stripFence(t, notes) {
    var m = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(t.trim());
    if (m) { notes.push("去掉代码围栏"); return m[1]; }
    return t;
  }

  // 去掉 AI 常见的引导语前缀（"改写后：" 之类）。
  function stripLeadIn(t, notes) {
    var m = /^[\s]*(?:改写后|修改后|重写后|新版|成稿|正文)\s*[:：]\s*/.exec(t);
    if (m) { notes.push("去掉引导语"); return t.slice(m[0].length); }
    return t;
  }

  // 去掉把整段裹起来的成对引号。
  function stripOuterQuotes(t, notes) {
    var s = t.trim();
    var pairs = [["\"", "\""], ["“", "”"], ["「", "」"], ["『", "』"]];
    for (var i = 0; i < pairs.length; i++) {
      if (s.length > 1 && s.charAt(0) === pairs[i][0] &&
          s.charAt(s.length - 1) === pairs[i][1]) {
        notes.push("去掉外层引号");
        return s.slice(1, -1).trim();
      }
    }
    return t;
  }

  // 按块类型剥掉行首的块级标记；标题再清掉句末标点。
  function stripBlockMarkers(line, blockType, notes) {
    var before = line;
    if (blockType === "h") {
      line = line.replace(/^\s*#{1,6}\s+/, "");
    } else if (blockType === "li") {
      line = line.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+[.、)]\s+/, "");
    } else if (blockType === "quote") {
      line = line.replace(/^\s*>\s?/, "");
    } else {
      // p：只清掉明显误粘的 # 与 > 前缀
      line = line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>\s?/, "");
    }
    line = line.replace(/^\s+|\s+$/g, "");
    if (line !== before.trim()) notes.seen = true;
    return line;
  }

  // 统计一批样本里 **加粗** 与 `行内代码` 的使用量，用来判断上下文的"字体"习惯。
  function inlineStats(samples) {
    var bold = 0, code = 0;
    (samples || []).forEach(function (s) {
      s = String(s == null ? "" : s);
      bold += (s.match(/\*\*/g) || []).length;
      code += (s.match(/`/g) || []).length;
    });
    return { bold: bold, code: code };
  }

  function ctxSamples(ctx, weightNeighbors) {
    var out = (ctx && ctx.siblings ? ctx.siblings.slice() : []);
    if (ctx && ctx.before) { out.push(ctx.before); if (weightNeighbors) out.push(ctx.before); }
    if (ctx && ctx.after) { out.push(ctx.after); if (weightNeighbors) out.push(ctx.after); }
    return out;
  }

  // 上下文同类块的"主导句末标点"：相邻块加权，至少两处且占多数才跟随。
  function dominantEnd(ctx) {
    var samples = ctxSamples(ctx, true);   // 前后邻居各算两次
    var ends = {};
    samples.forEach(function (s) {
      s = String(s == null ? "" : s).replace(/\s+$/, "");
      var m = /[。！？；：…]$/.exec(s);
      if (m) ends[m[0]] = (ends[m[0]] || 0) + 1;
    });
    var best = null, bc = 0, total = 0;
    Object.keys(ends).forEach(function (k) {
      total += ends[k];
      if (ends[k] > bc) { bc = ends[k]; best = k; }
    });
    return (bc >= 2 && bc * 2 >= total) ? best : null;
  }

  // 让段内的加粗/行内代码与上下文一致：上下文不用就去掉，避免字体粗细/字形突兀。
  function harmonizeInline(text, ctx, notes) {
    var st = inlineStats(ctxSamples(ctx, false));
    if (st.bold === 0 && /\*\*/.test(text)) {
      text = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*\*/g, "");
      notes.push("去掉加粗（与上下文一致）");
    }
    if (st.code === 0 && /`/.test(text)) {
      text = text.replace(/`([^`]+)`/g, "$1").replace(/`/g, "");
      notes.push("去掉行内代码（与上下文一致）");
    }
    return text;
  }

  // text: 待整理文字；blockType: h/p/li/quote；ctx.siblings: 相邻同类块的原文数组。
  function normalize(text, blockType, ctx) {
    var notes = [];
    var t = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    t = stripFence(t, notes);
    t = stripLeadIn(t, notes);
    t = stripOuterQuotes(t, notes);

    var lines = t.split("\n").map(function (s) {
      return s.replace(/\s+$/, "");
    }).filter(function (s) { return s.length; });

    var markers = { seen: false };
    var cleaned = lines.map(function (ln) {
      return stripBlockMarkers(ln, blockType, markers);
    }).filter(function (s) { return s.length; });
    if (markers.seen) notes.push("剥离块级标记");

    // 一个块就是一行：多行合并成单行。
    var joined = cleaned.join(" ").replace(/[ \t]+/g, " ").trim();
    if (lines.length > 1) notes.push("多行并成一段");

    if (blockType === "h") {
      var noTail = joined.replace(/[。．.，,、；;：:！!？?]+$/g, "").trim();
      if (noTail !== joined) { joined = noTail; notes.push("标题去句末标点"); }
    }

    // 让加粗/行内代码与上下文一致（字体粗细、等宽与否）。
    joined = harmonizeInline(joined, ctx, notes);

    if (blockType === "p" || blockType === "li" || blockType === "quote") {
      var dom = dominantEnd(ctx);
      if (dom && joined && !/[。！？…；：.!?]$/.test(joined)) {
        joined += dom;
        notes.push("补句末「" + dom + "」");
      }
    }

    return { text: joined, notes: notes };
  }

  window.QD_FORMAT = { normalize: normalize };
})();
