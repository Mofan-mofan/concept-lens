# -*- coding: utf-8 -*-
"""把「概念账本」那张分档表解析成词条库，把各目录的交付物解析成正文库，
产出让浏览器直接 <script src> 引入的两个 JS 文件。

用法：
    cd Documents\\Qoder\\概念透视
    python build.py

设计约束（改动前先读）：
- 概念账本 `01_概念分档清单_*.md` 是词条的**唯一权威源**。这里解析它，不重打一遍，
  所以账本改了词或改了释义，重跑本脚本就会同步。
- 一行 = 一个词条（entry），行里并列的写法收进 forms 数组，共用同一条释义。
  不拆成多条，是为了避免 "PE" 拿到 "PB" 的定义。
- 同形词护栏（guards.js）与补录词条（terms_extra.js）不参与本脚本的写出，
  护栏在浏览器运行时生效，补录词条由本脚本合并进 terms.js。
"""
import csv
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # 上一级目录，账本与文稿都放在这里

# 词条账本的位置。仓库里只放一个通用示例名，真实文件名由 gitignore 掉的
# corpus.local.py 里的 LEDGER 覆盖（开发机上就是它）；clone 的人照 ledger/README.md
# 把自己的分档清单放进 ledger/ 或改这一行即可。
LEDGER = os.path.join(ROOT, "概念账本", "01_概念分档清单.md")
# 公开仓库不带私有账本。想在外面重跑本脚本，把分档清单 md 原样放进 ledger/ 即可。
LEDGER_IN_REPO = os.path.join(HERE, "ledger", os.path.basename(LEDGER))

# ── 公开版词条的措辞归一 ──────────────────────────────────────
# 机制留在本文件，内容不留在本文件：这四张表如果写死在公开的 build.py 里，
# 「被剔除了哪家机构、哪座城市被改写过」本身就是最直接的线索。所以默认全空，
# 真实表格由 gitignore 掉的 corpus.local.py 覆盖（判据：陌生人看到这个词，
# 能不能还原出笔记结构或作者处境。能，就换）。
PUBLIC_GROUPS = {}       # 分组名 → 公开版显示名
PUBLIC_GLOSS = []        # [(原措辞, 替换成)]，作用在 gloss 上
PUBLIC_DROP_FORMS = set()  # 写法命中即整条不进公开版
PUBLIC_SCAN = []         # 生成后自扫：公开版里还出现这些词就说明漏了

# 语料清单分两处：私有语料在 corpus.local.py（不进仓库），仓库自带的示例语料见下面 SAMPLE_DOCS。
DOCS = []
_corpus = os.path.join(HERE, "corpus.local.py")
if os.path.exists(_corpus):
    _ns = {"__file__": _corpus}
    with io.open(_corpus, encoding="utf-8") as _f:
        exec(compile(_f.read(), _corpus, "exec"), _ns)
    DOCS = _ns.get("DOCS", DOCS)
    LEDGER = _ns.get("LEDGER", LEDGER)
    for _k in ("PUBLIC_GROUPS", "PUBLIC_GLOSS", "PUBLIC_DROP_FORMS", "PUBLIC_SCAN"):
        globals()[_k] = _ns.get(_k, globals()[_k])


# 仓库自带的演示语料，路径相对本脚本所在目录，会写进 data/docs.sample.js。
# 与上面 DOCS 的区别：这一份是随仓库公开的，所以只放自己写的、不含私有内容的文件。
# 本机装了私有语料时优先用 docs.js；没有（比如 Pages）就回退到这份。
SAMPLE_DOCS = [
    # 演示用：第一项是界面默认打开的那份。放一篇全是行业词的短文，
    # 首屏就能看到标注效果；README 讲工具本身，几乎没有可标的词，排后面。
    ("示例", "samples/demo-storage-and-gao.md", "示例文稿 · 存储与宽禁带片段"),
    ("示例", "README.md", "文档调试助手 · 使用说明"),
]

STUB_DOCS = []  # 读不到的文件登记在此，写进体检报告


