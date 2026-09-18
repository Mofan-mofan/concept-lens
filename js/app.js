// 界面层：状态、渲染、点击。匹配与密度决策都在 mark.js，检索在 search.js。
(function () {
  "use strict";

  var CFG = window.QD_CONFIG, GUARDS = window.QD_GUARDS;
  // 词条两份：本机那份含指向私有笔记的定位字段（不随仓库发布），
  // Pages 或新克隆上拿不到它，就回退到公开的 terms.public.js。
  var TERMS = (window.QD_TERMS && window.QD_TERMS.length)
    ? window.QD_TERMS : (window.QD_TERMS_PUBLIC || []);
  // 私有语料只在本机（含文稿全文，不随仓库发布）；Pages 或新克隆上回退到仓库自带的示例语料
  var DOCS = (window.QD_DOCS && window.QD_DOCS.length) ? window.QD_DOCS : (window.QD_DOCS_SAMPLE || []);
  var eng = window.QD_MARK.build(TERMS, GUARDS, CFG);
  var byIdx = [];
  TERMS.forEach(function (t) { byIdx[t.idx] = t; });

  // ── localStorage 薄封装：隐私模式写失败就静默降级，不影响阅读 ──
  function lsGet(k, dflt) {
    try {
      var v = localStorage.getItem(k);
      return v == null ? dflt : JSON.parse(v);
    } catch (e) { return dflt; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  var S = { doc: DOCS[0], level: CFG.defaultLevel, sel: null, q: "", sideTier: "",
    viewBy: lsGet("qd.viewBy", {}), pendingScroll: null, booted: false };

  // ── 阅读位置记忆：按「文档id:视图」存 window 滚动偏移，切文档/换视图/刷新后恢复 ──
  var SCROLL_CAP = 200;   // 最多记 200 个位置，超了丢最早的，防 localStorage 长毛
  function scrollKeyOf(doc, view) { return doc.id + ":" + view; }
  function saveScroll() {
    var d = S.doc;
    if (!S.booted || !d || d.id == null) return;
    var map = lsGet("qd.scroll", {});
    map[scrollKeyOf(d, viewOf(d))] = Math.round(window.scrollY ||
      document.documentElement.scrollTop || 0);
    var keys = Object.keys(map);
    if (keys.length > SCROLL_CAP) {
      keys.slice(0, keys.length - SCROLL_CAP).forEach(function (k) { delete map[k]; });
    }
    lsSet("qd.scroll", map);
  }
  function readScroll(doc, view) {
    if (!doc || doc.id == null) return null;
    var y = lsGet("qd.scroll", {})[scrollKeyOf(doc, view)];
    return typeof y === "number" ? y : null;
  }
  // 渲染是逐步长高的（原版页面逐页追加），高度不够时先不跳，等下一页追加后再试；
  // force 用于文本流这类同步渲染完的场景，或被钳住也直接落位。
  function tryRestoreScroll(force) {
    var y = S.pendingScroll;
    if (y == null) return;
    if (!force && document.documentElement.scrollHeight < y + window.innerHeight) return;
    S.pendingScroll = null;
    window.scrollTo(0, y);
  }
  var modalMask = null;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function tierOf(e) { return e.tier.charAt(0); }
  function sub(e) { return CFG.subtier[e.tier] || ""; }

  function uniq(v, i, a) { return a.indexOf(v) === i; }

  // ── 每篇文档的实时计数（不用 build 期的 count，两者口径不同，混着显示会自相矛盾）
  function ensureCounted(doc) {
    if (doc._n) return doc;
    var sc = eng.scan(doc);
    doc._n = {};
    sc.byEntry.forEach(function (hits, idx) { doc._n[idx] = hits.length; });
    return doc;
  }

  function badge(e, cls) {
    var t = tierOf(e);
    var b = el("span", "tier tier-" + t + (cls || ""), CFG.tier[t].label);
    b.title = e.tier + " · " + sub(e) + " — " + CFG.tier[t].hint;
    return b;
  }

  // ── 正文渲染 ───────────────────────────────────────────
  function renderSeg(target, text, marks, segId) {
    var i = 0, off = 0;
    var parts = text ? window.QD_MARK.runs(text) : [];
    marks = marks || [];
    parts.forEach(function (r) {
      var base = off;
      off += r.t.length;
      if (r.f === "url" || r.f === "code") {
        var s = el("span", r.f === "url" ? "url" : "icode", r.t);
        target.appendChild(s);
        return;
      }
      var wrap = r.f === "b" ? el("strong") : (r.f === "link" ? el("span", "linktext") : null);
      var host = wrap || target;
      var p = 0;
      while (i < marks.length && marks[i].s < base) i++;
      for (; i < marks.length && marks[i].e <= base + r.t.length; i++) {
        var m = marks[i];
        if (m.s < base || m.e > base + r.t.length) continue;   // 跨片段的写法不标
        var a = m.s - base, z = m.e - base;                     // 绝对偏移 → 片段内偏移
        if (a > p) host.appendChild(document.createTextNode(r.t.slice(p, a)));
        host.appendChild(makeMark(m, r.t.slice(a, z), segId));
        p = z;
      }
      if (p < r.t.length) host.appendChild(document.createTextNode(r.t.slice(p)));
      if (wrap) target.appendChild(wrap);
    });
  }

  function makeMark(m, txt, segId) {
    var e = byIdx[m.idx];
    var t = tierOf(e);
    var a = el("span", "mk mk-" + t + (e.star >= 2 ? " mk-2star" : ""), txt);
    a.dataset.idx = m.idx;
    a.dataset.seg = segId;
    a.dataset.n = doc_n(m.idx, txt);
    a.title = txt + "｜" + CFG.tier[t].label + " " + e.tier + "｜" + e.gloss.slice(0, 46);
    a.addEventListener("click", function (ev) {
      ev.stopPropagation();
      // 再点同一个词（任意一处出现）→ 收起整栏；点别的词照常切换内容
      var box = document.getElementById("detail");
      if (S.sel === e.idx && box && !box.classList.contains("hide")) {
        closeTerm();
        return;
      }
      openTerm(e.idx, { fromSeg: segId, s: m.s, form: txt });
    });
    return a;
  }
  function doc_n(idx, form) {
    var d = S.doc;
    var all = (d._n && d._n[idx]) || 0;
    if (!form || !d._scan) return all;
    var hits = d._scan.byEntry.get(idx);
    if (!hits) return all;
    var k = form.toLowerCase(), n = 0;
    for (var i = 0; i < hits.length; i++) if (hits[i].form === k) n++;
    return n;
  }

  // ── 版本管理 UI：待应用标记、历史弹层、导出/提交 ─────────
  function decorateStaged(node, bi, stagedMap) {
    if (!stagedMap || stagedMap[String(bi)] == null) return;
    node.classList.add("staged-block");
    node.classList.add("has-stage-preview");
    node.dataset.stageMark = CFG.version.stagedMark;

    // 在正文里就地显示待应用的新文字，且可直接编辑；原正文压暗保留，点「生成新版本」才真正替换。
    var newText = String(stagedMap[String(bi)]);
    var preview = el("div", "stage-preview");
    preview.appendChild(el("div", "stage-preview-tag", CFG.version.pendingNewTag));
    var ta = document.createElement("textarea");
    ta.className = "stage-preview-edit";
    ta.value = newText;
    ta.rows = Math.max(6, Math.min(18, Math.ceil(newText.length / 30)));
    ta.addEventListener("input", function () {
      if (S.doc && window.QD_VERSION) window.QD_VERSION.stage(S.doc.id, bi, ta.value);
    });
    preview.appendChild(ta);
    preview.appendChild(el("div", "stage-preview-hint", CFG.version.pendingEditHint));
    node.insertBefore(preview, node.firstChild);

    var ops = el("div", "stage-ops");
    var view = el("button", "stage-btn", CFG.version.viewChange);
    view.type = "button";
    view.addEventListener("click", function (ev) {
      ev.stopPropagation();
      showStageDiff(bi);
    });
    var undo = el("button", "stage-btn stage-undo", CFG.version.undoChange);
    undo.type = "button";
    undo.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (!S.doc || !window.QD_VERSION) return;
      window.QD_VERSION.unstage(S.doc.id, bi);
      renderDoc();
    });
    ops.appendChild(view);
    ops.appendChild(undo);
    node.appendChild(ops);
  }

  // 表格单元格级：只在那一格里就地显示待应用文字（可编辑），原格内容压暗保留。
  // 键为 "bi:row:col"（row=0 表头，row>=1 正文行），与 version.js commit 的解析一致。
  function decorateStagedCell(td, bi, row, col, stagedMap) {
    if (!stagedMap) return;
    var key = bi + ":" + row + ":" + col;
    if (stagedMap[key] == null) return;
    td.classList.add("staged-cell");
    td.classList.add("has-stage-preview");

    var newText = String(stagedMap[key]);
    var preview = el("div", "stage-preview cell");
    preview.appendChild(el("div", "stage-preview-tag", CFG.version.stagedMark));
    var ta = document.createElement("textarea");
    ta.className = "stage-preview-edit cell";
    ta.value = newText;
    ta.rows = Math.max(2, Math.min(8, Math.ceil(newText.length / 20)));
    ta.addEventListener("input", function () {
      if (S.doc && window.QD_VERSION) window.QD_VERSION.stage(S.doc.id, key, ta.value);
    });
    preview.appendChild(ta);

    var ops = el("div", "stage-ops cell");
    var view = el("button", "stage-btn", CFG.version.viewChange);
    view.type = "button";
    view.addEventListener("click", function (ev) { ev.stopPropagation(); showCellDiff(bi, row, col); });
    var undo = el("button", "stage-btn stage-undo", CFG.version.undoChange);
    undo.type = "button";
    undo.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (!S.doc || !window.QD_VERSION) return;
      window.QD_VERSION.unstage(S.doc.id, key);
      renderDoc();
    });
    ops.appendChild(view);
    ops.appendChild(undo);
    preview.appendChild(ops);
    td.insertBefore(preview, td.firstChild);
  }

  function blockPlainText(b) {
    if (!b) return "";
    if (b.x != null) return String(b.x);
    if (b.t === "table") {
      var cells = [];
      if (b.h && b.h.length) cells = cells.concat(b.h);
      (b.r || []).forEach(function (r) { cells = cells.concat(r); });
      return cells.join(" | ");
    }
    return "";
  }

  function showDiff(oldText, newText) {
    var body = el("div", "diff-body");
    var oldPane = el("div", "diff-pane");
    oldPane.appendChild(el("div", "diff-label", CFG.version.diffOld));
    oldPane.appendChild(el("pre", "diff-text", oldText));
    body.appendChild(oldPane);
    var newPane = el("div", "diff-pane");
    newPane.appendChild(el("div", "diff-label", CFG.version.diffNew));
    newPane.appendChild(el("pre", "diff-text", newText));
    body.appendChild(newPane);
    showModal(CFG.version.diffTitle, body);
  }

  function showStageDiff(bi) {
    if (!S.doc || !window.QD_VERSION) return;
    var map = window.QD_VERSION.staged(S.doc.id);
    var oldText = blockPlainText(S.doc.blocks[bi]);
    var newText = String(map[String(bi)] == null ? "" : map[String(bi)]);
    showDiff(oldText, newText);
  }

  // 单元格级改动对比：row=0 表头，row>=1 正文行。
  function cellText(b, row, col) {
    if (!b || b.t !== "table") return "";
    if (row === 0) return (b.h && b.h[col] != null) ? String(b.h[col]) : "";
    var r = b.r && b.r[row - 1];
    return (r && r[col] != null) ? String(r[col]) : "";
  }

  function showCellDiff(bi, row, col) {
    if (!S.doc || !window.QD_VERSION) return;
    var map = window.QD_VERSION.staged(S.doc.id);
    var key = bi + ":" + row + ":" + col;
    var oldText = cellText(S.doc.blocks[bi], row, col);
    var newText = String(map[key] == null ? "" : map[key]);
    showDiff(oldText, newText);
  }

  function closeModal() {
    if (modalMask && modalMask.parentNode) modalMask.parentNode.removeChild(modalMask);
    modalMask = null;
  }

  function showModal(title, body) {
    closeModal();
    var mask = el("div", "modal-mask");
    var box = el("div", "modal-box");
    var head = el("div", "modal-head");
    head.appendChild(el("div", "modal-title", title));
    var x = el("button", "modal-close", CFG.version.close);
    x.type = "button";
    x.addEventListener("click", closeModal);
    head.appendChild(x);
    box.appendChild(head);

    var bd = el("div", "modal-body");
    bd.appendChild(body);
    box.appendChild(bd);
    mask.appendChild(box);
    mask.addEventListener("click", function (ev) {
      if (ev.target === mask) closeModal();
    });
    document.body.appendChild(mask);
    modalMask = mask;
  }

  function openHistory() {
    if (!S.doc || !window.QD_VERSION) return;
    var list = window.QD_VERSION.list(S.doc.id);
    if (!list.length) {
      window.alert(CFG.version.noVersions);
      return;
    }

    var body = el("div", "version-list");
    list.forEach(function (v) {
      var row = el("div", "version-row");
      var info = el("div", "version-info");
      info.appendChild(el("div", "version-title", v.ver === 1 ? CFG.version.original : "v" + v.ver));
      info.appendChild(el("div", "version-meta",
        new Date(v.ts).toLocaleString() + " · " + v.nchars + " 字 · " + v.blockCount + " 块"));
      row.appendChild(info);

      var btn = el("button", "btn", CFG.version.restore);
      btn.type = "button";
      btn.addEventListener("click", function () {
        closeModal();
        if (window.QD_VERSION.restore(S.doc.id, v.ver)) {
          renderDoc();
          window.alert(CFG.version.restoreOk.replace("{ver}", v.ver));
        }
      });
      row.appendChild(btn);
      body.appendChild(row);
    });
    showModal(CFG.version.historyTitle, body);
  }

  function renderVersionBar() {
    var bar = document.getElementById("versionbar");
    if (!bar) return;
    bar.innerHTML = "";
    if (!S.doc || !window.QD_VERSION) return;

    var map = window.QD_VERSION.staged(S.doc.id);
    var count = Object.keys(map).length;
    var list = window.QD_VERSION.list(S.doc.id);
    var ver = list.length ? list[list.length - 1].ver : 1;

    var status = el("span", "vstatus",
      CFG.version.currentVersion.replace("{ver}", ver) + " · " +
      CFG.version.bufferCount.replace("{n}", count));
    bar.appendChild(status);

    [
      [CFG.version.generate, CFG.version.generateTitle, commitCurrent],
      [CFG.version.history, CFG.version.historyTitle, openHistory],
      [CFG.version.export, CFG.version.exportTitle, exportCurrentMarkdown],
      [CFG.version.clearBuffer, CFG.version.clearBufferTitle, clearCurrentBuffer]
    ].forEach(function (p) {
      var b = el("button", "vbtn", p[0]);
      b.type = "button";
      b.title = p[1];
      b.addEventListener("click", p[2]);
      bar.appendChild(b);
    });
  }

  // 取目标块的同类型前后邻居与全部同类块，供提交时自动匹配格式/字体。
  function blockContext(doc, bi) {
    var b = doc.blocks[bi];
    var type = b ? b.t : "p";
    var siblings = [];
    (doc.blocks || []).forEach(function (bb, i) {
      if (i !== bi && bb.t === type && bb.x != null && String(bb.x)) siblings.push(String(bb.x));
    });
    var prev = doc.blocks[bi - 1], next = doc.blocks[bi + 1];
    return {
      siblings: siblings,
      before: (prev && prev.t === type && prev.x != null) ? String(prev.x) : "",
      after: (next && next.t === type && next.x != null) ? String(next.x) : ""
    };
  }

  // 提交前：把缓冲区里每处待应用文字按上下文自动规整（格式 + 字体），写回缓冲。
  function normalizeAllStaged(doc) {
    if (!window.QD_FORMAT || typeof window.QD_FORMAT.normalize !== "function") return;
    var map = window.QD_VERSION.staged(doc.id);
    Object.keys(map).forEach(function (k) {
      // 单元格键 "bi:row:col"：轻量规整（剥围栏/引导语/外层引号、并多行、去 markdown），
      // 不猜句末标点、不按邻居改字体——表格格本就是纯文本。
      if (String(k).split(":").length === 3) {
        var rc = window.QD_FORMAT.normalize(map[k], "p", { siblings: [], before: "", after: "" });
        if (rc.text !== map[k]) window.QD_VERSION.stage(doc.id, k, rc.text);
        return;
      }
      var bi = Number(k);
      var b = doc.blocks[bi];
      if (!b) return;
      if (b.t === "table" || b.t === "code" || b.t === "code_open" || b.t === "code_close") return;
      var res = window.QD_FORMAT.normalize(map[k], b.t, blockContext(doc, bi));
      if (res.text !== map[k]) window.QD_VERSION.stage(doc.id, bi, res.text);
    });
  }

  function commitCurrent() {
    if (!S.doc || !window.QD_VERSION) return;
    var doc = S.doc;
    normalizeAllStaged(doc);
    var ver = window.QD_VERSION.commit(doc.id);
    var report = window.QD_VERSION.lastCommitReport();
    if (ver == null) {
      if (report && report.skipped && report.skipped.length) {
        window.alert(CFG.version.allSkipped);
      } else {
        window.alert(CFG.version.emptyCommit);
      }
      return;
    }

    if (report && report.skipped && report.skipped.length) {
      window.alert(CFG.version.commitSkipped.replace("{ver}", ver).replace("{n}", report.skipped.length));
    } else {
      window.alert(CFG.version.commitOk.replace("{ver}", ver));
    }
    renderDoc();
  }

  function clearCurrentBuffer() {
    if (!S.doc || !window.QD_VERSION) return;
    if (!window.confirm(CFG.version.confirmClear)) return;
    window.QD_VERSION.clear(S.doc.id);
    renderDoc();
  }

  function exportCurrentMarkdown() {
    if (!S.doc || !window.QD_VERSION) return;
    var text = window.QD_VERSION.exportMarkdown(S.doc);
    if (!text) {
      window.alert(CFG.version.exportEmpty);
      return;
    }
    var list = window.QD_VERSION.list(S.doc.id);
    var ver = list.length ? list[list.length - 1].ver : 1;
    var safeName = String(S.doc.name || "文档").replace(/[\\/:*?"<>|]+/g, "_");
    var filename = safeName + ".v" + ver + ".md";
    var blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 0);
  }

  // PDF 文档的视图偏好：默认原版页面，其它文档只有文本流。
  function viewOf(doc) {
    if (!doc) return "text";
    return S.viewBy[doc.id] || (doc.kind === "pdf" ? "page" : "text");
  }

  function addViewToggle(head, doc) {
    if (!doc || doc.kind !== "pdf") return;
    var bar = el("div", "viewtoggle");
    [["page", "原版页面"], ["text", "文本流"]].forEach(function (p) {
      var b = el("button", "lvbtn" + (viewOf(doc) === p[0] ? " on" : ""), p[1]);
      b.type = "button";
      b.title = p[0] === "page"
        ? "按 PDF 原件逐页渲染：排版、表格、图表都是原样；标注与选区仍可用"
        : "按块排布的文本：改格子、对比缓冲区用这个视图";
      b.addEventListener("click", function () {
        if (viewOf(doc) === p[0]) return;
        saveScroll();
        S.viewBy[doc.id] = p[0];
        lsSet("qd.viewBy", S.viewBy);
        S.pendingScroll = readScroll(doc, p[0]);
        renderDoc();
      });
      bar.appendChild(b);
    });
    head.appendChild(bar);
  }

  function renderDoc() {
    var doc = S.doc;
    if (window.QD_VERSION && doc && doc.id != null) {
      window.QD_VERSION.ensureInit(doc);
    }
    doc = ensureCounted(doc);
    var res = eng.select(doc, S.level);
    var stagedMap = (window.QD_VERSION && doc && doc.id != null)
      ? window.QD_VERSION.staged(doc.id)
      : {};
    var main = document.getElementById("doc");
    main.innerHTML = "";

    var head = el("div", "doc-head");
    var bh = (doc._scan && doc._scan.blockedHits) || [];
    head.appendChild(el("h2", null, doc.name));
    head.appendChild(el("div", "doc-meta",
      doc.area + "　·　" + doc.path + "　·　" + doc.nchars + " 字　·　本篇命中 " +
      Object.keys(doc._n).length + " 个词条，界面标出 " + res.marked + " 处" +
      (bh.length ? "；另有 " + bh.length + " 处形似而非（" +
        bh.map(function (h) { return h.form; }).filter(uniq).join("、") +
        "）被同形词护栏挡掉，规则见 hand/guards.js" : "")));
    main.appendChild(head);
    addViewToggle(head, doc);

    // PDF 文档默认给「原版页面」：逐页 canvas 还原排版与图表，覆盖层负责标注和选区。
    // 二进制不在（隐私模式/未存上）或 pdf.js 不可用时自动回落文本流。
    if (doc.kind === "pdf" && viewOf(doc) === "page" && window.QD_PAGEVIEW) {
      var stagedCount = Object.keys(stagedMap).length;
      if (stagedCount) {
        main.appendChild(el("div", "pv-note",
          "缓冲区里有 " + stagedCount + " 处待应用改动：原版页面只展示原件，切到「文本流」查看或继续改。"));
      }
      var holder = el("div", "pv-host");
      main.appendChild(holder);
      renderSidebar(res);
      updateToolbar(res);
      renderVersionBar();
      window.QD_PAGEVIEW.render(doc, holder, {
        res: res,
        makeMark: makeMark,
        isCurrent: function () { return S.doc === doc; },
        onPageAppended: function () { tryRestoreScroll(false); }
      }).then(function (ok) {
        if (S.doc !== doc) return;   // 切走了：pending 属于新文档，别碰
        if (ok) {
          tryRestoreScroll(true);   // 全部页已落位，没到目标高度也强制落位
        } else if (viewOf(doc) === "page") {
          S.viewBy[doc.id] = "text";
          lsSet("qd.viewBy", S.viewBy);
          renderDoc();
        }
      });
      return;
    }

    var segs = res.segs;
    var byBlock = new Map();
    segs.forEach(function (sg, si) {
      var arr = byBlock.get(sg.bi) || [];
      arr.push({ seg: sg, si: si });
      byBlock.set(sg.bi, arr);
    });

    var preEl = null;
    doc.blocks.forEach(function (b, bi) {
      var list = byBlock.get(bi) || [];
      if (b.t === "code_open") {
        preEl = el("pre", "codeblock");
        main.appendChild(preEl);
        return;
      }
      if (b.t === "code_close") { preEl = null; return; }
      if (b.t === "code") {
        if (!preEl) { preEl = el("pre", "codeblock"); main.appendChild(preEl); }
        preEl.appendChild(el("div", null, b.x));
        return;
      }
      preEl = null;
      if (b.t === "hr") { main.appendChild(el("hr")); return; }

      var node;
      if (b.t === "table") {
        node = el("div", "tablewrap");
        var tb = el("table");
        var byCell = new Map();
        list.forEach(function (x) {
          if (x.seg.col != null) byCell.set(x.seg.row + ":" + x.seg.col, x.si);
        });
        function cell(host, txt, ri, ci, flagged) {
          var td = el(host);
          if (flagged) td.className = "flagcell";
          // 长格必须单独给宽：自动布局会把 83 字的备注挤成最小宽，竖排成 350px 高的一行
          if (txt.length > 40) td.classList.add("wide");
          td.dataset.bi = bi;
          td.dataset.row = ri;
          td.dataset.col = ci;
          var si = byCell.get(ri + ":" + ci);
          renderSeg(td, txt, si == null ? null : res.bySeg.get(si), si == null ? -1 : si);
          decorateStagedCell(td, bi, ri, ci, stagedMap);
          return td;
        }
        if (b.h && b.h.length) {
          var thead = el("thead"), trh = el("tr");
          b.h.forEach(function (c, ci) { trh.appendChild(cell("th", c, 0, ci)); });
          thead.appendChild(trh);
          tb.appendChild(thead);
        }
        var tbody = el("tbody");
        b.r.forEach(function (row, ri) {
          var tr = el("tr");
          row.forEach(function (c, ci) {
            tr.appendChild(cell("td", c, ri + 1, ci, c === "待核" || /未检索到|存疑/.test(c)));
          });
          tbody.appendChild(tr);
        });
        tb.appendChild(tbody);
        node.appendChild(tb);
      } else {
        var cls = { h: "h" + Math.min(b.l, 4), p: "para", li: "li", quote: "quote" }[b.t] || "para";
        node = el("div", cls);
        if (b.t === "li") node.appendChild(el("span", "bullet", "·"));
        var s0 = list[0];
        renderSeg(node, b.x, s0 ? res.bySeg.get(s0.si) : null, s0 ? s0.si : -1);
      }
      if (b.path && b.path.length) node.dataset.sec = b.path[b.path.length - 1];
      node.dataset.bi = bi;
      decorateStaged(node, bi, stagedMap);
      main.appendChild(node);
    });

    renderSidebar(res);
    updateToolbar(res);
    renderVersionBar();
    tryRestoreScroll(true);   // 文本流是同步建完的，直接落位
  }

  // ── 侧栏：本篇摊开的概念清单 ───────────────────────────
  function renderSidebar(res) {
    var doc = S.doc;
    var box = document.getElementById("side");
    if (!box) return;   // 右栏只保留概念解释窗口（#detail）；概念清单侧栏已移除
    box.innerHTML = "";

    var counts = { A: 0, B: 0, C: 0 };
    var rows = Object.keys(doc._n).map(function (k) { return byIdx[+k]; })
      .filter(Boolean);
    rows.forEach(function (e) { counts[tierOf(e)]++; });

    var card = el("div", "card");
    card.appendChild(el("h3", null, "这篇里的概念"));
    var stat = el("div", "stat");
    ["A", "B", "C"].forEach(function (t) {
      var s = el("div", "stat-" + t);
      s.appendChild(el("b", null, String(counts[t])));
      s.appendChild(el("span", null, CFG.tier[t].label + " " + CFG.tier[t].full));
      stat.appendChild(s);
    });
    card.appendChild(stat);
    card.appendChild(el("p", "note", CFG.text.boundary));
    box.appendChild(card);

    var mustRows = rows.filter(function (e) { return e.must; });
    if (mustRows.length) {
      var mc = el("div", "card");
      mc.appendChild(el("h3", null, "不许跳过的词 · 本篇 " + mustRows.length + " 个"));
      mc.appendChild(el("p", "note", "账本第八节：低频，或极易被无声略过，但都在判断层面——不懂就会直接写错结论。"));
      mustRows.forEach(function (e) { mc.appendChild(termLine(e)); });
      box.appendChild(mc);
    }

    var tiers = ["A", "B", "C"].filter(function (t) { return counts[t]; });
    var lc = el("div", "card");
    lc.appendChild(el("h3", null, "按档展开"));
    var filter = el("div", "chips");
    [["", "全部"]].concat(tiers.map(function (t) { return [t, CFG.tier[t].label]; }))
      .forEach(function (p) {
        var b = el("button", "chip" + (S.sideTier === p[0] ? " on" : ""), p[1]);
        b.addEventListener("click", function () { S.sideTier = p[0]; renderSidebar(res); });
        filter.appendChild(b);
      });
    lc.appendChild(filter);

    var shown = rows
      .filter(function (e) { return !S.sideTier || tierOf(e) === S.sideTier; })
      .sort(function (a, b) {
        var d = a.tier.localeCompare(b.tier);
        return d || (b.star - a.star) || (doc_n(b.idx) - doc_n(a.idx));
      });
    var ul = el("div", "termlist");
    shown.slice(0, CFG.sidebarMaxTerms).forEach(function (e) { ul.appendChild(termLine(e)); });
    if (shown.length > CFG.sidebarMaxTerms)
      ul.appendChild(el("p", "note", "只列前 " + CFG.sidebarMaxTerms + " 个（共 " + shown.length +
        "）。要看不止这个数，用上面的 A/B/C 筛选，或直接搜。"));
    lc.appendChild(ul);
    box.appendChild(lc);
  }

  function termLine(e) {
    var row = el("button", "tline");
    row.appendChild(badge(e));
    row.appendChild(el("span", "tname", e.forms[0]));
    if (e.star) row.appendChild(el("span", "star", "★".repeat(e.star)));
    row.appendChild(el("span", "tn", doc_n(e.idx) + " 次"));
    row.addEventListener("click", function () { openTerm(e.idx, {}); });
    return row;
  }

  // ── 词条详情 ───────────────────────────────────────────
  function loadWeb(body, termText, docName) {
    body.innerHTML = "";
    if (!window.QD_WEB || typeof window.QD_WEB.lookup !== "function" ||
        !window.QD_MD || typeof window.QD_MD.render !== "function") {
      body.appendChild(el("div", "d-web-err", CFG.text.webNotLoaded));
      return;
    }
    body.appendChild(el("div", "d-web-loading", CFG.text.webLoading));
    window.QD_WEB.lookup(termText, docName).then(function (r) {
      body.innerHTML = "";
      if (r && r.ok) {
        var holder = el("div", "d-web-md");
        holder.innerHTML = window.QD_MD.render(r.text);   // md.js 已转义，这里只接它的 HTML
        body.appendChild(holder);
      } else {
        showWebError(body, termText, docName, (r && r.error) || CFG.text.webFailedLabel);
      }
    }).catch(function (err) {
      body.innerHTML = "";
      showWebError(body, termText, docName, String((err && err.message) || err));
    });
  }

  function showWebError(body, termText, docName, msg) {
    body.appendChild(el("div", "d-web-err", msg));
    var retry = el("button", "btn", CFG.text.webRetry);
    retry.type = "button";
    retry.addEventListener("click", function () { loadWeb(body, termText, docName); });
    body.appendChild(retry);
  }

  function openWebSettings(btn) {
    var key = "";
    try { key = localStorage.getItem("qd.ai.key") || ""; } catch (e) {}
    var next = window.prompt(CFG.text.webSettingsPrompt, key);
    if (next === null) return;
    var value = String(next).trim();
    try {
      if (value) localStorage.setItem("qd.ai.key", value);
      else localStorage.removeItem("qd.ai.key");
    } catch (e) {}
    btn.textContent = CFG.text.webSettingsSaved;
    setTimeout(function () { btn.textContent = CFG.text.webSettings; }, 1500);
  }

  // 右栏「概念解释」是否展开：未展开时整列折叠，正文占满，减少留白（样式见 .layout.detail-open）。
  function setDetailOpen(open) {
    var layout = document.querySelector(".layout");
    if (layout) layout.classList.toggle("detail-open", !!open);
  }

  // 收起概念解释整栏：清选中词、清高亮，正文回到全宽
  function closeTerm() {
    S.sel = null;
    var box = document.getElementById("detail");
    if (box) {
      box.innerHTML = "";
      box.classList.add("hide");
    }
    setDetailOpen(false);
    Array.prototype.forEach.call(document.querySelectorAll(".mk.sel"), function (n) {
      n.classList.remove("sel");
    });
  }

  function openTerm(idx, jump) {
    S.sel = idx;
    var e = byIdx[idx];
    var box = document.getElementById("detail");
    box.innerHTML = "";
    box.classList.remove("hide");
    setDetailOpen(true);

    var shown = (jump && jump.form) || e.forms[0];
    var others = e.forms.filter(function (f) { return f !== shown; });

    var h = el("div", "d-head");
    h.appendChild(el("h3", null, shown));
    var chips = el("div", "chips");
    chips.appendChild(badge(e, " big"));
    if (e.star) chips.appendChild(el("span", "chip on", "★".repeat(e.star) + " 不懂会卡住"));
    if (e.must) chips.appendChild(el("span", "chip warn", "不许跳过"));
    if (e.src) chips.appendChild(el("span", "chip", "补录词"));
    h.appendChild(chips);
    box.appendChild(h);

    // 主释义区：联网解释，异步填充；不再展示账本 gloss 和其它文稿原句。
    var webRow = el("div", "d-row");
    webRow.appendChild(el("span", "k", CFG.text.webTitle));
    var webBody = el("div", "v d-web-body");
    webRow.appendChild(webBody);
    box.appendChild(webRow);

    var webOps = el("div", "d-ops");
    var webSet = el("button", "btn", CFG.text.webSettings);
    webSet.type = "button";
    webSet.addEventListener("click", function () { openWebSettings(webSet); });
    var webClear = el("button", "btn", CFG.text.webClearCache);
    webClear.type = "button";
    webClear.addEventListener("click", function () {
      if (window.QD_WEB && typeof window.QD_WEB.cacheClear === "function") window.QD_WEB.cacheClear(shown);
      loadWeb(webBody, shown, S.doc.name);
    });
    webOps.appendChild(webSet);
    webOps.appendChild(webClear);
    box.appendChild(webOps);

    loadWeb(webBody, shown, S.doc.name);

    if (others.length) {
      var al = el("div", "d-row");
      al.appendChild(el("span", "k", shown === e.forms[0] ? "其他写法" : "同一行的其它词"));
      var w = el("span", "v forms");
      others.forEach(function (f) { w.appendChild(el("i", null, f)); });
      al.appendChild(w);
      box.appendChild(al);
    }

    var n = doc_n(idx);
    var nShown = (jump && jump.form) ? doc_n(idx, jump.form) : n;
    var row1 = el("div", "d-row");
    row1.appendChild(el("span", "k", "本文"));
    var v = el("span", "v");
    if (!n) v.textContent = "这篇里没出现";
    else if (nShown === n) v.textContent = "出现 " + n + " 处（界面实算）";
    else v.textContent = "出现 " + nShown + " 处；账本同一行的其它写法合计 " + n + " 处（界面实算）";
    row1.appendChild(v);
    box.appendChild(row1);

    if (e.freq || e.freqraw) {
      var row2 = el("div", "d-row");
      row2.appendChild(el("span", "k", "账本实测"));
      row2.appendChild(el("span", "v", (e.freqraw || e.freq) +
        "　（照抄《概念账本》那一格。那本账统计的语料与本工具的 24 篇不完全重合，两边数字别直接比；一行合并了几个词时，数字也是几个词一起记的）"));
      box.appendChild(row2);
    }
    var ops = el("div", "d-ops");
    var cp = el("button", "btn", "复制「拿这个词去问 AI」的话术");
    cp.addEventListener("click", function () {
      var t = "我在读《" + S.doc.name + "》，里面「" + shown + "」这个词（" + e.tier + " 档，" +
        (e.gloss || "") + "）。请别只给定义：① 用我这篇文档里的用法解释一遍；② 举一个它会让我写错结论的例子。";
      navigator.clipboard ? navigator.clipboard.writeText(t) : window.prompt("复制这段：", t);
      cp.textContent = "已复制，去粘给 AI";
      setTimeout(function () { cp.textContent = "复制「拿这个词去问 AI」的话术"; }, 2000);
    });
    ops.appendChild(cp);
    box.appendChild(ops);

    if (jump && jump.fromSeg != null && jump.s != null) {
      highlightSpan(jump.fromSeg, jump.s);
    }
    box.scrollTop = 0;
  }

  function jumpToFirst(idx) {
    var mk = document.querySelector('.mk[data-idx="' + idx + '"]');
    if (mk) {
      mk.scrollIntoView({ behavior: "smooth", block: "center" });
      mk.classList.add("flash");
      setTimeout(function () { mk.classList.remove("flash"); }, 1400);
      return;
    }
    // 这一档没标它，退一步跳到它命中的那个正文块
    var q = S.doc.quote && S.doc.quote[String(idx)];
    var node = q && document.querySelector('#doc [data-bi="' + q.b + '"]');
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("flash");
    setTimeout(function () { node.classList.remove("flash"); }, 1400);
  }
  function highlightSpan(si, s) {
    var mk = document.querySelector('.mk[data-seg="' + si + '"]');
    if (mk) mk.classList.add("sel");
    Array.prototype.forEach.call(document.querySelectorAll(".mk.sel"), function (n) {
      if (n.dataset.seg !== String(si)) n.classList.remove("sel");
    });
  }

  // ── 搜索 ──────────────────────────────────────────────
  function renderSearch() {
    var box = document.getElementById("results");
    if (!box) return;
    box.innerHTML = "";
    if (!S.q.trim()) return;
    var rows = window.QD_SEARCH.search(S.q, TERMS, S.doc, CFG);
    if (!rows.length) {
      var p = el("p", "empty", CFG.text.emptySearch);
      var more = el("p", "empty", "也可能是账本缺条目。补法：在《概念账本》那份清单里给它加一行（档、★、一句话、实测、定位），重跑 build.py。");
      box.appendChild(p); box.appendChild(more);
      return;
    }
    rows.forEach(function (r) {
      var e = r.e;
      var b = el("button", "srow");
      b.appendChild(badge(e));
      var meta = el("span", "smeta");
      meta.appendChild(el("span", "tname", r.form));
      if (e.star) meta.appendChild(el("span", "star", "★".repeat(e.star)));
      meta.appendChild(el("span", "sform", r.n ? "本篇 " + r.n + " 处" : "本篇没有"));
      b.appendChild(meta);
      var gl = e.gloss || "（只登记了名字）";
      if (r.form !== e.forms[0]) gl = "与「" + e.forms[0] + "」同属账本一行，共用这句释义：" + gl;
      b.appendChild(el("span", "sgloss", gl));
      b.addEventListener("click", function () { openTerm(e.idx, { form: r.form }); });
      box.appendChild(b);
    });
    var foot = el("p", "note", "共 " + rows.length + " 条。排在前面的是当前这篇里出现过的。");
    box.appendChild(foot);
  }

  // ── 工具条 ────────────────────────────────────────────
  function updateToolbar(res) {
    var bar = document.getElementById("levels");
    var lv = CFG.levels[S.level];
    document.getElementById("density").textContent =
      "标了 " + res.marked + " 处（候选 " + res.pool + " 处）· 每词上限 " +
      lv.perTermCap + " · 每段上限 " + lv.perSegCap + " · 每千字 " + lv.perMilleCap;
    if (bar.dataset.done) {
      Array.prototype.forEach.call(bar.children, function (b) {
        b.classList.toggle("on", b.dataset.lv === S.level);
      });
      return;
    }
    bar.dataset.done = "1";
    Object.keys(CFG.levels).forEach(function (k) {
      var b = el("button", "lvbtn", CFG.levels[k].name);
      b.title = CFG.levels[k].note;
      b.dataset.lv = k;
      b.addEventListener("click", function () { S.level = k; renderDoc(); });
      bar.appendChild(b);
      b.classList.toggle("on", k === S.level);
    });
    var legend = document.getElementById("legend");
    ["A", "B", "C"].forEach(function (t) {
      var s = el("span", "lg lg-" + t, CFG.tier[t].label + " " + CFG.tier[t].full);
      s.title = CFG.tier[t].hint;
      legend.appendChild(s);
    });
    legend.appendChild(el("span", "lg lg-star", "★ 不懂就会卡住"));
  }

  // 选中一篇文档：先同步状态，再整页重渲染。导入模块和左栏按钮都走这一个入口。
  function selectDoc(id) {
    var d = null;
    for (var i = 0; i < DOCS.length; i++) {
      if (DOCS[i].id === id) { d = DOCS[i]; break; }
    }
    if (!d) return false;
    saveScroll();   // 先把即将离开的这篇的位置记下来
    S.doc = d; S.sel = null; S.sideTier = "";
    lsSet("qd.lastDoc", d.id);
    if (window.QD_VERSION && d && d.id != null) window.QD_VERSION.ensureInit(d);
    document.getElementById("detail").classList.add("hide");
    setDetailOpen(false);
    S.pendingScroll = readScroll(d, viewOf(d));
    renderDocList();
    renderDoc();
    return true;
  }

  function renderDocList() {
    var box = document.getElementById("docs");
    box.innerHTML = "";
    var groups = {};
    DOCS.forEach(function (d) { (groups[d.area] = groups[d.area] || []).push(d); });
    Object.keys(groups).forEach(function (area) {
      box.appendChild(el("div", "grp", area));
      // 组内按文件修改时间倒序（最新的在最上面）；预烘语料没有 mtime，稳定排序保持原有次序。
      groups[area].slice().sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); })
        .forEach(function (d) {
          var row = el("div", "drow" + (S.doc && d.id === S.doc.id ? " on" : ""));
          row.appendChild(el("span", "dname", d.name));
          row.appendChild(el("span", "dn", Object.keys(ensureCounted(d)._n).length + "词"));
          if (d.imported) {
            var del = el("button", "ddel", "×");
            del.type = "button";
            del.title = "删除这篇导入的文档（含其缓冲区与历史版本）";
            del.addEventListener("click", function (ev) { ev.stopPropagation(); deleteImported(d.id); });
            row.appendChild(del);
          }
          row.addEventListener("click", function () { selectDoc(d.id); });
          box.appendChild(row);
        });
    });
  }

  // 删除一篇导入文档：确认后清掉 localStorage 记录与其缓冲/版本，从列表移除并重渲染。
  // 预烘语料（data/docs.js，没有 imported 标记）不会走到这里。
  function deleteImported(id) {
    if (!window.confirm("删除这篇导入的文档？它的待应用缓冲区和历史版本会一并清除（不影响你电脑上的原始文件）。")) return;
    if (window.QD_IMPORT && typeof window.QD_IMPORT.deleteRecord === "function") window.QD_IMPORT.deleteRecord(id);
    // 这篇的阅读位置与视图偏好也一并清掉，别在 qd.scroll / qd.viewBy 里留孤儿
    var smap = lsGet("qd.scroll", {});
    Object.keys(smap).forEach(function (k) { if (k.split(":")[0] === String(id)) delete smap[k]; });
    lsSet("qd.scroll", smap);
    if (S.viewBy[id] != null) { delete S.viewBy[id]; lsSet("qd.viewBy", S.viewBy); }
    if (lsGet("qd.lastDoc", null) === id) lsSet("qd.lastDoc", null);
    for (var i = 0; i < DOCS.length; i++) {
      if (DOCS[i].id === id) { DOCS.splice(i, 1); break; }
    }
    if (S.doc && S.doc.id === id) {
      S.doc = DOCS.length ? DOCS[0] : null;
      S.sel = null; S.sideTier = "";
      if (S.doc && window.QD_VERSION && S.doc.id != null) window.QD_VERSION.ensureInit(S.doc);
    }
    renderDocList();
    if (S.doc) {
      renderDoc();
    } else {
      var main = document.getElementById("doc");
      if (main) { main.innerHTML = ""; main.appendChild(el("p", "note", CFG.text.noDoc)); }
      var detail = document.getElementById("detail");
      if (detail) detail.classList.add("hide");
      setDetailOpen(false);
      renderVersionBar();
    }
  }

  function init() {
    // 界面文案全部来自 config.js，html 里只留空壳
    document.title = CFG.text.title + " · " + CFG.text.subtitle;
    document.getElementById("title").textContent = CFG.text.title;
    document.getElementById("subtitle").textContent = CFG.text.subtitle;

    // 重开页面回到最后读的那篇、读到哪算哪
    var last = lsGet("qd.lastDoc", null);
    if (typeof last === "string") {
      for (var i = 0; i < DOCS.length; i++) {
        if (DOCS[i].id === last) { S.doc = DOCS[i]; break; }
      }
    }
    S.pendingScroll = S.doc ? readScroll(S.doc, viewOf(S.doc)) : null;
    S.booted = true;
    window.addEventListener("pagehide", saveScroll);   // 刷新/关页前落一次位置

    if (S.doc && window.QD_VERSION && S.doc.id != null) window.QD_VERSION.ensureInit(S.doc);
    renderDocList();
    renderDoc();
    document.getElementById("detail").classList.add("hide");
    setDetailOpen(false);
  }

  // 给导入模块留的运行入口：只负责把文档挂到可变数组并切过去，不碰解析和文件读取。
  window.QD_APP = {
    addDoc: function (doc) { DOCS.push(doc); renderDocList(); },
    selectDoc: selectDoc,
    getDoc: function () { return S.doc; },
    rerender: function () { renderDoc(); },
    // 导入文档在 import.js 的 DOMContentLoaded（晚于本页 init）才挂回列表；
    // 还原完毕后调这个入口，让「最后读的那篇是导入文档」时也能正确回到原位。
    applyLastDoc: function () {
      var last = lsGet("qd.lastDoc", null);
      if (typeof last !== "string") return;
      if (S.doc && S.doc.id === last) return;
      selectDoc(last);
    }
  };

  window.addEventListener("DOMContentLoaded", init);
})();
