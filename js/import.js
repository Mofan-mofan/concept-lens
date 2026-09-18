// 导入入口：把用户选的 .md/.txt/.pdf 文件解析成与 build.py 同构的文档对象，再交给 QD_APP 显示。
// PDF 靠 index.html 里从 CDN 引入的 pdf.js 逐页抽文字；断网时跳过 PDF 并提示，其余功能不受影响。
(function () {
  "use strict";

  var LS_IMPORTS = "qd.imports.v1";   // 存导入记录数组 [{id,name,area,path,text}]，下次打开自动还原

  // ── Markdown → blocks ─────────────────────────────────
  // 下面这段逐条照抄 build.py 的 parse_md，字段名、清洗方式和 path 算法保持一致。

  function cellsOf(line) {
    var s = line.replace(/^\s+|\s+$/g, "");
    var m = /^\|(.+)\|\s*$/.exec(s);
    if (!m) return null;
    var cs = m[1].split("|").map(function (c) {
      return c.replace(/\*+/g, "").replace(/^\s+|\s+$/g, "");
    });
    if (!cs.length) return null;
    var allSep = true;
    for (var i = 0; i < cs.length; i++) {
      if (!/^:?-{2,}:?$/.test(cs[i] || "---")) { allSep = false; break; }
    }
    if (allSep) return null;   // 表格分隔行不进数据
    return cs;
  }

  function parseMarkdown(text) {
    var raw = String(text == null ? "" : text);
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);   // 去掉 UTF-8 BOM
    var lines = raw.replace(/\r\n?/g, "\n").split("\n");
    var blocks = [];
    var fence = false;
    var buf = [];
    var tbl = [];

    function flushP() {
      if (!buf.length) return;
      var t = buf.join(" ").replace(/^\s+|\s+$/g, "");
      if (t) blocks.push({ t: "p", x: t });
      buf.length = 0;
    }

    function flushT() {
      if (!tbl.length) return;
      var rows = [];
      for (var i = 0; i < tbl.length; i++) {
        var cs = cellsOf(tbl[i]);
        if (cs) rows.push(cs);
      }
      if (rows.length) {
        var head = rows[0];
        var body = rows.slice(1);
        // 和 build.py 一样做一次兜底：第一行若整体都是 --- 之类，就只当它不存在
        if (/^[-\s:|]+$/.test(head.join(""))) {
          head = [];
          body = rows.slice(1);
        }
        blocks.push({ t: "table", h: head, r: body });
      }
      tbl.length = 0;
    }

    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li];

      if (ln.replace(/^\s+|\s+$/g, "").indexOf("```") === 0) {
        fence = !fence;
        if (fence) {
          flushP();
          flushT();
          blocks.push({ t: "code_open" });
        } else {
          blocks.push({ t: "code_close" });
        }
        continue;
      }
      if (fence) {
        blocks.push({ t: "code", x: ln });
        continue;
      }

      var s = ln.replace(/^\s+|\s+$/g, "");
      if (!s) {
        flushP();
        flushT();
        continue;
      }
      if (s.charAt(0) === "|") {
        flushP();
        tbl.push(s);
        continue;
      }
      flushT();

      var hm = /^(#{1,6})\s*(.+)$/.exec(s);
      if (hm) {
        flushP();
        blocks.push({
          t: "h",
          l: hm[1].length,
          x: hm[2].replace(/\*+/g, "").replace(/^\s+|\s+$/g, "")
        });
        continue;
      }

      var lm = /^[-*+]\s+(.+)$/.exec(s) || /^\d+[.、]\s*(.+)$/.exec(s);
      if (lm) {
        flushP();
        blocks.push({ t: "li", x: lm[1].replace(/^\s+|\s+$/g, "") });
        continue;
      }

      if (/^[-*_]{3,}$/.test(s)) {
        flushP();
        blocks.push({ t: "hr" });
        continue;
      }

      if (s.charAt(0) === ">") {
        flushP();
        blocks.push({
          t: "quote",
          x: s.replace(/^[> ]+/, "").replace(/^\s+|\s+$/g, "")
        });
        continue;
      }

      buf.push(s);
    }
    flushP();
    flushT();

    // 章节链：按序回放 blocks，标题记住当前层，并删掉比它更深的层。
    var openHeads = {};
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      if (b.t === "h") {
        openHeads[b.l] = b.x;
        Object.keys(openHeads).forEach(function (k) {
          if (+k > b.l) delete openHeads[k];
        });
      }
      var levels = Object.keys(openHeads).map(Number)
        .filter(function (k) { return k <= (b.l || 99); })
        .sort(function (a, b2) { return a - b2; });
      b.path = levels.map(function (k) { return openHeads[k]; });
    }
    return blocks;
  }

  // ── 纯文本长度 ────────────────────────────────────────
  function blockText(b) {
    if (b.t === "h" || b.t === "p" || b.t === "li" || b.t === "quote" || b.t === "code") {
      return b.x || "";
    }
    if (b.t === "table") {
      var rows = [];
      if (b.h && b.h.length) rows.push(b.h);
      (b.r || []).forEach(function (r) { rows.push(r); });
      return rows.map(function (r) { return r.join(" "); }).join(" ");
    }
    return "";
  }

  function countChars(blocks) {
    var total = 0;
    blocks.forEach(function (b) {
      // 按本次需求：代码块是示例/脚本，不计入「正文字数」
      if (b.t === "code" || b.t === "code_open" || b.t === "code_close") return;
      total += blockText(b).length;
    });
    return total;
  }

  // djb2 哈希：把「文件名+路径」折成稳定的 id，重新导入同一份文件时 id 不变，
  // 版本历史和编辑缓冲才不会因为 id 变了而错位。
  function hashId(str) {
    var h = 5381;
    str = String(str == null ? "" : str);
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & 0x7fffffff;
    }
    return "imp_" + h.toString(36);
  }

  // 从原始文本造出一个文档对象。持久化只存 text，还原时重新解析，保证与 build.py 同构。
  function buildDoc(id, name, area, path, text, mtime) {
    var blocks = parseMarkdown(text);
    return {
      id: id,
      name: name,
      area: area || "导入的文档",
      path: path,
      nchars: countChars(blocks),
      blocks: blocks,
      quote: {},
      imported: true,    // 由本模块造出来的都是导入文档（预烘语料走 data/docs.js，没有这个标记）
      mtime: mtime || 0,   // 文件修改时间，用于左栏「最新在最上面」排序
      _text: text
    };
  }

  function makeDoc(file, text) {
    var name = String(file.name || "").replace(/\.(md|txt|pdf)$/i, "");
    var path = file.webkitRelativePath || file.name || name;
    return buildDoc(hashId(name + "|" + path), name, "导入的文档", path, text, file.lastModified || 0);
  }

  // ── 持久化：localStorage 里的导入记录 ──────────────────
  function loadRecords() {
    try {
      var s = localStorage.getItem(LS_IMPORTS);
      var a = s ? JSON.parse(s) : [];
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecords(a) {
    try {
      localStorage.setItem(LS_IMPORTS, JSON.stringify(a));
      return true;
    } catch (e) {
      return false;   // 多半是超出配额
    }
  }

  // 按 id 覆盖或追加一条记录，返回是否写盘成功。
  function upsertRecord(rec) {
    var a = loadRecords();
    var found = false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] && a[i].id === rec.id) { a[i] = rec; found = true; break; }
    }
    if (!found) a.push(rec);
    return saveRecords(a);
  }

  function recordOf(doc) {
    return {
      id: doc.id,
      name: doc.name,
      area: doc.area,
      path: doc.path,
      mtime: doc.mtime || 0,
      kind: doc.kind || "",
      text: doc._text || ""
    };
  }

  // 打开页面时把上次的导入记录还原成文档，塞进 QD_APP。
  function restoreImports() {
    if (!window.QD_APP || typeof window.QD_APP.addDoc !== "function") return 0;
    var a = loadRecords();
    var n = 0;
    a.forEach(function (rec) {
      if (!rec || !rec.id) return;
      try {
        var doc = buildDoc(rec.id, rec.name, rec.area, rec.path, rec.text || "", rec.mtime || 0);
        if (rec.kind) doc.kind = rec.kind;
        window.QD_APP.addDoc(doc);
        n += 1;
      } catch (e) {}
    });
    return n;
  }

  function clearImports() {
    // 先逐篇清掉历史版本与缓冲区：导入文档的 id 由「文件名+路径」哈希得出，是稳定的，
    // 只删导入记录而不删版本，下次导入同一份文件时 ensureInit 会把旧版本的正文盖回来。
    var a = loadRecords();
    for (var i = 0; i < a.length; i++) {
      var id = a[i] && a[i].id;
      if (id != null && window.QD_VERSION && typeof window.QD_VERSION.purge === "function") {
        window.QD_VERSION.purge(id);
      }
    }
    try { localStorage.removeItem(LS_IMPORTS); } catch (e) {}
    if (window.QD_PDFSTORE) window.QD_PDFSTORE.clear();
  }

  // 删除单篇导入记录，并连带清掉它的缓冲区与历史版本（QD_VERSION.purge）。
  function deleteRecord(id) {
    var a = loadRecords();
    var kept = [];
    for (var i = 0; i < a.length; i++) {
      if (a[i] && a[i].id === id) continue;
      kept.push(a[i]);
    }
    saveRecords(kept);
    if (window.QD_VERSION && typeof window.QD_VERSION.purge === "function") window.QD_VERSION.purge(id);
    if (window.QD_PDFSTORE) window.QD_PDFSTORE.del(id);
  }

  // ── 文件读取与界面提示 ────────────────────────────────
  function setMsg(text, cls) {
    var m = document.getElementById("import-msg");
    if (!m) return;
    m.textContent = text || "";
    m.className = "import-msg" + (cls ? " " + cls : "");
  }

  // PDF：用 pdf.js（index.html 里从 CDN 引入）逐页抽文字，按坐标还原版面后走同一套 markdown 解析。
  // 断网 / CDN 不可达时 window.pdfjsLib 不存在，这里给出明确提示，不影响其它功能。
  function readPdf(file, done) {
    if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== "function") {
      done("读 PDF 需要联网加载 pdf.js，当前不可用（可能断网或 CDN 被拦）。请联网后重试，或改导入 .md/.txt：" + file.name, null);
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { done("读取失败：" + file.name, null); };
    reader.onload = function () {
      var bin = reader.result.slice(0);   // 原件留一份存 IndexedDB，原版页面视图刷新后还要重画
      var data = new Uint8Array(reader.result);
      window.pdfjsLib.getDocument({ data: data }).promise.then(function (pdf) {
        return window.QD_PDFLAYOUT.analyze(pdf).then(function (analysis) {
          var text = analysis.markdown;
          if (text.replace(/\s/g, "") === "") {
            done("PDF 里没有可提取的文字（可能是扫描版/图片型）：" + file.name, null);
            return;
          }
          var doc = makeDoc(file, text);
          doc.kind = "pdf";
          doc._pdfAnalysis = analysis;   // 行坐标与块映射，原版页面视图直接复用
          if (window.QD_PDFSTORE) window.QD_PDFSTORE.put(doc.id, bin);
          done(null, doc);
        });
      }).catch(function (err) {
        done("解析 PDF 失败：" + file.name + "（" + ((err && err.message) || err) + "）", null);
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function isPdf(file) { return /\.pdf$/i.test(String(file && file.name || "")); }

  function readOne(file, done) {
    if (isPdf(file)) { readPdf(file, done); return; }
    var reader = new FileReader();
    reader.onerror = function () { done("读取失败：" + file.name, null); };
    reader.onload = function () {
      var text = String(reader.result == null ? "" : reader.result);
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

      if (text.replace(/\s/g, "") === "") {
        done("文件是空的，没有可导入的内容：" + file.name, null);
        return;
      }
      if (text.indexOf("\u0000") >= 0) {
        done("文件里含二进制内容，不是纯文本：" + file.name, null);
        return;
      }
      var bad = (text.match(/\uFFFD/g) || []).length;
      if (bad > 3) {
        done("文件可能不是 UTF-8 文本，解码异常：" + file.name, null);
        return;
      }

      done(null, makeDoc(file, text));
    };
    reader.readAsText(file, "UTF-8");
  }

  function importFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      var name = fileList[i].name || "";
      if (/\.(md|txt|pdf)$/i.test(name)) files.push(fileList[i]);
    }
    if (!files.length) {
      setMsg("没找到以 .md、.txt 或 .pdf 结尾的文件。", "err");
      return;
    }

    var okDocs = [];
    var errs = [];
    var pending = files.length;
    setMsg("正在读取 " + files.length + " 个文件…", "");
    files.forEach(function (file) {
      readOne(file, function (err, doc) {
        if (err) errs.push(err);
        else okDocs.push(doc);
        pending -= 1;
        if (pending === 0) finishImport(okDocs, errs);
      });
    });
  }

  function finishImport(okDocs, errs) {
    if (!window.QD_APP) {
      setMsg("导入失败：界面模块还没准备好。", "err");
      return;
    }
    var last = null;
    var savedOk = true;
    okDocs.forEach(function (doc) {
      window.QD_APP.addDoc(doc);
      if (!upsertRecord(recordOf(doc))) savedOk = false;   // 存原文，下次自动还原
      last = doc;
    });
    if (last) window.QD_APP.selectDoc(last.id);

    var saved = okDocs.length
      ? (savedOk ? "，已固定到本地" : "（本地存储已满，未能固定，下次打开需重导）")
      : "";
    if (okDocs.length && !errs.length) {
      setMsg("已导入 " + okDocs.length + " 篇" + saved + "，正在显示《" + last.name + "》。", "ok");
    } else if (okDocs.length) {
      setMsg("已导入 " + okDocs.length + " 篇" + saved + "；另有 " + errs.length + " 个失败：" +
        errs.slice(0, 3).join("；"), "ok");
    } else {
      setMsg(errs.slice(0, 3).join("；"), "err");
    }
  }

  function init() {
    // 先把上次的导入还原出来（app.js 已在更早的 DOMContentLoaded 里选好默认文档，
    // 这里只是把导入的文档追加进左栏列表，不打扰当前显示）。
    var restored = restoreImports();
    // 还原的是「上次最后读的那篇」时，让 app.js 切回去并恢复阅读位置
    if (restored && window.QD_APP && typeof window.QD_APP.applyLastDoc === "function") {
      window.QD_APP.applyLastDoc();
    }

    var filePick = document.getElementById("file-pick");
    var dirPick = document.getElementById("dir-pick");
    var btnFile = document.getElementById("btn-file");
    var btnDir = document.getElementById("btn-dir");
    var btnClear = document.getElementById("btn-clear-imports");

    if (btnFile && filePick) {
      btnFile.addEventListener("click", function () {
        filePick.value = "";
        filePick.click();
      });
      filePick.addEventListener("change", function () {
        importFiles(filePick.files);
        filePick.value = "";
      });
    }
    if (btnDir && dirPick) {
      btnDir.addEventListener("click", function () {
        dirPick.value = "";
        dirPick.click();
      });
      dirPick.addEventListener("change", function () {
        importFiles(dirPick.files);
        dirPick.value = "";
      });
    }
    if (btnClear) {
      btnClear.addEventListener("click", function () {
        if (!window.confirm("清除后，之前导入并固定的文档将不再自动还原（本机 localStorage 记录会被删除）。确定吗？")) return;
        clearImports();
        location.reload();
      });
    }

    if (restored) {
      setMsg("已还原上次导入的 " + restored + " 篇文档。", "");
    }
  }

  // 给版本管理模块复用：countChars 的口径以这里为准，避免两份实现慢慢跑偏。
  window.QD_IMPORT = {
    countChars: countChars,
    parseMarkdown: parseMarkdown,
    deleteRecord: deleteRecord
  };

  window.addEventListener("DOMContentLoaded", init);
})();
