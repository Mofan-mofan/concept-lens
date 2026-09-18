// PDF 二进制存放：localStorage 只放得下文本，原版页面视图刷新后还要重画 canvas，
// 所以导入时把 ArrayBuffer 存进 IndexedDB（键 = 文档 id），删除导入时连带清掉。
// IndexedDB 不可用（隐私模式等）时静默降级：原版页面视图入口不出现，文本流不受影响。
(function () {
  "use strict";

  var DB_NAME = "qd-pdf-bin";
  var STORE = "bins";
  var dbp = null;

  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      var req;
      try {
        req = window.indexedDB.open(DB_NAME, 1);
      } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbp;
  }

  function put(id, buf) {
    return openDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(buf, id);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
          tx.onabort = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }

  function get(id) {
    return openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, "readonly");
          var req = tx.objectStore(STORE).get(id);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function del(id) {
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
      } catch (e) {}
    });
  }

  function clear() {
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
      } catch (e) {}
    });
  }

  window.QD_PDFSTORE = { put: put, get: get, del: del, clear: clear };
})();
