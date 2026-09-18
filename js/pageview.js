// 原版页面视图：pdf.js 把每页画成 canvas（表格、矢量图、原排版都在），
// 上面罩一层按坐标定位的透明文字（.pv-line / .pv-cell），供选区、点词和标注投影。
// 标注来源与文本流完全同一份（eng.select 的 res），靠 pdflayout 的 specs 把
// 「块内偏移」换算回「某页某行的某段字符」；块文字已被版本改写时对不上的块不投影。
(function () {
  "use strict";

  // 行角色：某页某行属于哪个块、是整行还是表格的若干格
  function buildRoles(doc, specs) {
    var roles = {};
    var ok = specs && specs.length === doc.blocks.length;
    specs.forEach(function (sp, bi) {
      var b = doc.blocks[bi];
      if (!ok || !b) return;
      var compatible = false;
      if (sp.t === "p" || sp.t === "h") {
        compatible = b.t === sp.t && b.x === sp.text && (sp.t !== "h" || b.l === sp.l);
      } else if (sp.t === "table" && b.t === "table") {
        compatible = sameCells(sp, b);
      }
      if (!compatible) return;
      if (sp.t === "table") {
        sp.rows.forEach(function (row, ri) {
          roles[row.p + ":" + row.li] = {
            kind: "cells", bi: bi, row: ri,
            cells: row.cells.map(function (c, ci) { return { x: c.x, text: c.t, col: ci }; })
          };
        });
      } else {
        sp.lines.forEach(function (L) {
          roles[L.p + ":" + L.li] = { kind: "line", bi: bi };
        });
      }
    });
    return roles;
  }

  function sameCells(sp, b) {
    var want = [];
    if (b.h && b.h.length) want.push(b.h);
    (b.r || []).forEach(function (r) { want.push(r); });
    if (want.length !== sp.rows.length) return false;
    for (var i = 0; i < want.length; i++) {
      var a = sp.rows[i].cells.map(function (c) { return c.t; });
      var z = want[i];
      if (a.length !== z.length) return false;
      for (var j = 0; j < a.length; j++) if (a[j] !== z[j]) return false;
    }
    return true;
  }

  // 把 res 里的标注换算成「页 → 行 → 若干段」
  function buildMarkPlan(doc, specs, roles, res) {
    var plan = {};
    if (!specs || specs.length !== doc.blocks.length) return plan;
    function add(p, li, entry) {
      var k = p + ":" + li;
      if (!roles[k]) return;
      (plan[k] = plan[k] || []).push(entry);
    }
    res.segs.forEach(function (seg, si) {
      var marks = res.bySeg.get(si);
      if (!marks || !marks.length) return;
      var sp = specs[seg.bi];
      if (!sp) return;
      if (sp.t === "table") {
        var row = sp.rows[seg.row];
        if (!row) return;
        marks.forEach(function (m) {
          add(row.p, row.li, { kind: "cell", col: seg.col, s: m.s, e: m.e, m: m, si: si });
        });
      } else {
        (sp.lines || []).forEach(function (L) {
          marks.forEach(function (m) {
            var a = Math.max(m.s, L.s), z = Math.min(m.e, L.e);
            if (a < z) add(L.p, L.li, { kind: "line", s: a - L.s, e: z - L.s, m: m, si: si });
          });
        });
      }
    });
    Object.keys(plan).forEach(function (k) {
      plan[k].sort(function (a, b) { return (a.s || 0) - (b.s || 0); });
    });
    return plan;
  }

  function fillWithMarks(host, text, entries, api) {
    var p = 0;
    entries.forEach(function (en) {
      if (en.s > p) host.appendChild(document.createTextNode(text.slice(p, en.s)));
      host.appendChild(api.makeMark(en.m, text.slice(en.s, en.e), en.si));
      p = en.e;
    });
    if (p < text.length) host.appendChild(document.createTextNode(text.slice(p)));
  }

  // pdf.js 的 canvas 渲染靠 requestAnimationFrame 调度；无头浏览器或后台标签里
  // rAF 不触发，渲染任务会永久挂起。先探一次，不触发就换成 setTimeout 调度。
  var rafOk = false;
  function ensureRaf() {
    if (rafOk || !window.requestAnimationFrame) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        window.requestAnimationFrame = function (cb) {
          return setTimeout(function () { cb(Date.now()); }, 16);
        };
        resolve();
      }, 600);
      window.requestAnimationFrame(function () {
        if (done) return;
        done = true;
        clearTimeout(t);
        rafOk = true;
        resolve();
      });
    });
  }

  function render(doc, host, api) {
    host.innerHTML = "";
    if (!window.pdfjsLib || !window.QD_PDFSTORE || !window.QD_PDFLAYOUT) {
      return Promise.resolve(false);
    }
    var prog = document.createElement("div");
    prog.className = "pv-progress";
    prog.textContent = "正在读取 PDF 原件…";
    host.appendChild(prog);

    return ensureRaf().then(function () {
      return window.QD_PDFSTORE.get(doc.id);
    }).then(function (bin) {
      if (!bin) return false;
      return window.pdfjsLib.getDocument({ data: new Uint8Array(bin.slice(0)) }).promise;
    }).then(function (pdf) {
      if (!pdf) return false;
      var an = doc._pdfAnalysis;
      var got = an ? Promise.resolve(an) : window.QD_PDFLAYOUT.analyze(pdf, function (n, total) {
        prog.textContent = "正在解析版面 " + n + "/" + total + " 页…";
      });
      return got.then(function (analysis) {
        doc._pdfAnalysis = analysis;
        return drawAll(pdf, analysis, doc, host, prog, api);
      });
    }).catch(function () {
      return false;
    });
  }

  function drawAll(pdf, analysis, doc, host, prog, api) {
    var specs = analysis.specs;
    var roles = buildRoles(doc, specs);
    var plan = buildMarkPlan(doc, specs, roles, api.res);
    var W = Math.max(560, Math.min(host.clientWidth || 800, 1000));
    var dpr = window.devicePixelRatio || 1;
    host.innerHTML = "";
    prog = document.createElement("div");
    prog.className = "pv-progress";
    host.appendChild(prog);

    var chain = Promise.resolve(true);
    analysis.pages.forEach(function (pg, pi) {
      chain = chain.then(function (okSoFar) {
        if (!okSoFar) return false;
        if (!api.isCurrent || !api.isCurrent()) return false;   // 切走了就别再画
        prog.textContent = "正在渲染原版页面 " + (pi + 1) + "/" + analysis.pages.length + "…";
        return pdf.getPage(pi + 1).then(function (page) {
          var vp1 = page.getViewport({ scale: 1 });
          var scale = W / vp1.width;
          var pageDiv = document.createElement("div");
          pageDiv.className = "pv-page";
          pageDiv.style.width = Math.round(vp1.width * scale) + "px";
          pageDiv.style.height = Math.round(vp1.height * scale) + "px";

          var canvas = document.createElement("canvas");
          canvas.width = Math.round(vp1.width * scale * dpr);
          canvas.height = Math.round(vp1.height * scale * dpr);
          canvas.style.width = Math.round(vp1.width * scale) + "px";
          canvas.style.height = Math.round(vp1.height * scale) + "px";
          pageDiv.appendChild(canvas);

          var overlay = document.createElement("div");
          overlay.className = "pv-text";
          buildOverlay(analysis.pages[pi], pi, roles, plan, scale, vp1.height, overlay, api);
          pageDiv.appendChild(overlay);
          host.appendChild(pageDiv);
          if (api.onPageAppended) api.onPageAppended();   // 页面高度已就位：让调用方试着落位

          return page.render({
            canvasContext: canvas.getContext("2d"),
            viewport: page.getViewport({ scale: scale * dpr })
          }).promise.then(function () { return true; });
        }).catch(function () { return true; });   // 单页画失败不整篇报废
      });
    });
    return chain.then(function (ok) {
      if (ok && prog.parentNode) prog.parentNode.removeChild(prog);
      return ok;
    });
  }

  function buildOverlay(pg, pi, roles, plan, scale, pageH, overlay, api) {
    pg.lines.forEach(function (ln, li) {
      var role = roles[pi + ":" + li];
      if (!role) return;   // 页眉页脚等没进 blocks 的行不罩字
      var entries = plan[pi + ":" + li] || [];
      var top = (pageH - ln.y - ln.fs * 0.86) * scale;
      var fs = ln.fs * scale;
      if (role.kind === "line") {
        var text = ln.text.replace(/^\s+|\s+$/g, "");
        var span = document.createElement("span");
        span.className = "pv-line";
        span.style.left = Math.round(ln.x0 * scale) + "px";
        span.style.top = Math.round(top) + "px";
        span.style.fontSize = fs.toFixed(1) + "px";
        span.dataset.bi = role.bi;
        var lineEntries = entries.filter(function (e) { return e.kind === "line"; });
        if (lineEntries.length) fillWithMarks(span, text, lineEntries, api);
        else span.textContent = text;
        overlay.appendChild(span);
      } else {
        role.cells.forEach(function (cell) {
          var td = document.createElement("span");
          td.className = "pv-cell";
          td.style.left = Math.round(cell.x * scale) + "px";
          td.style.top = Math.round(top) + "px";
          td.style.fontSize = fs.toFixed(1) + "px";
          td.dataset.bi = role.bi;
          td.dataset.row = role.row;
          td.dataset.col = cell.col;
          var cellEntries = entries.filter(function (e) { return e.kind === "cell" && e.col === cell.col; })
            .map(function (e) { return { s: e.s, e: e.e, m: e.m, si: e.si }; });
          if (cellEntries.length) fillWithMarks(td, cell.text, cellEntries, api);
          else td.textContent = cell.text;
          overlay.appendChild(td);
        });
      }
    });
  }

  window.QD_PAGEVIEW = { render: render };
})();
