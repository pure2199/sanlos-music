# T135 —— 发版 v0.4.6（代理层故障分类 ＋ 封面落盘保留 ＋ 歌单面板排序 / 分页）

> ⚠ **本文件是规格**（发版前写死「要做什么、怎么验、什么算过」），
> **执行记录**在 §六，**真机复验结论**在 §五 —— 两者**分开写**，
> 免得「事后补的结论」看起来像「事先就知道」。

---

## 一、这一版发什么（**8 项**，**3 项用户能直接感知**）

`v0.4.5..HEAD` 共 **7 个 commit**（其中 2 个是 v0.4.5 的**发版后回填**，纯文档）：

| # | 来源 | 改了什么 | 用户看得见什么 |
|---|---|---|---|
| ① | `df4c68a` | 代理层故障**分类**（信封加 `proxy` 标记 ＋ 渲染层分流） | NAS 连不上 / 超时 ⇒ 说「连不上音乐服务」（**可重试**）；**会话失效 ⇒ 真的回登录页**（以前卡在「已登录、但每个请求都失败」）；服务端业务码**语义一点没变** |
| ② | `56e5bed`（D-2） | 扫描落盘**保留已知的专辑封面** ＋ 三态（未知 / 确认没有） | 「有声」页补拉到的封面**不再被扫描冲掉**（以前每次进来都要重拉、卡片永远是占位图） |
| ③ | `e8f5cc1` | 「加入歌单」面板加**排序 / 分页** | 面板里的歌单可**按名称 / 更新时间排序**、**每页 20 条**；**搜索或换排序自动回第 1 页** |
| ④ | `56e5bed`（D-1 / D-3 / D-4） | mock server 端口分配、README `### Code signing policy` ＋ `.github/CODEOWNERS`、`pack.cjs` 跨卷 EXDEV | **不影响使用**（开发期 / 打包期） |
| ⑤ | `587ea7d` | T119 端点表 `reconnect-check` 订正 | **不影响使用**（文档；按「历史段不篡改」**原表保留不动** ＋ 紧邻处加订正 ＋ 钉子） |
| ⑥ | `6ad36b9` | 「取消排队中的任务」那条用例改成**等条件** | **不影响使用**（测试；**断言一条没改**） |
| ⑦ | `b848625` / `999ecb8` | v0.4.5 的**发版后回填** | —— |

⚠ **③ 的真实账号验不了**：该账号 `playlist/list` 实测 **`total=0`** ⇒ 面板走**空态**
⇒ 排序下拉与分页控件**根本不渲染**（源码：两者都在 `playlists.length > 0` 分支里）
⇒ 真机**不可观测** ⇒ 由自动化（`test/t132-playlist-panel-sort-paging.test.tsx`，**11 条**）覆盖，**不假装真机验过**。

⚠ **① 的「故障注入」那一支真机验不了**：要故意断网 / 让 token 过期才观测得到
⇒ 真机只验「**正常路径不受影响**」（其余 9 项就是正常路径的全面回归）。

---

## 二、发版链（**每一步都有证据**）

### 1. 版本号（**四处必须同步**）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `package.json` | `version` 0.4.5 ⇒ **0.4.6**（**只 1 行**） | LF |
| `package-lock.json` | root `version` **两处** ⇒ 0.4.6 | LF |
| `README.md` | 整篇 0.4.5 ⇒ 0.4.6（**12 处**，**逐条审过**：全是「当前版本」引用） | LF |
| `docs/changelog.md` | 「当前版本」行 ＋ 「未发布」段 ⇒ **新增** `## 0.4.6 —— 2026-11-21` 段（**历史段一字不动**） | **CRLF** |
| `docs/releases/v0.4.6.md` | **新增**（CI 的 Release 正文来源 ⇒ **缺它工作流直接 `throw`**） | LF |

⚠ **`package-lock.json` 必须同步**：CI 第一步是 `npm ci` ⇒ 不同步**直接失败**。
⚠ **README 那 12 处**逐条审过，含「**v0.4.5 及更早的产物未做代码签名**」⇒ 改后为
「**v0.4.6 及更早**」（v0.4.6 **同样未签名**，所以这句仍然成立）。
⚠ **changelog 的历史段一个字都不动**（`## 0.4.5 —— 2026-11-20` 必须仍在）。

### 2. 注解 tag ＋ 推分支

- `git tag -a v0.4.6 -F release/verify/tag-msg-v0.4.6.txt` ⇒ tag 对象 → 发版 commit；
- `git push origin sanlos-music` ＋ `git push origin v0.4.6`；
- 已验：远端有 tag；tag 内 `package.json` version = 0.4.6；tag 内 `docs/releases/v0.4.6.md` 存在。

⚠ **tag 必须先推送，再 dispatch** —— 工作流第一步就是
`actions/checkout` with `ref: ${{ inputs.tag }}` ⇒ **tag 不存在 ⇒ 直接失败**。

### 3. 网页 dispatch（**没有 `gh` CLI、没有 token ⇒ 只能走网页**）

