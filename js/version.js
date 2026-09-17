// 版本管理：编辑缓冲区 + 历史版本栈。
// 两块数据都只存浏览器 localStorage，不写回 data/ 目录；data/ 里的原始语料始终不变。
// 对外暴露 window.QD_VERSION，供 js/app.js 与 js/ask.js 共用。
(function () {
  "use strict";

  var P_BUF = "qd.buf.v1.";
  var P_VER = "qd.ver.v1.";

  // 记住当前被初始化过的文档对象。commit / restore 需要真正改 doc.blocks，
  // 光有 docId 拿不到 JS 里的对象引用，所以这里存一份引用，不存进 localStorage。
  var currentDocs = {};

  // 最近一次 commit 的报告。commit 的返回值按约定是版本号，跳过多少块放这里。
  var lastReport = { applied: 0, skipped: [], empty: false };

  function bufKey(docId) { return P_BUF + String(docId); }
  function verKey(docId) { return P_VER + String(docId); }

  function isObj(v) { return v && typeof v === "object"; }

  // 深拷贝：blocks 里有内层数组（table 的 h/r、h 的 path），不能只浅拷。
  function cloneValue(v) {
    if (Array.isArray(v)) return v.map(cloneValue);
    if (isObj(v)) {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = cloneValue(v[k]); });
      return o;
    }
    return v;
  }

  function cloneBlocks(blocks) {
    return Array.isArray(blocks) ? blocks.map(cloneValue) : [];
  }

  function loadJSON(key, fallback) {
    try {
      var s = localStorage.getItem(key);
      if (s == null) return fallback;
      return JSON.parse(s);
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadBuf(docId) {
    var v = loadJSON(bufKey(docId), {});
    return (isObj(v) && !Array.isArray(v)) ? v : {};
  }

  function saveBuf(docId, v) {
    saveJSON(bufKey(docId), v);
  }

  function loadVers(docId) {
    var v = loadJSON(verKey(docId), []);
    return Array.isArray(v) ? v : [];
  }

  function saveVers(docId, v) {
    saveJSON(verKey(docId), v);
  }

  // 字数口径与 js/import.js 的 countChars 一致：代码块不计入正文。
  // 优先复用 import.js 暴露出来的函数；万一脚本顺序不对，这里也有同样口径的兜底。
  function countChars(blocks) {
    if (window.QD_IMPORT && typeof window.QD_IMPORT.countChars === "function") {
      return window.QD_IMPORT.countChars(blocks || []);
    }

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

    var total = 0;
    (blocks || []).forEach(function (b) {
      if (b.t === "code" || b.t === "code_open" || b.t === "code_close") return;
      total += blockText(b).length;
    });
    return total;
  }

  function invalidate(doc) {
    if (!doc) return;
    // 改完 blocks 后，标记引擎的旧缓存必须作废，界面才会按新正文重新扫描。
    try { delete doc._n; delete doc._segs; delete doc._scan; } catch (e) {}
  }

  function ensureInit(doc) {
    if (!doc || doc.id == null) return [];
    var id = String(doc.id);
    currentDocs[id] = doc;

    var vers = loadVers(id);
    var firstSync = !doc._versionSynced;
    if (!vers.length) {
      vers.push({
        ver: 1,
        ts: Date.now(),
        name: doc.name || "",
        blocks: cloneBlocks(doc.blocks || []),
        nchars: countChars(doc.blocks || [])
      });
      saveVers(id, vers);
    } else if (firstSync) {
      // 页面刷新后，data/ 里的 doc.blocks 会回到原始 v1；这里把它同步到最近一次
      // 已提交的版本，避免「版本列表显示 v2、正文却还是 v1」这种对不上的状态。
      var latest = vers[vers.length - 1];
      doc.blocks = cloneBlocks(latest.blocks || []);
      doc.nchars = latest.nchars;
      invalidate(doc);
    }
    if (firstSync) doc._versionSynced = true;
    return vers;
  }

  function stage(docId, bi, newText) {
    var id = String(docId == null ? "" : docId);
    var buf = loadBuf(id);
    buf[String(bi)] = String(newText == null ? "" : newText);
    saveBuf(id, buf);
    return true;
  }

  function staged(docId) {
    var id = String(docId == null ? "" : docId);
    return cloneValue(loadBuf(id));
  }

  function unstage(docId, bi) {
    var id = String(docId == null ? "" : docId);
    var buf = loadBuf(id);
    var k = String(bi);
    if (!Object.prototype.hasOwnProperty.call(buf, k)) return false;
    delete buf[k];
    saveBuf(id, buf);
    return true;
  }

  function clear(docId) {
    var id = String(docId == null ? "" : docId);
    var n = Object.keys(loadBuf(id)).length;
    saveBuf(id, {});
    return n;
  }

  // 删除一篇导入文档时，连带清掉它的缓冲区、历史版本和内存引用。
  function purge(docId) {
    var id = String(docId == null ? "" : docId);
    try {
      localStorage.removeItem(bufKey(id));
      localStorage.removeItem(verKey(id));
    } catch (e) {}
    delete currentDocs[id];
  }

  function commit(docId) {
    lastReport = { applied: 0, skipped: [], empty: false };
    var id = String(docId == null ? "" : docId);
    var doc = currentDocs[id];
    var vers = loadVers(id);
    if (!doc || !vers.length) {
      lastReport.empty = true;
      return null;
    }

    var buf = loadBuf(id);
    var keys = Object.keys(buf);
    if (!keys.length) {
      lastReport.empty = true;
      return null;
    }

    keys.forEach(function (k) {
      var newText = String(buf[k] == null ? "" : buf[k]);

      // 单元格级键 "bi:row:col"：只替换表格里对应那一格，不动整张表。
      // row=0 是表头（block.h），row>=1 是正文行（block.r[row-1]）。
      var parts = String(k).split(":");
      if (parts.length === 3) {
        var cbi = Number(parts[0]), row = Number(parts[1]), col = Number(parts[2]);
        var tbl = (doc.blocks && doc.blocks[cbi]) || null;
        if (!tbl || tbl.t !== "table" || !isFinite(row) || !isFinite(col)) {
          lastReport.skipped.push(k); return;
        }
        if (row === 0) {
          if (tbl.h && col >= 0 && col < tbl.h.length) { tbl.h[col] = newText; lastReport.applied += 1; }
          else lastReport.skipped.push(k);
        } else {
          var bodyRow = tbl.r && tbl.r[row - 1];
          if (bodyRow && col >= 0 && col < bodyRow.length) { bodyRow[col] = newText; lastReport.applied += 1; }
          else lastReport.skipped.push(k);
        }
        return;
      }

      var bi = Number(k);
      if (!isFinite(bi)) { lastReport.skipped.push(k); return; }

      var block = (doc.blocks && doc.blocks[bi]) || null;
      if (!block || block.t === "table" || block.t === "code" ||
          block.t === "code_open" || block.t === "code_close") {
        lastReport.skipped.push(k);
        return;
      }
      if (block.t === "h" || block.t === "p" || block.t === "li" || block.t === "quote") {
        block.x = newText;
        lastReport.applied += 1;
      } else {
        lastReport.skipped.push(k);
      }
    });

    // 一条都没真正应用时不生成新版本，也不清缓冲区；让用户撤销或继续补改。
    if (!lastReport.applied) return null;

    var newVer = vers[vers.length - 1].ver + 1;
    vers.push({
      ver: newVer,
      ts: Date.now(),
      name: doc.name || "",
      blocks: cloneBlocks(doc.blocks || []),
      nchars: countChars(doc.blocks || [])
    });
    saveVers(id, vers);
    saveBuf(id, {});

    doc.nchars = vers[vers.length - 1].nchars;
    invalidate(doc);
    return newVer;
  }

  function list(docId) {
    var id = String(docId == null ? "" : docId);
    return loadVers(id).map(function (v) {
      return {
        ver: v.ver,
        ts: v.ts,
        name: v.name,
        nchars: v.nchars,
        blockCount: (v.blocks || []).length
      };
    }).sort(function (a, b) { return a.ver - b.ver; });
  }

  function restore(docId, ver) {
    var id = String(docId == null ? "" : docId);
    var doc = currentDocs[id];
    var vers = loadVers(id);
    if (!doc) return false;

    var target = null;
    for (var i = 0; i < vers.length; i++) {
      if (vers[i].ver === Number(ver)) { target = vers[i]; break; }
    }
    if (!target) return false;

    doc.blocks = cloneBlocks(target.blocks || []);
    doc.nchars = target.nchars;
    invalidate(doc);
    saveBuf(id, {});
    return true;
  }

  function blockLine(b) {
    if (!b) return null;
    if (b.t === "h") {
      var hashes = "";
      for (var i = 0; i < Math.min(b.l || 1, 6); i++) hashes += "#";
      return hashes + " " + (b.x || "");
    }
    if (b.t === "p") return b.x || "";
    if (b.t === "li") return "- " + (b.x || "");
    if (b.t === "quote") return "> " + (b.x || "");
    if (b.t === "hr") return "---";
    return null;
  }

  function tableMarkdown(b) {
    var lines = [];
    var h = b.h || [];
    var r = b.r || [];

    function row(cells) { return "| " + cells.join(" | ") + " |"; }

    if (h.length) {
      lines.push(row(h));
      lines.push("| " + h.map(function () { return "---"; }).join(" | ") + " |");
    } else if (r.length) {
      // 没有表头时，把第一行当作表头导出，这样重新导入时仍能识别成表格。
      lines.push(row(r[0]));
      lines.push("| " + r[0].map(function () { return "---"; }).join(" | ") + " |");
      r = r.slice(1);
    }

    r.forEach(function (cells) { lines.push(row(cells)); });
    return lines.join("\n");
  }

  function exportMarkdown(doc) {
    if (!doc || !Array.isArray(doc.blocks)) return "";

    var out = [];
    var codeLines = null;

    function flushCode() {
      if (codeLines) {
        out.push(codeLines.join("\n"));
        codeLines = null;
      }
    }

    doc.blocks.forEach(function (b) {
      if (b.t === "code_open") {
        flushCode();
        codeLines = ["```"];
      } else if (b.t === "code_close") {
        if (codeLines) codeLines.push("```");
        flushCode();
      } else if (b.t === "code") {
        if (codeLines) codeLines.push(b.x || "");
        else out.push(b.x || "");
      } else if (b.t === "table") {
        out.push(tableMarkdown(b));
      } else {
        var line = blockLine(b);
        if (line !== null) out.push(line);
      }
    });
    if (codeLines) {
      codeLines.push("```");
      flushCode();
    }

    return out.length ? out.join("\n\n") + "\n" : "";
  }

  window.QD_VERSION = {
    ensureInit: ensureInit,
    stage: stage,
    staged: staged,
    unstage: unstage,
    commit: commit,
    list: list,
    restore: restore,
    exportMarkdown: exportMarkdown,
    clear: clear,
    purge: purge,
    lastCommitReport: function () {
      return {
        applied: lastReport.applied,
        skipped: lastReport.skipped.slice(),
        empty: lastReport.empty
      };
    }
  };
})();