def load_js_json(path, varname):
    """从 `window.VAR = <json>;` 形式的文件里抠出那个 JSON 值。

    不用正则匹配整个数组：注释里出现 `[` 会把贪婪匹配带偏。
    改成定位变量名，再从它后面第一个 [ 或 { 起 raw_decode。
    """
    if not os.path.exists(path):
        return None
    with io.open(path, encoding="utf-8-sig") as f:
        blob = f.read()
    # 变量名可能在文件头的说明里原样出现过，所以从后往前逐个尝试，取第一个能解析的
    spots = [m.end() for m in re.finditer(re.escape(varname), blob)]
    if not spots:
        raise ValueError("%s 里找不到变量 %s" % (os.path.basename(path), varname))
    last_err = None
    for at in reversed(spots):
        eq = blob.find("=", at)
        if eq < 0:
            continue
        cands = [p for p in (blob.find("[", eq), blob.find("{", eq)) if p >= 0]
        if not cands:
            continue
        try:
            val, _ = json.JSONDecoder().raw_decode(blob[min(cands):])
            return val
        except Exception as ex:
            last_err = ex
    raise ValueError("%s 的 %s 解析失败：%s" % (os.path.basename(path), varname, last_err))


# ---------------------------------------------------------------- 账本解析

def strip_stars(cell):
    """返回 (★ 数量, 去掉星号后的文本)。账本用 ★ 表示「不懂就会卡住」，★★ 更强。"""
    n = 0
    s = cell.strip()
    while s.startswith("★"):
        n += 1
        s = s[1:]
    return n, s.strip()


SPLIT_TOP = re.compile(r"\s*·\s+")


def split_forms(text):
    """把一个概念单元格拆成若干「表层写法」。

    先按 · 切（不要求两侧都有空格——账本里「产能（万片/月）· 12 英寸」的 · 前面
    紧贴括注，要求空格会切成「产能· 12 英寸」这种残缺写法）。
    不按 ／ 切："6／8／12 英寸" 按 ／ 切会碎成 "6"、"8"；只把 ／ 两边都像词的收进别名。
    括号里的内容当别名收下（KGD（Known-Good-Die）），但纯数字或单字丢掉
    （（010）（100）晶向 会变成噪声）。
    """
    forms = []
    parens = []

    def harvest_parens(s):
        for m in re.finditer(r"[（(]([^（()）]{2,20})[)）]", s):
            inner = m.group(1)
            for part in re.split(r"[／/、]", inner):
                part = part.strip()
                if len(part) >= 2 and not re.fullmatch(r"[\d.]+", part):
                    parens.append(part)
        return re.sub(r"[（(][^（()）]{2,20}[)）]", "", s)

    def take(piece):
        piece = piece.strip(" ·、")
        if not piece:
            return
        cleaned = harvest_parens(piece).strip(" ·、")
        if cleaned and len(cleaned) >= 2 and "·" not in cleaned:
            forms.append(cleaned)
        for part in re.split(r"[／/]", cleaned):
            part = part.strip(" ·、")
            if part != cleaned and len(part) >= 2 and not re.fullmatch(r"[\d.]+", part):
                parens.append(part)

    for chunk in SPLIT_TOP.split(text):
        for piece in re.split(r"\s+vs\.?\s+", chunk):
            take(piece)

    seen, out = set(), []
    for f in forms + parens:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def parse_freq(raw):
    """"270·1区" → 270；"72／45／7" → 124（三个并列写法的次数和）。只取数字，取不到给 0。"""
    nums = [int(n) for n in re.findall(r"(?<!\d)(\d{1,5})(?!\d)", raw.replace("区", ""))]
    return sum(nums) if nums else 0


TABLE_ROW = re.compile(r"^\|(.+)\|\s*$")


def cells_of(line):
    m = TABLE_ROW.match(line.strip())
    if not m:
        return None
    # 表格里的 ** 会整块包住一个词，使解析出的写法带上星号；浏览器渲染时会先把 **
    # 拆成格式片段，两边文本必须一致，所以这里统一去掉强调标记。
    cs = [re.sub(r"\*+", "", c).strip() for c in m.group(1).split("|")]
    if cs and all(re.fullmatch(r":?-{2,}:?", c or "---") for c in cs):
        return None  # 分隔行
    return cs


