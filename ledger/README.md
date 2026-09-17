# 这里放什么

`build.py` 的词条只有一个权威源：那份《概念分档清单》markdown。
开发机上它在仓库外面（同级目录的账本文件夹），所以本仓库不带它 ——
生成结果已经提交，随仓库发布的是公开版 `data/terms.public.js`，
所以双击 `index.html` 或打开 Pages 都能直接用，不必跑脚本。

想在自己机器上重跑 `python build.py`（加词、改释义），先把账本弄到本地，再二选一：

- 把分档清单原样放进本目录（`ledger/`），并让 `build.py` 顶部的 `LEDGER` 指到它；
- 或者仿 `corpus.example.py` 造一份 `corpus.local.py`，在里面写一行
  `LEDGER = os.path.join(...)`。这个文件在 `.gitignore` 里，适合放只属于你本机的路径。

放对了会打印词条账目；没找到时脚本会直接告诉你它找过哪两个路径。

还有一条补词的路：账本没覆盖、但你在别处会撞上的词，走 `hand/terms_extra.sample.js`
（复制成 `terms_extra.js` 再改）。它同样是本机文件——公开产物里看得到结果，看不到源。

清单的格式要求见 `build.py` 顶部的「设计约束」注释：一行一个词条，
并列写法收进同一个 `forms` 数组共用一条释义，档位用小节标题（A1／A2／…／B1／B2／C）划分。
