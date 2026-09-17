// 极简 Markdown → HTML 渲染器，零依赖、不联网，专为「问 AI」的回答区服务。
// 安全前提：回答文本来自外部接口，一律先转义 & < > 再套标签，链接只放行 http/https，
// 不把任何原始 HTML 透传出去，所以接口就算返回 <script> 也只会显示成文字。
// 支持：标题、粗体/斜体、行内码、围栏代码块、有序/无序列表、引用、链接、表格、分隔线、段内换行。
window.QD_MD = (function () {
  "use strict";

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 行内：先把 `code` 摘出来保护，其余再做链接/粗体/斜体
  function inline(raw) {
    var parts = String(raw).split(/(`[^`]*`)/g);
    return parts.map(function (p) {
      if (p.length > 1 && p.charAt(0) === "`" && p.charAt(p.length - 1) === "`") {
        return "<code class='md-code'>" + esc(p.slice(1, -1)) + "</code>";
      }
      var s = esc(p);
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        "<a class='md-a' href=\"$2\" target=\"_blank\" rel=\"noopener noreferrer\">$1</a>");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    }).join("");
  }

  function splitRow(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
      .map(function (c) { return c.trim(); });
  }

  var RE_FENCE = /^\s*```/;
  var RE_HR = /^\s*(---+|\*\*\*+|___+)\s*$/;
  var RE_HEAD = /^\s*(#{1,6})\s+(.*)$/;
  var RE_LIST = /^\s*([-*+]|\d+\.)\s+/;
  var RE_SEP = /^\s*\|?[\s:|-]+\|?\s*$/;

  function render(text) {
    if (!text) return "";
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    var out = [], i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (RE_FENCE.test(line)) {                       // 围栏代码块
        var buf = [];
        i++;
        while (i < lines.length && !RE_FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;                                            // 跳过收尾的 ```
        out.push("<pre class='md-pre'><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }        // 空行
      if (RE_HR.test(line)) { out.push("<hr class='md-hr'>"); i++; continue; }

      var h = line.match(RE_HEAD);                      // 标题（聊天气泡里统一压成小标题）
      if (h) { out.push("<div class='md-h'>" + inline(h[2]) + "</div>"); i++; continue; }

      if (/^\s*>/.test(line)) {                         // 引用，合并连续行
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<div class='md-quote'>" + inline(q.join(" ")) + "</div>");
        continue;
      }

      // 表格：本行含 |，下一行是 |---|--- 这种分隔行
      if (/\|/.test(line) && i + 1 < lines.length && /-/.test(lines[i + 1]) && RE_SEP.test(lines[i + 1])) {
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        var t = "<div class='md-tablewrap'><table class='md-table'><thead><tr>";
        head.forEach(function (c) { t += "<th>" + inline(c) + "</th>"; });
        t += "</tr></thead><tbody>";
        rows.forEach(function (r) {
          t += "<tr>";
          for (var ci = 0; ci < head.length; ci++) t += "<td>" + inline(r[ci] || "") + "</td>";
          t += "</tr>";
        });
        t += "</tbody></table></div>";
        out.push(t);
        continue;
      }

      if (RE_LIST.test(line)) {                         // 列表，合并连续项
        var ordered = /^\s*\d+\.\s+/.test(line);
        var items = [];
        while (i < lines.length && RE_LIST.test(lines[i])) { items.push(lines[i].replace(RE_LIST, "")); i++; }
        var tag = ordered ? "ol" : "ul";
        var l = "<" + tag + " class='md-list'>";
        items.forEach(function (it) { l += "<li>" + inline(it) + "</li>"; });
        out.push(l + "</" + tag + ">");
        continue;
      }

      var para = [];                                    // 段落：吃到空行或下一个块级元素为止
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !RE_FENCE.test(lines[i]) &&
             !RE_HEAD.test(lines[i]) && !/^\s*>/.test(lines[i]) && !RE_LIST.test(lines[i]) &&
             !RE_HR.test(lines[i])) { para.push(lines[i]); i++; }
      out.push("<p class='md-p'>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
    return out.join("");
  }

  return { render: render };
})();