def parse_c_item(item):
    """第七节的名单条目 → (名字, 次数, 它是谁)。

    账本里同一格里混着三种写法：TrendForce(39) ／ 哈勃投资（华为 CVC）(2)
    ／ 闪迪（没次数没注解）。所以不能指望一条正则，先把所有括号内容收集起来分类。
    """
    inner = re.findall(r"[（(]([^（()）]*)[）)]", item)
    base = re.split(r"[（(]", item)[0].strip(" ·、")
    cnt, notes = 0, []
    for p in inner:
        p = p.strip()
        m = re.match(r"^(\d{1,4})\s*(?:[,，:：]\s*(.+))?$", p)
        if m:
            cnt = int(m.group(1))
            if m.group(2):
                notes.append(m.group(2).strip())
        elif p:
            notes.append(p)
    return base, cnt, "；".join(notes)


def parse_ledger():
    """扫账本 markdown，产出 (entries, must_skip_words)。"""
    ledger = LEDGER if os.path.exists(LEDGER) else LEDGER_IN_REPO
    if not os.path.exists(ledger):
        raise SystemExit(
            "找不到概念分档清单。本机路径 %s 与仓库内 %s 都不存在。\n"
            "把账本那份 01_概念分档清单_*.md 放进 ledger/，或改 build.py 顶部的 LEDGER。"
            % (LEDGER, LEDGER_IN_REPO))
    with io.open(ledger, encoding="utf-8-sig") as f:
        lines = f.read().splitlines()

    entries = []
    must = []
    tier = None       # A1 / A2 / ... / B1 / B2 / C
    in_must = False
    fence = False

    for ln in lines:
        if ln.strip().startswith("```"):
            fence = not fence
            continue
        if fence:
            continue

        h = re.match(r"^##+\s*(.+)$", ln)
        if h:
            t = h.group(1)
            in_must = t.startswith("八、")
            m = re.match(r"^[一二三四五六七八九十〇]+、\s*([AB]?\d?)\s*档", t)
            if "B1 · 存储" in t:
                tier = "B1"
            elif "B2 · 氧化镓" in t:
                tier = "B2"
            elif m and m.group(1):
                tier = m.group(1) if len(m.group(1)) > 1 else m.group(1)
                if tier.startswith("A") or tier in ("B",):
                    tier = tier
            else:
                tier = tier if t.startswith(("一", "二", "三", "四", "五", "六")) else None
            if re.match(r"^[一二三四五六七八九十〇]+、", t):
                key = t[0]
                tier = {"一": "A1", "二": "A2", "三": "A3", "四": "A4", "五": "A5",
                        "六": "B", "七": "C", "八": None}.get(key, tier)
            continue

        if in_must:
            for w in re.findall(r"`([^`]+)`", ln):
                must.append(w)
            continue

        cs = cells_of(ln)
        if not cs or not tier:
            continue

        if tier == "C":
            # 第七节形状不同：类别 | 一堆用 · 隔开的名字（附次数与注解）
            if len(cs) < 2 or cs[0].startswith("类别"):
                continue
            group = cs[0]
            for item in re.split(r"\s*·\s*", cs[1]):
                name, cnt, note = parse_c_item(item.strip())
                if len(name) < 2:
                    continue
                entries.append({
                    "id": "C%03d" % (len(entries) + 1),
                    "tier": "C", "group": group, "star": 0,
                    "forms": [name], "gloss": note, "freq": cnt,
                    "freqraw": str(cnt) if cnt else "",
                    "where": "第七节", "must": False,
                })
            continue

        # A / B 档表：概念 | 一句话 | 实测 [| 定位]
        if len(cs) < 3 or cs[0] in ("概念", "---"):
            continue
        star, concept = strip_stars(cs[0])
        forms = split_forms(concept)
        if not forms:
            continue
        entries.append({
            "id": "%s%03d" % (tier, len(entries) + 1),
            "tier": tier, "group": "", "star": star,
            "forms": forms, "gloss": cs[1].strip(),
            "freq": parse_freq(cs[2]),
            "freqraw": cs[2].strip(),
            # 三列的表（B1／B2）没有「定位」列，别把实测那一格当成定位
            "where": cs[3].strip() if len(cs) > 3 else "",
            "must": star >= 2,
        })

    return entries, must


# ---------------------------------------------------------------- 正文解析

