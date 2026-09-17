// 所有可调参数都在这一个文件里。想改行为先来这里，不要去改 js/mark.js。
window.QD_CONFIG = {

  // ── 档位 ────────────────────────────────────────────────
  // 判据沿用《概念账本》第〇节：A = 换个赛道还在；B = 换赛道即失效；C = 它是名字不是概念。
  tier: {
    A: { label: "A 档", full: "行业方向通用", color: "#1d4ed8", bg: "#e8efff",
         hint: "换个赛道它还在。必须懂。" },
    B: { label: "B 档", full: "特定赛道", color: "#b45309", bg: "#fff2df",
         hint: "出了这条赛道就用不上。只学你当前要看的那条线。" },
    C: { label: "C 档", full: "低频专名", color: "#4b5563", bg: "#f0f1f3",
         hint: "它不是概念，是名字。不背，查得到就行。" }
  },
  // B 档两个子档。B1 是示例报告用的存储线，B2 是建库名单用的氧化镓线。
  subtier: {
    A1: "证据与建库口径", A2: "融资与股权", A3: "财务与估值", A4: "行研方法与写作",
    A5: "半导体业态与链位", B1: "存储赛道", B2: "氧化镓与宽禁带", C: "专名备查"
  },

  // ── 标注密度 ────────────────────────────────────────────
  // 「不要标注太多」这件事由这三层共同保证，不是只调一个数：
  //   allowTiers  哪些档位允许进正文（C 档默认不进，只在侧栏和搜索里出现）
  //   perTermCap  同一个**写法**在一篇里最多标几次（不是同一个词条：账本有
  //               「原厂 · 颗粒 · 模组 · 主控」这种一行四词的合并行，按词条分名额
  //               会让排在后面的词一次都标不上）。重复标「口径」77 次是最主要的刷屏源
  //   perSegCap   同一个自然段/同一个表格格里最多标几个
  //   perMilleCap 全局兜底：每 1000 字最多几个标记，超了按优先级从后往前删
  levels: {
    lean: { name: "精简", note: "只标 ★（不懂就会卡住的那批）",
            allowTiers: ["A", "B"], starOnly: true, perTermCap: 1, perSegCap: 2, perMilleCap: 6 },
    std:  { name: "标准", note: "A、B 档全标，C 档不进正文",
            allowTiers: ["A", "B"], starOnly: false, perTermCap: 2, perSegCap: 4, perMilleCap: 14 },
    full: { name: "全量", note: "含 C 档专名，用来核对有没有漏登记的词",
            allowTiers: ["A", "B", "C"], starOnly: false, perTermCap: 3, perSegCap: 6, perMilleCap: 30 }
  },
  defaultLevel: "lean",

  // 一个词的优先级：★ 数、是否属于第八节「不许跳过」、它在本篇出现几次、写法长度。
  // 权重只用来决定「名额不够时留下谁」，调大调小不会改变「谁有资格被标」。
  rank: { starW: 100, mustW: 60, countW: 1, lenW: 2, tierW: { A: 30, B: 10, C: 0 } },

  // ── 匹配 ───────────────────────────────────────────────
  match: {
    minCjkLen: 2,      // 单字中文写法一律不收（会在任何词里命中）
    asciiBoundary: true // 英文与数字写法按词边界，避免 PE 命中 COMPANY
  },

  // ── 界面文案 ────────────────────────────────────────────
  text: {
    title: "文档调试助手",
    subtitle: "导入金融/行研文档 → 看关键词 → AI 辅助调试修订",
    searchPlaceholder: "搜概念，如：口径 / 合同负债 / HBM / 富加镓业",
    emptySearch: "账本里没有这个词。它只有 1 个字的概率不低——先试试全称。",
    noDoc: "左边选一份文稿开始。",
    boundary: "边界：本工具只标注与检索《概念账本》里已登记的词，不自动发现新词。"
              + "遇到没被标出来又看不懂的词，说明账本缺条目，去把它的行补上再重跑 build.py。",

    // ── 词条「概念解释」区 ──────────────────────────────
    // 点开词后的主释义改为：让 DeepSeek 给一段简洁的通俗概念介绍（与「问 AI」共用 Key）。
    // 这些文案只给 js/app.js 用，不在数据层做 UI 判断。
    webTitle: "概念解释",
    webLoading: "生成简洁解释中…",
    webNotLoaded: "解释模块未加载，刷新页面后再试。",
    webFailedLabel: "解释生成失败",
    webRetry: "重试",
    webSettings: "设置解释 Key",
    webSettingsSaved: "已保存",
    webClearCache: "清除本词缓存",
    webSettingsPrompt: "粘贴 DeepSeek Key（与「问 AI」共用；留空=清除已保存 Key，取消=不改动）。Key 只存本机 localStorage，不写进代码和仓库。"
  },

  // 侧栏「概览」里最多列几个词，超出折叠。
  sidebarMaxTerms: 40,

  // ── 选中提问 / AI 问答 ──────────────────────────────────
  // 用法：在正文里用鼠标选中一段 → 冒出「问 AI」浮标 → 点开弹框，输入你的问题 →
  //       框里直接显示 DeepSeek 的回答。逻辑全在 js/ask.js，样式在 css/ask.css。
  // 这里只放非机密的默认值。API Key 不写进代码（这仓库是公开的），由你在 app 里
  // 填一次，存在浏览器 localStorage——换电脑或清缓存后要重填，直连方案下 Key 只在你本机。
  ai: {
    enabled: true,
    defaultBase: "https://api.deepseek.com",  // OpenAI 兼容；末尾的 /chat/completions 由代码补
    defaultModel: "deepseek-chat",
    fabLabel: "问 AI / 改这段",                // 选中后浮标上的字（问答与改写已合并为一个入口）
    minChars: 2,                               // 选中少于这个字数不弹浮标，避免误触单字
    maxQuoteChars: 4000,                       // 带进提问的原文最多这么长，超了截断（省 token）
    // 合并后的系统提示：同一个窗口既能答疑、也能按方向改写选中段，按用户这一轮的意图来。
    // 注意：本文件随仓库发布。想按自己的背景加一句，改了本地用就好，别提交。
    systemPrompt:
      "你在帮一位集成电路 / 半导体方向的学习者处理他文稿里选中的那一段。这个窗口既能答疑、也能改写，请按他这一轮的意图来：" +
      "① 如果他在提问（想弄懂某个概念、某句话、某处逻辑），用简体中文通俗、结构化作答：先直接回答，再结合选中的原文具体解释；遇到专有名词，顺带点一句它是「换个赛道还在」的行业通用概念，还是只在某条赛道成立的特定概念。" +
      "② 如果他在给改写方向（如「补上价格战的因果」「换成结论先行的写法」「加一段中下游机会」），把选中段当靶子和起点、不要照抄复述：按方向重新组织论点、调用你已掌握的行业知识补充相关事实与论证，写出一段观点更清楚、数据/逻辑更扎实、可直接替换原文的完整成稿。这可能是多轮讨论，每轮结合上文给出一版新的完整段落，而不是只改几个字；此时每次只输出这段改好的正文本身，不要解释你改了什么、不要加引号、不要加 Markdown 代码围栏。" +
      "涉及具体数字或事实没把握时，明说不确定或给区间，绝不编造。",
    modeTag: "问答 / 改写",
    ctxEditLabel: "选中这段",
    inputPlaceholder: "提问，或给出重写方向（Enter 发送，Shift+Enter 换行）",
    editNoExtraLabel: "（按方向重写这段）",
    editNeedSelection: "改写需要先选中一段正文；只想提问也可以直接输入问题。",
    applyBufferLabel: "应用到缓冲区",
    applyBufferDoneLabel: "已放入缓冲区",
    editFormatLabel: "格式规整",
    editConfirmHint: "若这是改写稿，可在此确认或微调，再点「应用到缓冲区」；若只是问答，忽略这个框即可。",
    editAppliedLabel: "已按格式规整并放入缓冲区",
    editFormatDoneLabel: "已规整"
  },

  // ── 版本管理与编辑缓冲区 ──────────────────────────────
  // 只把「待应用的局部修改」和「历史版本快照」存在浏览器 localStorage，
  // 不写回 data/ 目录；双击 index.html 的原始语料永远还在。
  version: {
    generate: "生成新版本",
    history: "历史版本",
    export: "导出当前版 .md",
    clearBuffer: "清空缓冲区",
    generateTitle: "把缓冲区里的修改套用到当前文档，生成一个新版本。",
    historyTitle: "历史版本",
    exportTitle: "下载当前显示版本的 Markdown 文件。",
    clearBufferTitle: "只清空待应用修改，不影响历史版本。",
    stagedMark: "改",
    pendingNewTag: "待应用改动（点「生成新版本」后才替换正文）",
    pendingEditHint: "可在此直接改；点「生成新版本」时自动按前后上下文匹配格式与字体。",
    viewChange: "查看改动",
    undoChange: "撤销这处",
    original: "原始版本",
    restore: "回退到此版本",
    close: "关闭",
    currentVersion: "当前 v{ver}",
    bufferCount: "缓冲 {n} 处",
    noBuffer: "缓冲 0 处",
    emptyCommit: "缓冲区是空的：先选中一段正文（或表格里的一格），用「问 AI / 改这段」生成改写并点「应用到缓冲区」。",
    commitOk: "已生成新版本 v{ver}。",
    commitSkipped: "已生成新版本 v{ver}；有 {n} 处修改未应用（代码段、或跨多格/整表的选中暂不支持一键改写）。",
    allSkipped: "没有可应用的修改：代码段和跨多格/整表的选中暂不支持一键改写，缓冲区已保留。",
    restoreOk: "已回退到 v{ver}，当前正文已重渲染。",
    confirmClear: "确定只清空缓冲区里的待应用修改吗？历史版本不会被删。",
    cleared: "缓冲区已清空。",
    noVersions: "还没有历史版本。",
    exportEmpty: "当前文档没有可导出的内容。",
    diffTitle: "原文 vs 新文",
    diffOld: "原文",
    diffNew: "改写后"
  },

  // 搜索结果最多列几条
  searchMaxHits: 60
};
