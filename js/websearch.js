// 词条释义数据层：点开一个词时，向 DeepSeek 要一段「简洁的通俗概念介绍」。
// 2026-09-17 改版：原来打 Jina 联网搜索太慢且要单独的 Key，现在复用「问 AI」那套
// DeepSeek 直连（同一个 Key、同一个接口），一次请求返回两三句白话解释即可。
// 只对外暴露 window.QD_WEB = { lookup, cacheClear }，界面文案和按钮都在 js/app.js。
// 返回内容绝不当作原始 HTML 注入，而是交给 js/md.js 渲染（md.js 会先转义再套标签）。
window.QD_WEB = (function () {
  "use strict";

  var LS_PREFIX = "qd.web.v3.";      // v2 是 Jina 时代的缓存，换新前缀避免读到旧结构
  // 复用 ask.js 那套 DeepSeek 配置，用户在「问 AI」里填过一次就够用。
  var LS_KEY = "qd.ai.key";
  var LS_BASE = "qd.ai.base";
  var LS_MODEL = "qd.ai.model";
  var TIMEOUT_MS = 20000;
  var mem = {};

  function cfg() { return (window.QD_CONFIG && window.QD_CONFIG.ai) || {}; }

  function store(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function load(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function remove(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }
  function norm(term) {
    return String(term == null ? "" : term).replace(/\s+/g, " ").trim().toLowerCase();
  }
  function cacheKey(term) {
    return LS_PREFIX + norm(term);
  }

  function settings() {
    var c = cfg();
    return {
      key: (load(LS_KEY) || "").trim(),
      base: load(LS_BASE) || c.defaultBase || "https://api.deepseek.com",
      model: load(LS_MODEL) || c.defaultModel || "deepseek-chat"
    };
  }

  // 双击 file:// 打开时，跨域请求常被浏览器拦下；这条提示也拼进失败文案里。
  function fileHint() {
    return "如果当前是用 file:// 双击打开的，浏览器常会拦下跨域请求；可在本目录运行 python -m http.server 后用 http://localhost:8000 打开再试。";
  }

  // 让模型只给一段简短白话解释，别展开成长文。
  function systemPrompt() {
    return "你在帮一位集成电路 / 半导体方向的学习者，快速弄懂文稿里出现的关键词。" +
      "请用简体中文，就这个词条给出简洁的通俗解释：两三句话说清它是什么、在行业里通常指什么即可；" +
      "如涉及专有缩写，先给出全称。不要复述问题、不要列长清单、不要编造拿不准的数字。";
  }

  function statusHint(code) {
    if (code === 401 || code === 403) return "DeepSeek Key 无效或没权限——在「问 AI」的设置里核对 Key";
    if (code === 402) return "DeepSeek 账户余额不足——充值后再试（能拿到 402 说明直连和 Key 都通了）";
    if (code === 429) return "请求太频繁或触发限流——稍后再试";
    if (code === 422) return "请求参数不对——检查接口地址/模型名是否填错";
    if (code >= 500) return "DeepSeek 服务端临时出错——稍后再试";
    return "接口返回了非 2xx 状态码";
  }

  // 从 OpenAI 兼容的返回里取出正文。
  function extractText(obj) {
    if (!obj) return "";
    var ch = obj.choices && obj.choices[0];
    if (ch && ch.message && ch.message.content) return String(ch.message.content).trim();
    if (ch && ch.text) return String(ch.text).trim();   // 少数补全式接口
    return "";
  }

  function lookup(termText, contextHint) {
    return new Promise(function (resolve) {
      var term = norm(termText);
      if (!term) { resolve({ ok: false, error: "词条为空，无法生成解释。" }); return; }

      var key = cacheKey(term);
      var hit = mem[key] || load(key);
      if (hit) {
        try { hit = JSON.parse(hit); } catch (e) { hit = null; }
        if (hit && hit.text) { resolve({ ok: true, text: hit.text }); return; }
      }

      var s = settings();
      var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var timer = null;
      var finished = false;

      function done(result) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }

      if (!s.key) {
        done({ ok: false, error: "生成解释需要 DeepSeek Key（与「问 AI」共用）。在任意正文选中一段点「问 AI」→「设置」里粘贴 Key 保存后，再回来点这个词。" });
        return;
      }

      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, TIMEOUT_MS);

      var userMsg = "请解释这个词条：" + String(termText == null ? "" : termText).trim() +
        (contextHint ? "（它出现在《" + contextHint + "》里）" : "");
      var body = JSON.stringify({
        model: s.model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userMsg }
        ]
      });
      var headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + s.key
      };
      var opts = { method: "POST", headers: headers, body: body };
      if (ctrl) opts.signal = ctrl.signal;

      var url = s.base.replace(/\/+$/, "") + "/chat/completions";
      fetch(url, opts).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (t) {
            var detail = "";
            try { var j = JSON.parse(t); if (j && j.error && j.error.message) detail = j.error.message; } catch (e) {}
            done({ ok: false, error: statusHint(resp.status) + "（接口 " + resp.status + (detail ? "：" + detail : "") + "）。" + fileHint() });
            return null;
          });
        }
        return resp.json();
      }).then(function (obj) {
        if (obj == null) return;
        var text = extractText(obj);
        if (!text) {
          done({ ok: false, error: "接口没有返回解释内容。" + fileHint() });
          return;
        }
        var cache = { t: Date.now(), text: text };
        mem[key] = JSON.stringify(cache);
        store(key, JSON.stringify(cache));
        done({ ok: true, text: text });
      }).catch(function (err) {
        var msg = String((err && err.message) || err);
        if (/abort|aborted/i.test(msg)) {
          done({ ok: false, error: "生成超时（" + (TIMEOUT_MS / 1000) + " 秒）没等到回应。" + fileHint() });
        } else if (/Failed to fetch|NetworkError|Load failed|CORS|Cross-Origin/i.test(msg)) {
          done({ ok: false, error: "网络/跨域请求失败，浏览器没拿到接口响应。" + fileHint() });
        } else {
          done({ ok: false, error: msg + fileHint() });
        }
      });
    });
  }

  function cacheClear(termText) {
    var key = cacheKey(termText);
    delete mem[key];
    remove(key);
  }

  return { lookup: lookup, cacheClear: cacheClear };
})();