def md_runs(text):
    """把行内 markdown 拆成带格式的片段，供逐段标注（URL 与行内代码不标）。"""
    runs = []
    pat = re.compile(
        r"(\*\*[^*]+\*\*)"
        r"|(`[^`]+`)"
        r"|(\[[^\]]*\]\([^)]*\))"
    )
    pos = 0
    for m in pat.finditer(text):
        if m.start() > pos:
            runs.append((text[pos:m.start()], ""))
        tok = m.group(0)
        if tok.startswith("**"):
            runs.append((tok[2:-2], "b"))
        elif tok.startswith("`"):
            runs.append((tok[1:-1], "code"))
        else:
            lm = re.match(r"\[([^\]]*)\]\(([^)]*)\)", tok)
            runs.append((lm.group(1), "link"))
            runs.append((" (" + lm.group(2) + ")", "url"))
        pos = m.end()
    if pos < len(text):
        runs.append((text[pos:], ""))
    return runs


def parse_md(path, doc_id):
    """markdown → 块序列。块带 heading 路径，界面据此做「跳回它在哪一节」。"""
    with io.open(path, encoding="utf-8-sig") as f:
        lines = f.read().splitlines()

    blocks = []
    fence = False
    buf = []
    tbl = []

    def flush_p():
        if buf:
            t = " ".join(x.strip() for x in buf).strip()
            if t:
                blocks.append({"t": "p", "x": t})
            del buf[:]

    def flush_t():
        if not tbl:
            return
        rows = [cells_of(r) for r in tbl]
        rows = [r for r in rows if r]
        if rows:
            head = rows[0]
            body = rows[1:] if len(rows) > 1 else []
            if re.fullmatch(r"[-\s:|]+", "".join(head)):
                head, body = [], body
            blocks.append({"t": "table", "h": head, "r": body})
        del tbl[:]

    for ln in lines:
        if ln.strip().startswith("```"):
            fence = not fence
            if fence:
                flush_p()
                flush_t()
                blocks.append({"t": "code_open"})
            else:
                blocks.append({"t": "code_close"})
            continue
        if fence:
            blocks.append({"t": "code", "x": ln})
            continue
        s = ln.strip()
        if not s:
            flush_p()
            flush_t()
            continue
        if s.startswith("|"):
            flush_p()
            tbl.append(s)
            continue
        flush_t()
        hm = re.match(r"^(#{1,6})\s*(.+)$", s)
        if hm:
            flush_p()
            lvl = len(hm.group(1))
            title = re.sub(r"\*+", "", hm.group(2)).strip()
            blocks.append({"t": "h", "l": lvl, "x": title})
            continue
        lm = re.match(r"^[-*+]\s+(.+)$", s) or re.match(r"^\d+[.、]\s*(.+)$", s)
        if lm:
            flush_p()
            blocks.append({"t": "li", "x": lm.group(1).strip()})
            continue
        if re.fullmatch(r"[-*_]{3,}", s):
            flush_p()
            blocks.append({"t": "hr"})
            continue
        if s.startswith(">"):
            flush_p()
            blocks.append({"t": "quote", "x": s.lstrip("> ").strip()})
            continue
        buf.append(s)

    flush_p()
    flush_t()

    # 按序回放一遍，给每个块挂上它当时真正所在的章节链
    open_heads = {}
    for b in blocks:
        if b["t"] == "h":
            open_heads[b["l"]] = b["x"]
            for k in list(open_heads):
                if k > b["l"]:
                    del open_heads[k]
        b["path"] = [open_heads[k] for k in sorted(open_heads)
                     if k <= (b.get("l") or 99)]
    return blocks


def parse_csv(path, doc_id):
    with io.open(path, encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.reader(f) if any((c or "").strip() for c in r)]
    if not rows:
        return []
    head, body = rows[0], rows[1:]
    return [{"t": "table", "h": head, "r": body, "path": []}]


# ---------------------------------------------------------------- 匹配

CJK = re.compile(r"[^\x00-\xff]")


def term_regex(form):
    """与账本那份词频统计同一口径：英文数字按词边界，中文按子串。
    半角空格允许「有或没有」，这样 "S 基金" 也能命中 "S基金"。
    """
    if re.fullmatch(r"[A-Za-z0-9 ._+\-／/()]+", form):
        esc = re.escape(form).replace(r"\ ", r"[\s ]?")
        return re.compile(r"(?<![A-Za-z0-9])" + esc + r"(?![A-Za-z0-9])", re.IGNORECASE)
    return re.compile(re.escape(form))


