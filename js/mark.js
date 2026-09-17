// 标注引擎：把「哪些写法算概念、标在哪、标几个」这件事单独放一个文件。
// 界面（app.js）只负责画，不掺匹配逻辑；想改标得多不多，先改 config.js 的 levels。
(function () {
  "use strict";

  function esc(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  var ASCIIISH = /^[A-Za-z0-9 ._+\-\/()％%]+$/;

  function escapeForm(f) {
    // 写法里的空格在原文里可能根本没有（"S 基金" 也常被写成 "S基金"），所以允许有或无。
    return esc(f).replace(/\\\s/g, "[\\s ]?");
  }

  // ── 行内 markdown 拆片段 ────────────────────────────────
  // 与 build.py 的 md_runs 一一对应。标注只作用在文本片段上，URL 与行内代码不标。
  function runs(text) {
    var out = [], re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]*\]\([^)]*\))/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), f: "" });
      var tok = m[0];
      if (tok.indexOf("**") === 0) out.push({ t: tok.slice(2, -2), f: "b" });
      else if (tok.charAt(0) === "`") out.push({ t: tok.slice(1, -1), f: "code" });
      else {
        var lm = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(tok);
        out.push({ t: lm[1], f: "link" });
        out.push({ t: " (" + lm[2] + ")", f: "url" });
      }
      last = m.index + tok.length;
    }
    if (last < text.length) out.push({ t: text.slice(last), f: "" });
    return out;
  }

  // ── 引擎 ───────────────────────────────────────────────
  function build(terms, guards, cfg) {
    var rankTier = { A: 0, B: 1, C: 2 };
    var owner = new Map();          // 小写写法 -> 词条（一个写法只归一个词条）
    var formsByEntry = new Map();   // entry.idx -> 它实际拥有的写法

    terms.forEach(function (e) {
      var tier = e.tier.charAt(0);
      formsByEntry.set(e.idx, []);
      e.forms.forEach(function (f) {
        if (!ASCIIISH.test(f) && f.length < cfg.match.minCjkLen) return;
        var k = f.toLowerCase();
        var cur = owner.get(k);
        if (!cur || rankTier[tier] < rankTier[cur.tier.charAt(0)]) {
          if (cur) {
            var back = formsByEntry.get(cur.idx);
            var at = back.indexOf(k);
            if (at >= 0) back.splice(at, 1);
          }
          owner.set(k, e);
          formsByEntry.get(e.idx).push(k);
        }
      });
    });

    // 合并成一个正则扫一遍。写法按长度降序排，长词先吃：
    // 否则「外延」会把「同质外延」拦腰截断，「量产」会抢走「规模量产」。
    var all = Array.from(owner.keys()).sort(function (a, b) { return b.length - a.length; });
    var RX = new RegExp(
      all.map(function (f) {
        var src = escapeForm(f);
        return ASCIIISH.test(f) && cfg.match.asciiBoundary
          ? "(?<![A-Za-z0-9])" + src + "(?![A-Za-z0-9])"
          : src;
      }).join("|"),
      "giu"
    );

    var GRX = {};   // 护栏正则，只在真的配了规则时才编译
    Object.keys(guards).forEach(function (k) {
      var g = guards[k];
      GRX[k.toLowerCase()] = {
        req: g.require ? new RegExp(g.require, "i") : null,
        exc: g.exclude ? new RegExp(g.exclude, "i") : null,
        ctx: g.ctx == null ? 12 : g.ctx
      };
    });

    function guardPass(form, text, a, z) {
      var g = GRX[form];
      if (!g) return true;
      var w = text.slice(Math.max(0, a - g.ctx), z + g.ctx);
      if (g.req && !g.req.test(w)) return false;
      if (g.exc && g.exc.test(w)) return false;
      return true;
    }

    // ── 把文档摊成「可标注的文本单元」────────────────────
    // 段落/标题/引文是一个单元；表格按格拆成单元（一格一句话，密度控制在格内生效）。
    function segments(doc) {
      if (doc._segs) return doc._segs;
      var segs = [];
      doc.blocks.forEach(function (b, bi) {
        if (b.t.indexOf("code") === 0) return;
        if (b.t === "table") {
          var cells = [];
          if (b.h && b.h.length) cells.push(b.h);
          (b.r || []).forEach(function (r) { cells.push(r); });
          cells.forEach(function (row, ri) {
            row.forEach(function (c, ci) {
              if (c) segs.push({ bi: bi, row: ri, col: ci, text: c, head: ri === 0 && !!b.h });
            });
          });
        } else if (b.x) {
          segs.push({ bi: bi, text: b.x });
        }
      });
      doc._segs = segs;
      return segs;
    }

    // ── 一篇文档扫一遍 ───────────────────────────────────
    // 结果缓存：换密度档位时只重跑「选谁标」，不重跑正则。
    function scan(doc) {
      if (doc._scan) return doc._scan;
      var segs = segments(doc);
      var raw = [];            // {si, s, e, form, idx}
      var byEntry = new Map(); // idx -> [hit]
      segs.forEach(function (seg, si) {
        var pos = 0;
        runs(seg.text).forEach(function (r) {
          if (r.f === "url" || r.f === "code") { pos += r.t.length; return; }
          RX.lastIndex = 0;
          var m;
          while ((m = RX.exec(r.t))) {
            var form = m[0].toLowerCase();
            var e = owner.get(form);
            if (!e) continue;
            var hit = { si: si, s: pos + m.index, e: pos + m.index + m[0].length, form: form, idx: e.idx };
            if (!guardPass(form, r.t, m.index, m.index + m[0].length)) {
              hit.blocked = true;
            }
            raw.push(hit);
            if (!hit.blocked) {
              if (!byEntry.has(e.idx)) byEntry.set(e.idx, []);
              byEntry.get(e.idx).push(hit);
            }
          }
          pos += r.t.length;
        });
      });
      doc._scan = { segs: segs, byEntry: byEntry, blockedHits: raw.filter(function (h) { return h.blocked; }) };
      return doc._scan;
    }

    function priority(e, n) {
      var w = cfg.rank;
      return (e.star || 0) * w.starW + (e.must ? w.mustW : 0) +
             w.tierW[e.tier.charAt(0)] + n * w.countW +
             Math.max.apply(null, e.forms.map(function (f) { return f.length; })) * w.lenW;
    }

    // ── 按档位挑出要标的 ─────────────────────────────────
    // 三层上限的生效顺序：先按 allowTiers / starOnly 取消资格，再限每词次数，
    // 再限每段个数，最后按全局密度兜底从后往前删。
    function select(doc, levelKey) {
      var lv = cfg.levels[levelKey];
      var sc = scan(doc);
      var keep = [];
      var total = 0;

      sc.byEntry.forEach(function (hits, idx) {
        var e = terms[idx];
        if (!e) return;
        var tier = e.tier.charAt(0);
        if (lv.allowTiers.indexOf(tier) < 0) return;
        if (lv.starOnly && !(e.star >= 1 || e.must)) return;
        // 名额按「写法」分：合并行（原厂·颗粒·模组·主控）只按词条分名额的话，
        // 三个名额会被最先出现的写法全吃掉，同一行的其它词一次都标不上。
        var byForm = new Map();
        hits.forEach(function (h) {
          var arr = byForm.get(h.form) || [];
          byForm.set(h.form, arr);
          if (arr.length < lv.perTermCap) {
            arr.push(h);
            keep.push({ hit: h, e: e, n: hits.length, pr: priority(e, hits.length) });
          }
        });
        total += hits.length;
      });

      // 每个文本单元内部只留优先级最高的几个；同优先级时留靠前的，读起来才连续。
      var perSeg = new Map();
      keep.sort(function (a, b) { return a.hit.si - b.hit.si || b.pr - a.pr || a.hit.s - b.hit.s; });
      keep.forEach(function (k) {
        var arr = perSeg.get(k.hit.si) || [];
        if (arr.length >= lv.perSegCap) return;
        arr.push(k);
        perSeg.set(k.hit.si, arr);
      });

      // 全局兜底：每 1000 字不超过 perMilleCap 个。按优先级从低往高撤，先撤 C、再撤非 ★。
      var budget = Math.max(3, Math.round(doc.nchars / 1000 * lv.perMilleCap));
      var chosen = [];
      perSeg.forEach(function (arr) { arr.forEach(function (k) { chosen.push(k); }); });
      if (chosen.length > budget) {
        chosen.sort(function (a, b) { return b.pr - a.pr; });
        chosen = chosen.slice(0, budget);
      }

      var bySeg = new Map();
      chosen.forEach(function (k) {
        var arr = bySeg.get(k.hit.si) || [];
        arr.push(k.hit);
        bySeg.set(k.hit.si, arr);
      });
      bySeg.forEach(function (arr) { arr.sort(function (a, b) { return a.s - b.s; }); });

      return { segs: sc.segs, bySeg: bySeg, byEntry: sc.byEntry, marked: chosen.length, pool: total };
    }

    return { owner: owner, segments: segments, scan: scan, select: select, priority: priority };
  }

  window.QD_MARK = { build: build, runs: runs, esc: esc };
})();
