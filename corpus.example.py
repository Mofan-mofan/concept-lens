# -*- coding: utf-8 -*-
"""私有语料清单模板。复制成 corpus.local.py 再改（corpus.local.py 已在 .gitignore 里）。

不复制也行：只跑 `python build.py` 会用空的 DOCS，仓库自带的示例语料照样生成
`data/docs.sample.js`，界面照常能用，只是左侧列表只有示例那一份。

一行 = 一份要盖进阅读器的文稿，三元组是 (业务线, 路径, 显示名)：

- 业务线：左侧列表的分组标题，自己起名，纯展示用；
- 路径：**相对 ROOT（本目录的上一级）**写，支持 .md 与 .csv。
  所以本仓库自带的文件要连目录名一起写，例如 `concept-lens/README.md`；
- 显示名：界面上那份文稿的名字，不用等于文件名。

读不到的路径不会中断构建，会记进 _audit.txt 第三节"读不到的文档"。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DOCS = [
    ("示例", "concept-lens/README.md", "文档调试助手 · 使用说明"),
    ("示例", "concept-lens/ledger/README.md", "账本清单放哪里"),
]

# 想让别人也能重跑 build.py，可以把分档清单放进 ledger/（见 ledger/README.md），
# 或者在这里写死你那份清单的位置：
# LEDGER = os.path.join(ROOT, "概念账本", "你的分档清单.md")

# 公开版词条的四张归一表也写在这里（build.py 只有机制，默认全空）。
# 为什么不写进 build.py：那张表一旦公开，等于把「我藏了哪家公司、改了哪座城市」摊开给人看。
# 判据是同一个 —— 陌生人看到这个词，能不能还原出你的笔记结构或个人处境。
# PUBLIC_GROUPS = {"内部组名": "对外显示名"}          # 分组名 → 公开版显示名
# PUBLIC_GLOSS = [("只在私域笔记里出现的说法", "通用说法")]  # 释义里的措辞替换
# PUBLIC_DROP_FORMS = {"某个你不想公开的专名"}         # 写法命中即整条不进公开版
# PUBLIC_SCAN = ["只有你自己看得懂的词"]              # 生成后自扫：公开版里出现即漏了