SENT_END = re.compile(r"(?<=[。！？；?!;])|(?<=[；;])|\n")


def block_text(b):
    if b["t"] in ("h", "p", "li", "quote", "code"):
        return b.get("x", "")
    if b["t"] == "table":
        return " ".join(" ".join(r) for r in ([b.get("h") or []] + b.get("r", [])))
    return ""


def find_in(text, rx):
    return [m for m in rx.finditer(text)]


def sentence_of(text, start, end, span=60):
    a = max(0, start - span)
    z = min(len(text), end + span)
    return ("…" if a > 0 else "") + text[a:z].replace("\n", " ") + ("…" if z < len(text) else "")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    entries, must_words = parse_ledger()

    # 补录词条：账本没覆盖、但在语料里会撞上的金融词（尤其 S4/S6 那几条条款名）
    extra = load_js_json(os.path.join(HERE, "hand", "terms_extra.js"), "QD_EXTRA_TERMS") or []
    for e in extra:
        e.setdefault("star", 0)
        e.setdefault("must", False)
        e.setdefault("freq", 0)
        e.setdefault("freqraw", "")
        e.setdefault("where", "")
        e.setdefault("group", "")
        entries.append(e)

    guards = load_js_json(os.path.join(HERE, "hand", "guards.js"), "QD_GUARDS") or {}
    guard_rx = {k: (re.compile(v["require"], re.I) if v.get("require") else None,
                    re.compile(v["exclude"], re.I) if v.get("exclude") else None,
                    int(v.get("ctx", 24)))
                for k, v in guards.items()}

    # 一个写法只归一个词条：高档位优先（A>B>C）。账本里 imec、申万 既在 A/B 也进了 C。
    by_form = {}
    rank = {"A1": 1, "A2": 1, "A3": 1, "A4": 1, "A5": 1, "B1": 2, "B2": 2, "C": 3}
    for e in entries:
        for fm in e["forms"]:
            cur = by_form.get(fm)
            if cur is None or rank[e["tier"]] < rank[cur["tier"]]:
                by_form[fm] = e

    # 词条按最长写法排前面，浏览器排 alternation 时也是长词优先
    entries.sort(key=lambda e: -max(len(x) for x in e["forms"]))

    def must_hit(word, form):
        """第八节的词和表格行的写法往往不完全一致，归一化后做包含判定。"""
        a = word.replace(" ", "").replace("　", "")
        b = form.replace(" ", "").replace("　", "")
        if len(a) < 2 or len(b) < 2:
            return False
        return a in b or b in a or (len(a) >= 4 and a[:4] in b)

    for i, e in enumerate(entries):
        e["idx"] = i
        if any(must_hit(w, fm) for w in must_words for fm in e["forms"]):
            e["must"] = True

    # 第八节列了、但在所有词条写法里都对不上号的，如实报出来（别当成已覆盖）
    unmatched_must = [w for w in must_words
                      if not any(must_hit(w, fm) for e in entries for fm in e["forms"])]

    # 合并成一个正则扫一遍，别对每块文本跑上千次。写法按长度降序排，
    # 让长词先吃：否则「外延」会把「同质外延」拦腰截断。
    owner_lc = {}
    alts = []
    for fm in sorted(by_form, key=lambda x: -len(x)):
        owner_lc.setdefault(fm.lower(), fm)
        if re.fullmatch(r"[A-Za-z0-9 ._+\-／/()]+", fm):
            alts.append(r"(?<![A-Za-z0-9])" + re.escape(fm).replace(r"\ ", r"[\s ]?") + r"(?![A-Za-z0-9])")
        else:
            alts.append(re.escape(fm))
    RX = re.compile("|".join(alts), re.IGNORECASE)

    def guard_ok(fm, text, a, z):
        g = guard_rx.get(fm)
        if not g:
            return True, ""
        req, exc, ctx = g
        w = text[max(0, a - ctx):z + ctx]
        if req and not req.search(w):
            return False, "require 未满足"
        if exc and exc.search(w):
            return False, "exclude 命中"
        return True, ""

    def build_docs(doc_list, base, stubs):
        """按 (业务线, 相对 base 的路径, 显示名) 生成正文库，并统计每个词条的命中。

        私有语料与仓库示例语料走的是同一套匹配逻辑，差别只在输入清单和基准目录。
        """
        docs = []
        audit = []      # (form, tier, star, doc, path, quote)
        blocked = []    # 被护栏挡掉的，单列一节看护栏有没有过火
        for area, rel, name in doc_list:
            p = os.path.join(base, rel.replace("/", os.sep))
            if not os.path.exists(p):
                stubs.append(rel)
                continue
            blocks = parse_csv(p, name) if rel.endswith(".csv") else parse_md(p, name)

            d = {
                "id": "d%02d" % len(docs),
                "name": name,
                "area": area,
                "path": rel,
                "blocks": blocks,
                "count": {},   # entry idx -> 通过护栏后的出现次数
                "quote": {},   # entry idx -> 首处命中的原句（语境证据）
            }
            for bi, b in enumerate(blocks):
                if b["t"].startswith("code"):
                    continue
                txt = block_text(b)
                if not txt:
                    continue
                for m in RX.finditer(txt):
                    fm = owner_lc.get(m.group(0).lower())
                    if not fm:
                        continue
                    e = by_form[fm]
                    q = sentence_of(txt, m.start(), m.end())
                    ok, why = guard_ok(fm, txt, m.start(), m.end())
                    if not ok:
                        blocked.append((fm, e["tier"], name, b.get("path"), q, why))
                        continue
                    k = str(e["idx"])
                    d["count"][k] = d["count"].get(k, 0) + 1
                    if k not in d["quote"]:
                        d["quote"][k] = {"b": bi, "s": " › ".join((b.get("path") or [])[-2:]), "q": q}
                    audit.append((fm, e["tier"], e["star"], name, b.get("path"), q))
            d["nchars"] = sum(len(block_text(b)) for b in blocks)
            docs.append(d)
        return docs, audit, blocked

    docs, audit, blocked = build_docs(DOCS, ROOT, STUB_DOCS)
    sample_stubs = []
    sample_docs, _sample_audit, _sample_blocked = build_docs(SAMPLE_DOCS, HERE, sample_stubs)

    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)

    with io.open(os.path.join(HERE, "data", "terms.js"), "w", encoding="utf-8") as f:
        f.write("// 本文件由 build.py 自动生成，请勿手改。改词条 → 改《概念账本》那份清单后重跑。\n")
        f.write("// 内含指向本机私有文档的定位字段，已被 .gitignore 排除，不要提交。\n")
        f.write("window.QD_TERMS = ")
        json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    # 公开版词条。界面只读 gloss / tier / group / freq / star / forms，where 一个都不显示，
    # 但它指的是我本机的私有笔记，够陌生人还原出笔记结构和处境，所以公开版整列抹掉。
    public = []
    dropped = 0
    for e in entries:
        if any(fm in PUBLIC_DROP_FORMS for fm in e["forms"]):
            dropped += 1
            continue
        p = dict(e)
        p.pop("where", None)
        if p.get("src"):
            p["src"] = p["src"].split("·")[0]
        if p.get("group") in PUBLIC_GROUPS:
            p["group"] = PUBLIC_GROUPS[p["group"]]
        g = p.get("gloss", "")
        for a, b in PUBLIC_GLOSS:
            g = g.replace(a, b)
        p["gloss"] = g
        public.append(p)

    with io.open(os.path.join(HERE, "data", "terms.public.js"), "w", encoding="utf-8") as f:
        f.write("// 公开版词条，由 build.py 生成，请勿手改。改词条 → 改《概念账本》清单或\n")
        f.write("// hand/terms_extra.js 后重跑 python build.py。\n")
        f.write("// 与本机那份 data/terms.js 是同一条库，只少了指向私有文档的定位字段、\n")
        f.write("// 并改写了释义里少量涉及个人处境的措辞。\n")
        f.write("// 浏览器拿不到 data/terms.js（私有版，不随仓库发布）时回退到这一份。\n")
        f.write("window.QD_TERMS_PUBLIC = ")
        json.dump(public, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    leftover = [w for w in PUBLIC_SCAN
                if any(w in json.dumps(p, ensure_ascii=False) for p in public)]
    print("公开版词条：%d 条（本机 %d 条，整条去掉 %d 条）→ data/terms.public.js；残留私域词 %s"
          % (len(public), len(entries), dropped, leftover if leftover else "0 处"))

    with io.open(os.path.join(HERE, "data", "docs.js"), "w", encoding="utf-8") as f:
        f.write("// 本文件由 build.py 自动生成，请勿手改。加文档 → 改 build.py 的 DOCS 后重跑。\n")
        f.write("// 内含本机私有文稿全文，已被 .gitignore 排除，不要提交。\n")
        f.write("window.QD_DOCS = ")
        json.dump(docs, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    with io.open(os.path.join(HERE, "data", "docs.sample.js"), "w", encoding="utf-8") as f:
        f.write("// 由 build.py 从仓库自带的 SAMPLE_DOCS 生成，内容全部来自本仓库，可安全公开。\n")
        f.write("// 浏览器拿不到 data/docs.js（私有语料，不随仓库发布）时回退到这一份。\n")
        f.write("window.QD_DOCS_SAMPLE = ")
        json.dump(sample_docs, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    with io.open(os.path.join(HERE, "_audit.txt"), "w", encoding="utf-8") as f:
        f.write("# 命中体检。每个通过护栏的命中都带原句，肉眼过一遍就知道哪些是同形词误标。\n")
        f.write("# 判法：把误标的写法抄进 hand/guards.js 的 require/exclude，重跑本脚本。\n")
        f.write("# 护栏改完不必重跑也能生效（浏览器运行时也读同一份 guards.js），\n")
        f.write("# 但本表是回归核对的依据。\n\n")
        by_term = {}
        for fm, tier_, star_, dn, path, ctx in audit:
            by_term.setdefault((tier_, fm.lower()), []).append((dn, path, ctx, star_))
        f.write("=== 一、通过的命中（按档位、写法分组）===\n")
        for k in sorted(by_term):
            rows = by_term[k]
            f.write("\n### %s %s   命中 %d 处\n" % (k[0], k[1], len(rows)))
            for dn, path, ctx, star_ in rows[:12]:
                sec = " › ".join(path[-2:]) if path else "—"
                f.write("    [%s·%s] %s\n" % (dn, sec, ctx))
            if len(rows) > 12:
                f.write("    … 另有 %d 处\n" % (len(rows) - 12))
        f.write("\n\n=== 二、被护栏挡掉的命中（看护栏有没有过火）===\n")
        if not blocked:
            f.write("（无。要么没配护栏，要么配得正好）\n")
        bb = {}
        for fm, tier_, dn, path, ctx, why in blocked:
            bb.setdefault(fm, []).append((dn, ctx, why))
        for fm in sorted(bb):
            rows = bb[fm]
            f.write("\n### %s   挡掉 %d 处\n" % (fm, len(rows)))
            for dn, ctx, why in rows[:10]:
                f.write("    [%s·%s] %s\n" % (dn, why, ctx))
        f.write("\n\n=== 三、结构体检 ===\n")
        f.write("第八节列了、但表格里找不到对应行的词：%s\n" % ("、".join(unmatched_must) or "无"))
        f.write("读不到的文档：%s\n" % ("、".join(STUB_DOCS) or "无"))

    tA = len([e for e in entries if e["tier"].startswith("A")])
    tB = len([e for e in entries if e["tier"].startswith("B")])
    tC = len([e for e in entries if e["tier"] == "C"])
    print("词条 %d 条（A 档 %d ／ B 档 %d ／ C 档 %d），写法 %d 个"
          % (len(entries), tA, tB, tC, len(by_form)))
    print("文档 %d 份，读不到 %d 份" % (len(docs), len(STUB_DOCS)))
    print("示例语料 %d 份（写进 data/docs.sample.js）%s"
          % (len(sample_docs), "，读不到：" + "、".join(sample_stubs) if sample_stubs else ""))
    print("通过命中 %d 处；被护栏挡掉 %d 处" % (len(audit), len(blocked)))
    print("第八节 12 词里未对上表行的：%s" % ("、".join(unmatched_must) or "无"))
    if STUB_DOCS:
        print("缺失文件：" + "、".join(STUB_DOCS))
    for d in docs:
        print("  %-3s %-26s %6d 字  命中词条 %d"
              % (d["id"], d["name"], d["nchars"], len(d["count"])))


if __name__ == "__main__":
    main()
