// 「问 AI」交互层：在正文里选中一段 → 冒「问 AI」浮标 → 打开一个可拖动的浮动聊天窗 →
// 输入问题 → 直接调 DeepSeek（OpenAI 兼容接口）流式回答，回答用 js/md.js 渲染成正常排版。
// 设计取向：不加遮罩，窗口能拖到一边，你可以一边看正文一边追问，体验接近直接和 DeepSeek 对话。
// 默认值与系统提示在 js/config.js 的 ai 段；样式在 css/ask.css。
// API Key 不写进代码，由用户在「设置」里填，存浏览器 localStorage，绝不进仓库。
(function () {
  "use strict";

  var CFG = window.QD_CONFIG;
  var AI = CFG && CFG.ai;
  var MD = window.QD_MD;
  if (!AI || !AI.enabled || !MD) return;

  // ── localStorage：Key/接口/模型/窗口位置（都只在本机） ──
  var LS = { key: "qd.ai.key", base: "qd.ai.base", model: "qd.ai.model", pos: "qd.ai.pos" };
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function settings() {
    return { key: load(LS.key, ""), base: load(LS.base, AI.defaultBase), model: load(LS.model, AI.defaultModel) };
  }

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function trunc(s, n) { s = s || ""; return s.length > n ? s.slice(0, n) + "…" : s; }

  var docCol = null;                 // 正文容器 #doc，选中只认它里面的
  var lastSel = "";                  // 浮标弹出时记下的选中文字
  var lastBi = null;                 // 最近一次选中定位到的正文块序号；找不到就是 null
  var lastRow = null, lastCol = null; // 若选中的是表格某一格，记下行列（row=0 表头）；否则为 null
  var fabAsk = null;                 // 浮动按钮（问答与改写已合并为一个入口）
  var thread = [];                   // 对话：[{role:'user'|'assistant', text, quote, mode, bi, row, col, pending}]
  var pendingQuote = "";             // 下一条提问要带的引用原文
  var pendingBi = null;              // 下一条修改要写入的正文块序号
  var pendingRow = null, pendingCol = null;  // 下一条修改若是表格格，写入的行列
  var currentMode = "edit";          // 合并后固定为 edit：带 bi 的回答都会给出「应用到缓冲区」框
  var busy = false;
  var zTop = 100;                    // 每次开窗/点窗口抬一层，保证在最上

  // 窗口里的关键节点
  var win = null, threadEl = null, ctxChip = null, ctxLabel = null, ctxText = null,
      inputEl = null, sendBtn = null, statusEl = null, setWrap = null, modelBadge = null;

  // ── 浮标：选中正文后，在选区右上角出现一个「问 AI / 改这段」按钮 ──
  function makeFab(label, cls) {
    var b = el("button", "qd-fab" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.addEventListener("mousedown", function (ev) { ev.preventDefault(); }); // 保住选区
    document.body.appendChild(b);
    return b;
  }

  function ensureFabs() {
    if (!fabAsk) {
      fabAsk = makeFab(AI.fabLabel, "");
      fabAsk.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (openWin()) setPending(lastSel, lastBi, lastRow, lastCol);
      });
    }
  }

  function hideFabs() {
    if (fabAsk) fabAsk.style.display = "none";
  }

  function placeFabs(r) {
    var w = fabAsk.offsetWidth;
    var top = r.top - fabAsk.offsetHeight - 6;
    if (top < 4) top = r.bottom + 6;
    var left = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4));
    fabAsk.style.top = top + "px";
    fabAsk.style.left = left + "px";
  }

  // 从 selection 的公共祖先向上找定位信息：正文块 bi，以及（若选中的是表格格）行列 row/col。
  // 表格单元格上带了 data-bi/data-row/data-col；普通正文块只有 data-bi。
  function findLoc(sel) {
    var node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentNode;
    var bi = null, row = null, col = null;
    while (node && node !== docCol) {
      if (node.nodeType === 1 && node.dataset) {
        if (bi == null && node.dataset.bi != null) bi = node.dataset.bi;
        if (row == null && node.dataset.row != null && node.dataset.col != null) {
          row = node.dataset.row; col = node.dataset.col;
        }
      }
      if (bi != null && row != null) break;
      node = node.parentNode;
    }
    return { bi: bi, row: row, col: col };
  }

  function onSelectionEnd() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideFabs(); return; }
    var text = sel.toString().replace(/\s+$/, "");
    if (text.length < AI.minChars) { hideFabs(); return; }
    var node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentNode;
    if (!docCol || !docCol.contains(node)) { hideFabs(); return; }   // 选侧栏/选窗口里的字不弹

    lastSel = text;
    var loc = findLoc(sel);
    lastBi = loc.bi; lastRow = loc.row; lastCol = loc.col;
    ensureFabs();

    // 先显示再量宽度，否则 offsetWidth 还是 0。
    fabAsk.style.display = "block";
    placeFabs(sel.getRangeAt(0).getBoundingClientRect());
  }

  // ── 聊天窗 ──────────────────────────────────────────────
  function buildWin() {
    win = el("div", "qd-win");

    // 标题栏 = 拖动手柄
    var bar = el("div", "qd-bar");
    bar.appendChild(el("span", "qd-title", "问 AI"));
    bar.appendChild(el("span", "qd-mode", AI.modeTag));
    modelBadge = el("span", "qd-badge");
    bar.appendChild(modelBadge);
    var btns = el("div", "qd-barbtns");
    btns.appendChild(barBtn("清空", clearThread, "清空这次对话"));
    btns.appendChild(barBtn("设置", toggleSet, "填 API Key / 接口 / 模型"));
    btns.appendChild(barBtn("×", closeWin, "关闭（Esc）"));
    bar.appendChild(btns);
    win.appendChild(bar);
    makeDraggable(bar, win);

    // 设置抽屉（默认收起）
    setWrap = el("div", "qd-set");
    var s = settings();
    setWrap.appendChild(field("API Key（只存本机浏览器，绝不进仓库）", "password", LS.key, s.key, "sk-…"));
    setWrap.appendChild(field("接口地址 Base URL", "text", LS.base, s.base, AI.defaultBase));
    setWrap.appendChild(field("模型名", "text", LS.model, s.model, AI.defaultModel));
    var save = el("button", "qd-btn", "保存设置");
    save.type = "button";
    save.addEventListener("click", function () {
      ["key", "base", "model"].forEach(function (n) {
        var i = setWrap.querySelector('[data-k="' + LS[n] + '"]');
        if (i) store(LS[n], i.value.trim());
      });
      syncBadge();
      save.textContent = "已保存";
      setTimeout(function () { save.textContent = "保存设置"; }, 1500);
    });
    setWrap.appendChild(save);
    setWrap.style.display = "none";
    win.appendChild(setWrap);

    // 消息区
    threadEl = el("div", "qd-thread");
    win.appendChild(threadEl);

    // 输入区
    var comp = el("div", "qd-composer");
    statusEl = el("div", "qd-status");
    statusEl.style.display = "none";
    comp.appendChild(statusEl);

    ctxChip = el("div", "qd-ctx");
    ctxLabel = el("span", "qd-ctxlabel", AI.ctxEditLabel);
    ctxChip.appendChild(ctxLabel);
    ctxText = el("span", "qd-ctxtext");
    ctxChip.appendChild(ctxText);
    var ctxX = el("button", "qd-ctxx", "×");
    ctxX.type = "button"; ctxX.title = "不带这段引用";
    ctxX.addEventListener("click", function () { setPending(""); });
    ctxChip.appendChild(ctxX);
    ctxChip.style.display = "none";
    comp.appendChild(ctxChip);

    var inputRow = el("div", "qd-inputrow");
    inputEl = el("textarea", "qd-input");
    inputEl.placeholder = AI.inputPlaceholder;
    inputEl.rows = 1;
    inputEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(); }
    });
    inputEl.addEventListener("input", autogrow);
    inputRow.appendChild(inputEl);
    sendBtn = el("button", "qd-send", "发送");
    sendBtn.type = "button";
    sendBtn.addEventListener("click", send);
    inputRow.appendChild(sendBtn);
    comp.appendChild(inputRow);

    win.appendChild(comp);
    document.body.appendChild(win);
    syncBadge();
    renderThread();
  }

  function barBtn(label, fn, title) {
    var b = el("button", "qd-barbtn", label);
    b.type = "button"; if (title) b.title = title;
    b.addEventListener("click", function (ev) { ev.stopPropagation(); fn(); });
    return b;
  }
  function field(label, type, key, val, ph) {
    var w = el("label", "qd-field");
    w.appendChild(el("span", "qd-flabel", label));
    var i = document.createElement("input");
    i.type = type; i.value = val || ""; i.placeholder = ph || "";
    i.dataset.k = key; i.autocomplete = "off"; i.spellcheck = false;
    w.appendChild(i);
    return w;
  }
  function syncBadge() {
    var s = settings();
    if (modelBadge) {
      modelBadge.textContent = s.model + (s.key ? "" : " · 未填 Key");
      modelBadge.classList.toggle("warn", !s.key);
    }
  }
  function toggleSet() {
    if (!win) return;
    var open = setWrap.style.display === "none";
    setWrap.style.display = open ? "block" : "none";
  }
  function autogrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  }

  function openWin() {
    if (!win) buildWin();
    win.style.display = "flex";
    win.style.zIndex = String(++zTop);
    placeWin();
    setTimeout(function () { inputEl.focus(); }, 20);
    return true;
  }
  function closeWin() { if (win) win.style.display = "none"; hideFabs(); }

  // 位置：优先用上次拖到的地方，否则默认靠右；都夹在视口内
  function placeWin() {
    var w = win.offsetWidth, h = win.offsetHeight;
    var pos = null;
    try { pos = JSON.parse(load(LS.pos, "")); } catch (e) {}
    var l = pos && typeof pos.l === "number" ? pos.l : Math.max(12, window.innerWidth - w - 24);
    var t = pos && typeof pos.t === "number" ? pos.t : 88;
    win.style.left = Math.max(4, Math.min(l, window.innerWidth - w - 4)) + "px";
    win.style.top = Math.max(4, Math.min(t, window.innerHeight - 40)) + "px";
  }

  function makeDraggable(handle, target) {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener("mousedown", function (ev) {
      if (ev.target.closest("button")) return;          // 点按钮不触发拖动
      dragging = true;
      var r = target.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = ev.clientX; sy = ev.clientY;
      target.style.zIndex = String(++zTop);
      document.body.classList.add("qd-dragging");
      ev.preventDefault();
    });
    window.addEventListener("mousemove", function (ev) {
      if (!dragging) return;
      var w = target.offsetWidth, h = target.offsetHeight;
      var l = Math.max(4, Math.min(ox + ev.clientX - sx, window.innerWidth - w - 4));
      var t = Math.max(4, Math.min(oy + ev.clientY - sy, window.innerHeight - 40));
      target.style.left = l + "px";
      target.style.top = t + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("qd-dragging");
      store(LS.pos, JSON.stringify({ l: target.offsetLeft, t: target.offsetTop }));
    });
  }

  function setPending(text, bi, row, col) {
    pendingQuote = (text || "").slice(0, AI.maxQuoteChars);
    pendingBi = (bi == null) ? null : bi;
    pendingRow = (bi == null || row == null) ? null : row;
    pendingCol = (bi == null || col == null) ? null : col;
    if (ctxLabel) ctxLabel.textContent = AI.ctxEditLabel;
    if (pendingQuote) {
      ctxText.textContent = trunc(pendingQuote, 60);
      ctxChip.style.display = "flex";
    } else {
      ctxChip.style.display = "none";
    }
    if (win && win.style.display !== "none") inputEl.focus();
  }

  function clearThread() {
    if (busy) return;
    thread = [];
    setStatus("");
    renderThread();
  }

  function setStatus(msg, cls) {
    if (!statusEl) return;
    if (!msg) { statusEl.style.display = "none"; statusEl.textContent = ""; return; }
    statusEl.className = "qd-status" + (cls ? " " + cls : "");
    statusEl.textContent = msg;
    statusEl.style.display = "block";
  }

  function renderThread() {
    if (!threadEl) return;
    threadEl.innerHTML = "";
    if (!thread.length) {
      var empty = el("div", "qd-empty");
      empty.appendChild(el("div", null, "选中正文里任意一段 → 点浮起的「问 AI / 改这段」；也可以直接在下面输入。"));
      empty.appendChild(el("div", null, "想弄懂就直接提问；想改写就给出方向（如「补上价格战的因果」「换成结论先行的写法」），AI 会重新起草一版可直接替换的成稿，满意后点「应用到缓冲区」。"));
      threadEl.appendChild(empty);
    }
    thread.forEach(function (t) {
      if (t.role === "user") {
        var ub = el("div", "qd-msg qd-user");
        var ui = el("div", "qd-bubble");
        if (t.quote) {
          var qq = el("div", "qd-quote", trunc(t.quote, 400));
          ui.appendChild(qq);
        }
        ui.appendChild(el("div", "qd-utext", t.text || (t.mode === "edit" ? AI.editNoExtraLabel : "")));
        ub.appendChild(ui);
        threadEl.appendChild(ub);
      } else {
        var ab = el("div", "qd-msg qd-ai");
        var ai = el("div", "qd-bubble");
        var md = el("div", "qd-md");
        md.innerHTML = (t.pending && !t.text) ? "<span class='qd-typing'>正在生成…</span>" : MD.render(t.text);
        ai.appendChild(md);
        if (t.mode === "edit" && !t.pending && t.text && t.bi != null) {
          var confirm = el("div", "qd-edit-confirm");
          confirm.appendChild(el("div", "qd-edit-hint", AI.editConfirmHint));
          var ta = el("textarea", "qd-edit-ta");
          ta.value = cleanEditText(t.text);
          ta.rows = Math.max(8, Math.min(20, Math.ceil(ta.value.length / 30)));
          ta.dataset.key = keyOf(t.bi, t.row, t.col);
          confirm.appendChild(ta);
          var erow = el("div", "qd-edit-row");
          var fmt = el("button", "qd-btn", AI.editFormatLabel);
          fmt.type = "button";
          fmt.addEventListener("click", function () { formatInPlace(ta, fmt); });
          var apply = el("button", "qd-apply", AI.applyBufferLabel);
          apply.type = "button";
          apply.addEventListener("click", function () { applyToBuffer(t, ta, apply); });
          erow.appendChild(fmt);
          erow.appendChild(apply);
          confirm.appendChild(erow);
          ai.appendChild(confirm);
        }
        ab.appendChild(ai);
        threadEl.appendChild(ab);
      }
    });
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  function buildMessages() {
    var msgs = [{ role: "system", content: AI.systemPrompt }];
    thread.forEach(function (t) {
      if (t.error) return;                              // 出错的占位不进上下文
      if (t.role === "user") {
        var content;
        if (t.quote) {
          content = "【选中段落】\n\"\"\"\n" + t.quote + "\n\"\"\"";
          if (t.text) content += "\n\n【我的问题 / 改写方向】" + t.text;
        } else {
          content = t.text || AI.editNoExtraLabel;
        }
        msgs.push({ role: "user", content: content });
      } else if (t.text) {
        msgs.push({ role: "assistant", content: t.text });
      }
    });
    return msgs;
  }

  // 本次编辑会话锁定的目标位置：取对话里第一条带 bi 的轮次（含表格行列）。
  // 有了它，后续追问不必重新选段，也能沿用同一处生成「应用到缓冲区」按钮。
  function editSessionLoc() {
    for (var i = 0; i < thread.length; i++) {
      if (thread[i].bi != null) {
        return { bi: thread[i].bi, row: thread[i].row, col: thread[i].col };
      }
    }
    return { bi: null, row: null, col: null };
  }

  // 缓冲区键：表格格用 "bi:row:col"，普通正文块用 "bi"。与 version.js / app.js 一致。
  function keyOf(bi, row, col) {
    if (bi == null) return null;
    if (row != null && col != null) return bi + ":" + row + ":" + col;
    return String(bi);
  }

  // ── 发送 + 流式接收 ─────────────────────────────────────
  function send() {
    if (busy) return;
    var s = settings();
    if (!s.key) {
      setWrap.style.display = "block";
      var ki = setWrap.querySelector('[data-k="' + LS.key + '"]');
      if (ki) ki.focus();
      setStatus("还没填 API Key：在「设置」里粘贴你的 DeepSeek Key，点「保存设置」再发。", "err");
      return;
    }
    var question = inputEl.value.trim();
    var sess = editSessionLoc();
    var usePending = (pendingBi != null);
    var turnBi = usePending ? pendingBi : sess.bi;
    var turnRow = usePending ? pendingRow : sess.row;
    var turnCol = usePending ? pendingCol : sess.col;
    // 合并后：既没输入问题、又没有选中/沿用中的正文块，才拦下。
    if (!question && turnBi == null) {
      setStatus(AI.editNeedSelection, "err");
      inputEl.focus();
      return;
    }

    setStatus("");
    var turnMode = currentMode;
    thread.push({ role: "user", text: question, quote: pendingQuote, mode: turnMode, bi: turnBi, row: turnRow, col: turnCol });
    pendingQuote = ""; pendingBi = null; pendingRow = null; pendingCol = null; ctxChip.style.display = "none";
    inputEl.value = ""; autogrow();

    var aiTurn = { role: "assistant", text: "", pending: true, mode: turnMode, bi: turnBi, row: turnRow, col: turnCol };
    thread.push(aiTurn);
    renderThread();
    var liveNode = threadEl.querySelector(".qd-msg.qd-ai:last-child .qd-md");

    busy = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "…";

    var url = s.base.replace(/\/+$/, "") + "/chat/completions";
    var raf = null;
    function paint() {
      raf = null;
      if (liveNode) {
        liveNode.innerHTML = MD.render(aiTurn.text);
        threadEl.scrollTop = threadEl.scrollHeight;
      }
    }
    function onDelta(chunk) {
      aiTurn.text += chunk;
      if (!raf) raf = requestAnimationFrame(paint);       // 按帧刷新，避免逐字重排卡顿
    }

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.key },
      body: JSON.stringify({ model: s.model, stream: true, messages: buildMessages() })
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          var detail = t || resp.statusText || "";
          try { var j = JSON.parse(t); if (j && j.error && j.error.message) detail = j.error.message; } catch (e) {}
          throw new Error(statusHint(resp.status) + "（接口 " + resp.status + "：" + detail + "）");
        });
      }
      return readStream(resp, onDelta);
    }).then(function () {
      aiTurn.pending = false;
      if (!aiTurn.text) { failTurn(aiTurn, "（接口没有返回内容）"); }
      else renderThread();
    }).catch(function (err) {
      aiTurn.pending = false;
      var msg = String(err && err.message || err);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        msg = "网络/跨域请求失败：浏览器没拿到 DeepSeek 的响应。常见原因——①断网或 Key/接口地址填错；" +
              "②file:// 直连被跨域(CORS)挡住，可在本目录跑 python -m http.server 后开 http://localhost:8000。原始错误：" + msg;
      }
      failTurn(aiTurn, msg);
    }).then(function () {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      busy = false;
      sendBtn.disabled = false;
      sendBtn.textContent = "发送";
      inputEl.focus();
    });
  }

  // 出错的这一轮：从对话里摘掉空的 assistant 占位，把错误显示在状态条
  function failTurn(turn, msg) {
    var k = thread.indexOf(turn);
    if (k >= 0) thread.splice(k, 1);
    renderThread();
    setStatus(msg, "err");
  }

  // AI 偶尔会不听话地套一层代码围栏，这里只剥掉最外层，保留正文里的 Markdown。
  function cleanEditText(s) {
    var t = String(s == null ? "" : s).replace(/\r\n?/g, "\n").trim();
    var fence = /^```[^\n]*\n([\s\S]*)\n```$/.exec(t);
    if (fence) t = fence[1];
    return t.trim();
  }

  function blockTypeOf(doc, bi) {
    var b = doc && doc.blocks && doc.blocks[bi];
    return b ? b.t : "p";
  }

  // 收集与目标块同类型的其它块原文，供格式规整判断"主导句末标点"。
  function siblingTexts(doc, bi, type) {
    var out = [];
    (doc && doc.blocks ? doc.blocks : []).forEach(function (b, i) {
      if (i === bi) return;
      if (b.t === type && b.x != null && String(b.x)) out.push(String(b.x));
    });
    return out;
  }

  function normalizeForBlock(doc, bi, raw) {
    var idx = Number(bi);
    if (window.QD_FORMAT && typeof window.QD_FORMAT.normalize === "function") {
      var type = blockTypeOf(doc, idx);
      var prev = doc.blocks[idx - 1], next = doc.blocks[idx + 1];
      return window.QD_FORMAT.normalize(raw, type, {
        siblings: siblingTexts(doc, idx, type),
        before: (prev && prev.t === type && prev.x != null) ? String(prev.x) : "",
        after: (next && next.t === type && next.x != null) ? String(next.x) : ""
      });
    }
    return { text: cleanEditText(raw), notes: [] };
  }

  // 按缓冲区键规整：单元格键 "bi:row:col" 走轻量规整（表格格是纯文本，不猜句末标点、不按邻居改字体），
  // 普通块键 "bi" 走带上下文的整段规整。
  function normalizeForKey(doc, key, raw) {
    var parts = String(key == null ? "" : key).split(":");
    if (parts.length === 3) {
      if (window.QD_FORMAT && typeof window.QD_FORMAT.normalize === "function") {
        return window.QD_FORMAT.normalize(raw, "p", { siblings: [], before: "", after: "" });
      }
      return { text: cleanEditText(raw), notes: [] };
    }
    return normalizeForBlock(doc, parts[0], raw);
  }

  function applyToBuffer(turn, ta, btn) {
    if (!window.QD_VERSION || !window.QD_APP || typeof window.QD_APP.getDoc !== "function") {
      setStatus("版本模块还没准备好，无法写入缓冲区。", "err");
      return;
    }
    var doc = window.QD_APP.getDoc();
    if (!doc || doc.id == null) {
      setStatus("当前没有选中的文档。", "err");
      return;
    }
    var key = (ta && ta.dataset && ta.dataset.key) || keyOf(turn.bi, turn.row, turn.col);
    if (key == null) {
      setStatus("没有定位到要替换的正文块或表格格。", "err");
      return;
    }
    var raw = (ta && typeof ta.value === "string") ? ta.value : turn.text;
    var res = normalizeForKey(doc, key, raw);
    var newText = res.text;
    if (!newText) {
      setStatus("内容为空，无法应用。", "err");
      return;
    }
    window.QD_VERSION.stage(doc.id, key, newText);
    if (btn) btn.textContent = AI.applyBufferDoneLabel;
    if (res.notes && res.notes.length) {
      setStatus(AI.editAppliedLabel + "：" + res.notes.join("、"), "");
    }
    if (window.QD_APP.rerender) window.QD_APP.rerender();
  }

  function formatInPlace(ta, btn) {
    if (!window.QD_APP || typeof window.QD_APP.getDoc !== "function") {
      if (btn) { btn.textContent = "不可用"; setTimeout(function () { btn.textContent = AI.editFormatLabel; }, 1500); }
      return;
    }
    var doc = window.QD_APP.getDoc();
    if (!doc) return;
    var res = normalizeForKey(doc, ta.dataset.key, ta.value);
    ta.value = res.text;
    if (btn) {
      btn.textContent = res.notes && res.notes.length ? AI.editFormatDoneLabel : "无需规整";
      setTimeout(function () { btn.textContent = AI.editFormatLabel; }, 1500);
    }
  }

  function statusHint(code) {
    if (code === 401 || code === 403) return "Key 无效或没权限——去「设置」核对 DeepSeek Key 有没有填错。";
    if (code === 402) return "DeepSeek 账户余额不足——去 platform.deepseek.com 充值后再问。这不是 app 的问题：能拿到 402 说明直连、跨域和 Key 都通了。";
    if (code === 429) return "请求太频繁或触发限流——稍等一会儿再试。";
    if (code === 422) return "请求参数不对——检查「模型名」是否填错（默认 deepseek-chat）。";
    if (code >= 500) return "DeepSeek 服务端临时出错——稍后再试。";
    return "接口报错";
  }

  // 读 SSE 流：按行解析 data: {...}，把 delta.content 拼出来
  function readStream(resp, onDelta) {
    var reader = resp.body.getReader();
    var dec = new TextDecoder("utf-8");
    var buf = "";
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        var lines = buf.split("\n");
        buf = lines.pop();
        lines.forEach(function (line) {
          line = line.trim();
          if (!line || line.indexOf("data:") !== 0) return;
          var data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            var j = JSON.parse(data);
            var c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (c) onDelta(c);
          } catch (e) { /* 半个 JSON 或心跳行，忽略 */ }
        });
        return pump();
      });
    }
    return pump();
  }

  // ── 接线 ────────────────────────────────────────────────
  function init() {
    docCol = document.getElementById("doc");
    if (!docCol) return;
    document.addEventListener("mouseup", function () { setTimeout(onSelectionEnd, 0); });
    document.addEventListener("keyup", function (ev) { if (ev.shiftKey) setTimeout(onSelectionEnd, 0); });
    window.addEventListener("scroll", hideFabs, true);
    window.addEventListener("resize", function () { hideFabs(); if (win && win.style.display !== "none") placeWin(); });
    document.addEventListener("mousedown", function (ev) {
      if (fabAsk && ev.target !== fabAsk) hideFabs();
      if (win && win.contains(ev.target)) win.style.zIndex = String(++zTop);   // 点窗口抬到最前
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && win && win.style.display !== "none" &&
          document.activeElement !== inputEl) closeWin();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
