// 概念检索：输入一个词，返回它属于哪一档、一句话释义、以及它在**当前这篇文档里**的原句。
// 之所以把原句一起给，是因为释义离开语境就会失真——账本第十一节自己写了：
// 「概念在原文里学，比在词汇表里学记得牢十倍」。
(function () {
  "use strict";

  function norm(s) { return (s || "").toLowerCase().replace(/\s+/g, ""); }

  // 打分：完全等于写法 > 写法以输入开头 > 写法包含输入 > 输入包含写法 > 释义里出现输入。
  // 越靠前越像「用户就是想找这个词条」，所以分越高。
  function score(e, q) {
    var nq = norm(q), best = 0, hit = "";
    e.forms.forEach(function (f) {
      var nf = norm(f);
      var s = 0;
      if (nf === nq) s = 1000;
      else if (nf.indexOf(nq) === 0) s = 700 - nf.length;
      else if (nf.indexOf(nq) >= 0) s = 500 - nf.length;
      else if (nq.indexOf(nf) >= 0) s = 300;
      if (s > best) { best = s; hit = f; }
    });
    if (!best && norm(e.gloss).indexOf(nq) >= 0) best = 60;
    if (!best && norm(e.group).indexOf(nq) >= 0) best = 30;
    return { s: best, form: hit };
  }

  function search(q, terms, doc, cfg) {
    if (!q || !q.trim()) return [];
    var rows = [];
    for (var i = 0; i < terms.length; i++) {
      var e = terms[i];
      var sc = score(e, q);
      if (!sc.s) continue;
      var n = (doc && doc._n && doc._n[e.idx]) || 0;
      // 没对上写法（只是释义里提到）时印词条本名
      rows.push({ e: e, s: sc.s + n, n: n, form: sc.form || e.forms[0] });
    }
    rows.sort(function (a, b) { return b.s - a.s || b.n - a.n; });
    return rows.slice(0, cfg.searchMaxHits);
  }

  window.QD_SEARCH = { search: search, norm: norm };
})();