工作流 `.github/workflows/release.yml`，三个输入：

| 输入 | 这次取什么 | 为什么 |
|---|---|---|
| `tag` | `v0.4.6` | 要发布的标签 |
| `pack_only` | **取消勾选**（`false`） | 勾上 = 只打包，**不建 Release** |
| `sign` | **取消勾选**（`false`） | SignPath 申请已被拒 ⇒ 走**未签名**路径 |

⚠⚠ **两个勾选框默认都是勾上的**（工作流里 `default` 都是 `true`）
⇒ **不手动取消就提交，必然失败**在 `Check SignPath configuration`。
⚠ **按 id 选 checkbox**（`input#_r_p_` / `input#_r_q_`）—— 同名元素里有一个
`type=hidden` 的（`name` 相同）⇒ 按 `name` 的 CSS 选择器会命中那个 hidden ⇒ `uncheck` 报
「target is not a checkbox」。

### 4. CI 期望路径（**未签名**）

`npm ci` → `tsc --noEmit` → `npm test` → `npm run build` → `node scripts/pack.cjs`
→ 上传 `unsigned-artifacts` → （跳过 SignPath 全部步骤）
→ `Verify unsigned artifacts --expect none` → `Write update manifest (unsigned)`
→ `Normalize asset names` → `Attest build provenance` → `Prepare release notes with checksums`
→ `Publish GitHub Release`（`gh release create` ⇒ **CI 自动建 Release 并上传 3 个资产**）。

⇒ **不需要手写网页表单**：工作流自己会建 Release。
⚠ 但**资产名会被归一**（`SanlosMusic-Setup-0.4.6.exe`，**去空白**）
⇒ GitHub 上不会出现带空格的下载 URL（带空格会 404）。
⚠ **正文 = `docs/releases/v0.4.6.md` ＋ CI 追加的 sha256 表 ＋ 「怎么确认这个安装包是官方的」**
⇒ 事后本地补的「已装版复验」段**不在**线上正文里 ⇒ 要**另行同步**（走网页编辑页）。

---

## 三、发版**前**的真机复验（**闸门**）

⚠ **为什么要先验**：v0.4.4 是「先发版、再装版复验」⇒ 万一有坑，**已经发出去了**。
⇒ 这次先**用自打产物**做一轮，**过了再发**；发版**后**再装版复验一轮（验的是**真正发出去的产物**）。

| 手段 | 为什么这么选 |
|---|---|
| `pack:probe`（输出到 `release-probe/`，**gitignored**） | 打出**带新代码**的产物；**不装** ⇒ **零注册表副作用**（不覆盖 HKCU 卸载项、不动已装目录） |
| 跑暂存目录里的 `win-unpacked/Sanlos Music.exe` | 就是安装器要装的那份 exe ⇒ **口径等价** |
| ⚠ **产物路径按 asar 里的版本号挑**（不看目录名） | `win-unpacked` 可能因目录被占用而**留在暂存目录**（`.pack-staging-<时间戳>/`）⇒ **只看输出目录会验错版本**（实测：输出目录躺的是 11-04 的旧包，asar 版本 0.1.0） |
| **隔离 userData**（临时目录，只复制 `session.bin` ＋ `Local State`） | **真实账号 ＋ 真 NAS**，但**不碰**真实偏好 / 下载目录 / 扫描状态 |
| 走 `sanlos://srv/...` | **不碰任何凭证**（token 只在主进程内存里） |
| **静音**（`setAudioMuted(true)`） | 位置照走，但机器不出声 |

⚠ **打包前先查「已装程序在不在跑」** —— 在跑就别覆盖它的目录（**不替用户杀进程**）。

### 复验清单（**11 项**：**10 项通过 ＋ 1 项真机不可观测**）

| # | id | 验什么 |
|---|---|---|
| 1 | `ep-init` | 探针：`/initialization/state` |
| 2 | `ep-suggest` | 探针：`/search/suggest`（固定 top-5 ＋ 带 score） |
| 3 | `ep-shared` | 探针：`/shared-library/list` |
| 4 | `ui-init` | 界面：连接页「音乐服务：已初始化」 |
| 5 | `ui-shared` | 界面：共享页列出共享库并能浏览 |
| 6 | `ui-suggest` | 界面：搜索页建议区出现 |
| 7 | **`ui-cover-persist`** | **界面：「有声」页补拉的封面，重扫后还在**（T131-D2）⇒ 判据**有鉴别力**：修复前重扫会把 `albumCoverId` 写成「未知」⇒ 页面每次都要重拉 |
| 8 | **`ui-playlist-panel`** | **界面：「加入歌单」面板能打开**（真实账号 ⇒ 空态） |
| 9 | **`ui-playlist-sort`** | **界面：排序 / 分页控件** ⇒ ⚠ 真实账号 0 个歌单 ⇒ **不渲染** ⇒ 如实记 **skip** |
| 10 | `ui-discover` | 界面：发现页榜单先出（命中异步补） |
| 11 | `ui-resume-flush` | 界面：退出前补写「上次播放」（**最后一项**：它会关掉应用） |

