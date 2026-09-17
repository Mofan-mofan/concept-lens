// 补录词条的模板。真正的输入是 hand/terms_extra.js —— 那个文件不随仓库发布，
// 因为它每条都带一个 where 字段，指的是我本机的私有笔记。它的内容已经并进了
// 公开产物 data/terms.public.js，所以线上照样能用，只是改不了源。
//
// 想在自己机器上补词：把本文件复制成 terms_extra.js，往数组里加行，
// 然后重跑 python build.py（会同时重写 data/terms.js 与 data/terms.public.js）。
//
// 格式必须是 window.QD_EXTRA_TERMS = [ …… ]; 且数组部分是合法 JSON，
// 因为 build.py 要用正则把这段 JSON 抠出来。注释可以写，别写进数组里。
//
// 字段：id 唯一 / tier A1…A5|B1|B2|C / star 0=普通 1=不懂会卡住 /
//       forms 所有表层写法（第一个当显示名）/ gloss 一句话释义 /
//       where 该去哪读上下文（只对本机那份生效，公开版会抹掉）/
//       group 归组 / src 标记来源
//
// 下面两条是随手举个例子，不是给你的答案 —— 复制走以后把它们换掉。
window.QD_EXTRA_TERMS = [
{"id": "S001", "tier": "A2", "star": 1, "group": "条款", "src": "示例", "where": "",
 "forms": ["TS", "投资意向书", "条款书"],
 "gloss": "Term Sheet，签约前的意向文件。多数条款无约束力，但排他期和保密条款通常有。它的价值不在金额，在「谁保护谁」的条款组合"},
{"id": "S002", "tier": "A3", "star": 0, "group": "指标", "src": "示例", "where": "",
 "forms": ["ROE", "净资产收益率"],
 "gloss": "净利润 ÷ 净资产，衡量赚钱效率。但它可以被高杠杆推高，所以要拆开看：利润率 × 周转率 × 权益乘数，三块各代表一种生意"}
];
