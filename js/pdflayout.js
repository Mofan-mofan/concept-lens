// 版面感知解析：把 pdf.js 抽出的带坐标文本项还原成「行 → 标题/表格/段落」，
// 产出两样东西：① 干净的 markdown 源码（走原有 parseMarkdown 成 blocks）；
// ② 与 blocks 逐条对齐的 specs（每个块由哪些页哪些行的哪段字符组成），
//    供 pageview.js 的覆盖层把标注投影回原版页面。
// 坐标约定：pdf.js 的 transform[4]/[5] 是 PDF 坐标（y 向上），transform[2]/[3] 含字号。
(function () {
  "use strict";

  var ZWSP = String.fromCharCode(0x200b);   // 零宽空格：挡住 markdown 特殊首字符，视觉上不可见

  function isCjk(ch) {
    var c = (ch || "").charCodeAt(0);
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef);
  }

  // ── 第一遍：逐页把文本项聚成行 ─────────────────────────
  // 行内按 x 排序；小缝隙不插空格（PDF 常把一个词拆成多个 run），
  // 大缝隙插一个空格并作为「列切分」的依据（chunks）。
  function extractPages(pdf, onProgress) {
    var total = pdf.numPages;
    var pages = [];
    var n = 0;
    function step(num) {
      if (num > total) return Promise.resolve(pages);
      return pdf.getPage(num).then(function (page) {
        return page.getTextContent().then(function (content) {
          var vp = page.getViewport({ scale: 1 });
          pages.push(buildPage(num, vp, content));
          n += 1;
          if (onProgress) onProgress(n, total);
          return step(num + 1);
        });
      }).catch(function () { return step(num + 1); });
    }
    return step(1);
  }

  function buildPage(no, vp, content) {
    var raw = [];
    (content.items || []).forEach(function (it) {
      if (typeof it.str !== "string" || !it.str.trim()) return;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var fs = Math.hypot(tr[2], tr[3]) || it.height || 10;
      raw.push({ x: tr[4], y: tr[5], fs: fs, w: it.width || 0, str: it.str });
    });
    raw.sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });

    var lines = [];
    raw.forEach(function (it) {
      var line = lines[lines.length - 1];
      if (line && Math.abs(it.y - line.y) <= Math.max(1.5, line.fs * 0.45)) {
        line.items.push(it);
        line.fs = Math.max(line.fs, it.fs);
      } else {
        lines.push({ y: it.y, fs: it.fs, items: [it] });
      }
    });

    lines.forEach(function (line) {
      line.items.sort(function (a, b) { return a.x - b.x; });
      var text = "";
      line.items.forEach(function (it, i) {
        if (i > 0) {
          var gap = it.x - (line.items[i - 1].x + line.items[i - 1].w);
          if (gap > line.fs * 0.22) text += " ";
        }
        it.off = text.length;
        text += it.str;
      });
      line.text = text;
      line.trim = text.length - text.replace(/^\s+/, "").length;   // 行首空白宽，覆盖层定位用
      line.x0 = line.items[0].x;
      line.x1 = line.items[line.items.length - 1].x + line.items[line.items.length - 1].w;
      // 列切分：缝隙超过一个字宽才算换列（表格靠这个认出列边界）
      var chunks = [];
      var start = 0;
      for (var i = 1; i <= line.items.length; i++) {
        var big = i < line.items.length &&
          (line.items[i].x - (line.items[i - 1].x + line.items[i - 1].w)) > Math.max(line.fs * 1.1, 6);
        if (big || i === line.items.length) {
          var first = line.items[start], last = line.items[i - 1];
          chunks.push({
            x: first.x,
            s: first.off,
            e: last.off + last.str.length,
            text: text.slice(first.off, last.off + last.str.length)
          });
          start = i;
        }
      }
      line.chunks = chunks;
    });

    return { no: no, w: vp.width, h: vp.height, lines: lines };
  }

  function analyze(pdf, onProgress) {
    return extractPages(pdf, onProgress).then(function (pages) {
      return layoutToMarkdown(pages);
    });
  }

  // ── 第二遍：全篇统计 + 分类 ────────────────────────────
  function layoutToMarkdown(pages) {
    var all = [];
    pages.forEach(function (p, pi) {
      p.lines.forEach(function (ln, li) { all.push({ p: pi, li: li, ln: ln }); });
    });
    if (!all.length) return { markdown: "", specs: [], pages: pages };

    // 正文字号：按文本长度加权的众数
    var hist = {};
    all.forEach(function (r) {
      var k = Math.round(r.ln.fs * 2) / 2;
      hist[k] = (hist[k] || 0) + r.ln.text.length;
    });
    var bodyFs = 10, best = -1;
    Object.keys(hist).forEach(function (k) {
      if (hist[k] > best) { best = hist[k]; bodyFs = +k; }
    });

    // 页眉页脚：页码行 + 跨页重复行（出现于一半以上页面的短行）
    var seen = {};
    all.forEach(function (r) {
      var t = r.ln.text.replace(/\s/g, "");
      if (!t || t.length > 40) return;
      seen[t] = (seen[t] || 0) + 1;
    });
    var repeatMin = Math.max(3, Math.ceil(pages.length * 0.5));
    function isFurniture(r) {
      var ln = r.ln, t = ln.text.replace(/^\s+|\s+$/g, "");
      var edge = ln.y > pages[r.p].h * 0.93 || ln.y < pages[r.p].h * 0.07;
      if (/^-\s*\d{1,4}\s*-$/.test(t)) return true;
      if (/^第?\s*\d{1,4}\s*页/.test(t) && t.length <= 12) return true;
      if (/^\d{1,4}\s*[/／]\s*\d{1,4}$/.test(t)) return true;
      if (edge && /^\d{1,4}$/.test(t)) return true;
      if ((seen[t.replace(/\s/g, "")] || 0) >= repeatMin) return true;
      return false;
    }

    // 左右边距：正文行 x0 的众数、x1 的 90 分位
    var x0s = {}, x1s = [];
    all.forEach(function (r) {
      if (isFurniture(r)) return;
      var k = Math.round(r.ln.x0 / 2) * 2;
      x0s[k] = (x0s[k] || 0) + 1;
      x1s.push(r.ln.x1);
    });
    var marginX = 0, mb = -1;
    Object.keys(x0s).forEach(function (k) { if (x0s[k] > mb) { mb = x0s[k]; marginX = +k; } });
    x1s.sort(function (a, b) { return a - b; });
    var rightX = x1s.length ? x1s[Math.floor(x1s.length * 0.9)] : 0;

    // 标题：字号明显大于正文的短行；不同字号排序定级别
    var headSizes = {};
    all.forEach(function (r) {
      var ln = r.ln;
      if (isFurniture(r)) return;
      if (ln.fs >= bodyFs * 1.12 && ln.text.replace(/\s/g, "").length <= 50 && ln.chunks.length === 1) {
        headSizes[Math.round(ln.fs * 2) / 2] = true;
      }
    });
    var sizeRank = {};
    Object.keys(headSizes).sort(function (a, b) { return b - a; })
      .forEach(function (k, i) { sizeRank[k] = Math.min(i + 1, 4); });
    function headLevel(ln) {
      return sizeRank[Math.round(ln.fs * 2) / 2] || 0;
    }

    // 表格：连续 >=2 行都是「多列行」，且列数稳定、列 x 对得齐
    function isColLine(ln) {
      return ln.chunks.length >= 2 && ln.text.replace(/\s/g, "").length <= 220;
    }
    function tryTable(rows) {
      if (rows.length < 2) return null;
      var counts = {};
      rows.forEach(function (r) { counts[r.ln.chunks.length] = (counts[r.ln.chunks.length] || 0) + 1; });
      var K = 0, cb = -1;
      Object.keys(counts).forEach(function (k) { if (counts[k] > cb) { cb = counts[k]; K = +k; } });
      if (K < 2 || cb < rows.length * 0.6) return null;
      var xs = [];
      rows.forEach(function (r) { r.ln.chunks.forEach(function (c) { xs.push(c.x); }); });
      xs.sort(function (a, b) { return a - b; });
      var cols = [xs[0]];
      var tol = Math.max(bodyFs * 1.6, 10);
      xs.forEach(function (x) { if (x - cols[cols.length - 1] > tol) cols.push(x); });
      if (cols.length < 2) return null;
      var grid = rows.map(function () { return cols.map(function () { return { t: "", x: null }; }); });
      rows.forEach(function (r, ri) {
        r.ln.chunks.forEach(function (c) {
          var ci = 0, bd = 1e9;
          cols.forEach(function (cx, i) {
            var d = Math.abs(c.x - cx);
            if (d < bd) { bd = d; ci = i; }
          });
          var cell = grid[ri][ci];
          if (cell.x == null) cell.x = c.x;
          cell.t = cell.t ? cell.t + " " + c.text : c.text;
        });
      });
      var keep = [];
      cols.forEach(function (c, ci) {
        if (grid.some(function (row) { return row[ci].t.replace(/\s/g, ""); })) keep.push(ci);
      });
      if (keep.length < 2) return null;
      return {
        rows: grid.map(function (row, ri) {
          return {
            p: rows[ri].p, li: rows[ri].li,
            cells: keep.map(function (ci) { return { t: row[ci].t, x: row[ci].x == null ? cols[ci] : row[ci].x }; })
          };
        })
      };
    }

    // 图表标签簇：连续 >=3 行超短文字（坐标轴、柱顶数值）加紧随的短图例行，
  // 是矢量图里的文字碎块，进正文只会变成碎段落；原版页面视图里图本身还在。
  function dropChartLabels(rows) {
    function len(r) { return r.ln.text.replace(/\s/g, "").length; }
    var drop = {};
    var i = 0;
    while (i < rows.length) {
      var j = i;
      while (j < rows.length && rows[j].p === rows[i].p && len(rows[j]) <= 8) j++;
      if (j - i >= 3) {
        for (var k = i; k < j; k++) drop[k] = true;
        var extra = 0;
        while (extra < 2 && j < rows.length && rows[j].p === rows[i].p && len(rows[j]) <= 24) {
          drop[j] = true; j++; extra++;
        }
      }
      i = j > i ? j : i + 1;
    }
    return rows.filter(function (r, idx) { return !drop[idx]; });
  }

  function cleanCell(s) {
      return String(s).replace(/\*+/g, "").replace(/\|/g, "/").replace(/^\s+|\s+$/g, "");
    }

    // ── 顺序回放：标题 / 表格 / 段落 ─────────────────────
    var specs = [];
    var md = [];
    var para = null;   // { joins:[], lines:[{p,li,raw,s,e}], last }

    function flushPara() {
      if (!para || !para.lines.length) { para = null; return; }
      var guard = /^([|#>]|`{3}|[-*+]\s|\d+[.、]\s)/.test(para.lines[0].raw) ? ZWSP : "";
      var text = guard;
      para.lines.forEach(function (L, i) {
        if (i > 0) text += para.joins[i - 1];
        L.s = text.length;
        text += L.raw;
        L.e = text.length;
      });
      md.push(text);
      specs.push({ t: "p", text: text, lines: para.lines });
      para = null;
    }

    function pushParaLine(r) {
      var ln = r.ln;
      var text = ln.text.replace(/^\s+|\s+$/g, "");
      if (!text) return;
      var newline = !para;
      if (para) {
        var prev = para.last;
        var gap = prev.y - ln.y;
        var prevShort = prev.x1 < rightX - bodyFs * 1.5;
        var indent = ln.x0 > marginX + bodyFs * 0.7;
        if (prevShort || indent || gap > pitch * 1.35) newline = true;
      }
      if (newline) flushPara();
      if (!para) para = { joins: [], lines: [], last: null };
      if (para.lines.length) {
        var pc = para.last.text.charAt(para.last.text.length - 1);
        para.joins.push(isCjk(pc) && isCjk(text.charAt(0)) ? "" : " ");
      }
      para.lines.push({ p: r.p, li: r.li, raw: text });
      para.last = { y: ln.y, x1: ln.x1, text: text };
    }

    var body = all.filter(function (r) { return !isFurniture(r); });
    body = dropChartLabels(body);

    // 行距中位数：段落内行间隔就是它，明显大于它才算段间空行
    // （不能用字号倍数硬判：行高 1.9 倍的 PDF 每行间隔都超过 1.55 倍字号）。
    var deltas = [];
    for (var d = 1; d < body.length; d++) {
      if (body[d].p !== body[d - 1].p) continue;
      var dl = body[d - 1].ln.y - body[d].ln.y;
      if (dl > 0) deltas.push(dl);
    }
    deltas.sort(function (a, b) { return a - b; });
    var pitch = deltas.length ? deltas[Math.floor(deltas.length / 2)] : bodyFs * 1.4;

    var i = 0;
    while (i < body.length) {
      var r = body[i];
      var lv = headLevel(r.ln);
      if (lv) {
        flushPara();
        var ht = r.ln.text.replace(/\*+/g, "").replace(/^\s+|\s+$/g, "");
        md.push("#".repeat(lv) + " " + ht);
        specs.push({ t: "h", l: lv, text: ht, lines: [{ p: r.p, li: r.li, s: 0, e: ht.length, raw: ht }] });
        i += 1;
        continue;
      }
      if (isColLine(r.ln)) {
        var run = [];
        while (i < body.length && !headLevel(body[i].ln) && isColLine(body[i].ln)) {
          run.push(body[i]); i += 1;
        }
        var tb = tryTable(run);
        if (tb) {
          flushPara();
          var rowSpecs = tb.rows.map(function (row) {
            return {
              p: row.p, li: row.li,
              cells: row.cells.map(function (c) { return { t: cleanCell(c.t), x: c.x }; })
            };
          });
          var rowMd = rowSpecs.map(function (row) {
            return "| " + row.cells.map(function (c) { return c.t; }).join(" | ") + " |";
          });
          var k = rowSpecs[0].cells.length;
          rowMd.splice(1, 0, "| " + new Array(k + 1).join("--- | ").replace(/\s+$/, "") + " |");
          md.push(rowMd.join("\n"));
          specs.push({ t: "table", rows: rowSpecs });
          continue;
        }
        run.forEach(pushParaLine);   // 列数对不齐，按普通段落行处理
        continue;
      }
      pushParaLine(r);
      i += 1;
    }
    flushPara();

    return { markdown: md.join("\n\n"), specs: specs, pages: pages };
  }

  window.QD_PDFLAYOUT = { analyze: analyze, extractPages: extractPages, layoutToMarkdown: layoutToMarkdown };
})();