---

## 四、验收点

| 项 | 判据 |
|---|---|
| 版本号 | `package.json` / `package-lock.json` / `README.md` / `changelog.md` **全部是 0.4.6**，**没有残留的 0.4.5**（历史 changelog 段除外） |
| 回归 | `tsc` **0 错**；Vitest **全绿**；Playwright **全绿**；`npm run build` exit **0** |
| 字节体检 | `t115-10-bytes-check-all.mjs` ⇒ **bad=0** |
| blob 行尾 | 本次提交的 blob **全 LF、无 BOM**（`core.autocrlf=true` ⇒ blob 一律 LF） |
| 探针产物 | 暂存目录里 `app.asar` 内 `package.json` version = **0.4.6** |
| 真机复验 | 逐项有结论（**通过 / 不通过 / 真机验不了并标注**） |
| Release | 存在、`draft=false`、`prerelease=false`、资产**恰好 3 个** |
| sha256 | **Release 正文表格** ＝ **资产 API 的 digest** ＝ **本地下载后实算** ⇒ **三个来源一致** |
| attestation | `Summary (attestation)` 成功 ⇒ 有构建来源证明页面 |
| 装版 | `D:\Sanlos Music\Sanlos Music.exe` FileVersion = **0.4.6**；`session.bin` **逐字未变**；注册表卸载项 = `Sanlos Music 0.4.6`（HKCU） |

---

## 五、真机复验状态

> ⚠ **发版前**那一轮（自打产物）的逐项结论。
> ⚠ **真机验不了的**必须**如实标注**，不许含糊过去。

⚠ 手段：**隔离 userData** ＋ **真实 NAS**（FN 中继）＋ `sanlos://srv/...` ＋ **静音**。
⚠ 探针产物：`.pack-staging-1795193397331/win-unpacked`（asar 版本 **0.4.6**）。
⚠ ⚠ **输出目录 `release-probe/win-unpacked` 躺的是旧包**（asar 版本 0.1.0）⇒ **按 asar 版本号挑**。

| # | id | 实测 | 结论 |
|---|---|---|---|
| 1 | `ep-init` | `code=0`；`initialized=true` | ✅ |
| 2 | `ep-suggest` | 各 **5** 条，共 **15** 条、**15** 条带 `score` | ✅ |
| 3 | `ep-shared` | **2** 个共享库 | ✅ |
| 4 | `ui-init` | 「已初始化」；提示条 **0** | ✅ |
| 5 | `ui-shared` | **2** 个库；进去 **11** 个子目录 | ✅ |
| 6 | `ui-suggest` | **1861 ms** 出现；错误条 **0** | ✅ |
| 7 | `ui-cover-persist` | 落盘 **9** 条已知封面 ⇒「**从头重扫**」⇒ **仍 9** 条、**丢 0** 条 | ✅ |
| 8 | `ui-playlist-panel` | 面板能打开；空态文案正确 | ✅ |
| 9 | `ui-playlist-sort` | ⚠ **真机不可观测**（0 个歌单 ⇒ 控件不渲染） | ⏭ |
| 10 | `ui-discover` | 榜单 **301 ms** 出来；命中 **15511 ms** 后补 | ✅ |
| 11 | `ui-resume-flush` | 退出前 `…819519` ⇒ 退出后 `…826554`（**变新**） | ✅ |

**合计：10 通过 / 0 失败 / 1 不可观测。**

⚠ **这一轮踩的坑（已在 `docs/calibration.md` 第一百一十五节记全）**：
第一轮封面那项点的是「**扫描这个目录**」⇒ 走**断点续跑** ⇒ **不会重写落盘** ⇒ 判据**没有鉴别力**
⇒ 改点「**从头重扫**」（`scan({ full: true })`）后才有鉴别力。

---

## 六、执行记录（**待回填**）

### 1. commit 与 tag

（待回填）

### 2. 发版实测（CI run 号 / asset / attestation）

（待回填）

### 3. 装版实测

（待回填）

---

## 七、遗留 / 待办

- ⏳ **v0.4.6 的线上 Release 正文同步**（本地补的「已装版复验」段不在 CI 生成的正文里
  ⇒ 走网页编辑页补 ⇒ 行尾会被网页表单统一成 CRLF ⇒ **字节 sha256 与本地不同属预期**）；
- ⏳ **歌单面板排序 / 分页** 的**真机**复验（真实账号 `playlist/list` `total=0` ⇒ 面板是空态
  ⇒ **控件不渲染** ⇒ 真机不可观测）⇒ 需要一个**有歌单的账号**才能验；
- ⏳ **代理层故障分类**的**故障注入**那一支（网络故障 / 会话失效）在真机上**未验**
  ⇒ 由自动化（`test/proxy.test.ts`、`test/api-client.test.ts`）覆盖；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU** ⇒ 要回按机器需 `/allusers`。
