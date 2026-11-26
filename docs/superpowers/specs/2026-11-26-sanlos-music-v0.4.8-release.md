# T139 —— 发版 v0.4.8（「最近」页不再整页溢出）

> ⚠ **本文件是规格**（发版前写死「要做什么、怎么验、什么算过」），
> **执行记录**在 §六，**真机复验结论**在 §五 —— 两者**分开写**，
> 免得「事后补的结论」看起来像「事先就知道」。

---

## 一、这一版发什么（**1 项**，**用户能直接感知**）

`v0.4.7..HEAD` 的**功能**改动只有 **1 笔**（T138）：

| # | 来源 | 改了什么 | 用户看得见什么 |
|---|---|---|---|
| ① | `b40a495` | **「最近」页的布局修复**：`src/pages/history-page.css` 的高度约束（根容器 `flex:1 1 auto` ＋ `min-height:0`、本机段 `flex:0 0 auto` ＋ `max-height:240px`、NAS 段 `flex:1 1 0` ＋ `min-height:120px`、段标题 / 说明行 `flex:0 0 auto`）＋ `HistoryPage.tsx` 两段各加一个修饰类（`--local` / `--nas`）＋ `paging-notice.css` 提示条 `flex:0 0 auto` ＋ **新增** CSS 契约单测与真几何 E2E | 「最近」页**不再整页多出 394px 的滚动**；NAS 播放历史列表**不再伸到播放条底下**（末尾几行看得见了）；两段列表**各自按高度分配**，窗口拖到最小也不消失 |

⚠ **本版的判据是「几何」的** ⇒ 既有断言**一条不删、一条不弱化**；
新增两层守卫：**CSS 契约单测**（钉住每条声明在不在）＋ **真几何 E2E**（钉住整页不溢出 / 列表自己滚 / 不被压住）。

⚠ **T138 的取证结论也一并带进这一版**（不改代码，只是把「适配 OK」写进发布说明）：
fnOS 更新后 **9 个端点全部 `http=200` ＋ `code=0`**、响应形状未变 ⇒ **播放器仍然适配**。

---

## 二、发版链（**每一步都有证据**）

### 1. 版本号（**四处必须同步**）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `package.json` | `version` 0.4.7 ⇒ **0.4.8**（**只 1 行**） | LF |
| `package-lock.json` | root `version` **两处** ⇒ 0.4.8 | LF |
| `README.md` | 整篇 0.4.7 ⇒ 0.4.8（**12 处**，**逐条审过**：全是「当前版本」引用） | LF |
| `docs/changelog.md` | 「当前版本」行 ＋ 「未发布」段 ⇒ **正式** `## 0.4.8 —— 2026-11-26` 段（**历史段一字不动**） | **CRLF** |
| `docs/releases/v0.4.8.md` | **新增**（CI 的 Release 正文来源 ⇒ **缺它工作流直接 `throw`**） | LF |

⚠ **`package-lock.json` 必须同步**：CI 第一步是 `npm ci` ⇒ 不同步**直接失败**。
⚠ **README 那 12 处**逐条审过，含「**v0.4.7 及更早的产物未做代码签名**」⇒ 改后为
「**v0.4.8 及更早**」（v0.4.8 **同样未签名**，所以这句仍然成立）。
⚠ **changelog 的历史段一个字都不动**（`## 0.4.7 —— 2026-11-22` 必须仍在）。
⚠ **导语的件数必须与表格实际行数一致**（T135 踩过）⇒ 本轮**自己**核了一遍（1 件事 / 1 行）。

### 2. 注解 tag ＋ 推分支

- `git tag -a v0.4.8 -F release/verify/tag-msg-v0.4.8.txt` ⇒ tag 对象 → 发版 commit；
- `git push origin sanlos-music` ＋ `git push origin v0.4.8`；
- 已验：远端有 tag；tag 内 `package.json` version = 0.4.8；tag 内 `docs/releases/v0.4.8.md` 存在。

⚠ **tag 必须先推送，再 dispatch** —— 工作流第一步就是
`actions/checkout` with `ref: ${{ inputs.tag }}` ⇒ **tag 不存在 ⇒ 直接失败**。

### 3. 网页 dispatch（**没有 `gh` CLI、没有 token ⇒ 只能走网页**）

工作流 `.github/workflows/release.yml`，三个输入：

| 输入 | 这次取什么 | 为什么 |
|---|---|---|
| `tag` | `v0.4.8` | 要发布的标签 |
| `pack_only` | **取消勾选**（`false`） | 勾上 = 只打包，**不建 Release** |
| `sign` | **取消勾选**（`false`） | SignPath 申请已被拒 ⇒ 走**未签名**路径 |

⚠⚠ **两个勾选框默认都是勾上的**（工作流里 `default` 都是 `true`）
⇒ **不手动取消就提交，必然失败**在 `Check SignPath configuration`。
⚠ **按 id 选 checkbox**（`input#_r_p_` / `input#_r_q_`）—— 同名元素里有一个
`type=hidden` 的（`name` 相同）⇒ 按 `name` 的 CSS 选择器会命中那个 hidden ⇒ `uncheck` 报
「target is not a checkbox」。
⚠⚠ **GitHub 复选框的 `aria-checked` 会骗人** ⇒ 必须读 DOM 的 **checked 属性** ＋ 顺带看隐藏域 value。

### 4. CI 期望路径（**未签名**）

`npm ci` → `tsc --noEmit` → `npm test` → `npm run build` → `node scripts/pack.cjs`
→ 上传 `unsigned-artifacts` → （跳过 SignPath 全部步骤）
→ `Verify unsigned artifacts --expect none` → `Write update manifest (unsigned)`
→ `Normalize asset names` → `Attest build provenance` → `Prepare release notes with checksums`
→ `Publish GitHub Release`（`gh release create` ⇒ **CI 自动建 Release 并上传 3 个资产**）。

⇒ **不需要手写网页表单**：工作流自己会建 Release。
⚠ 但**资产名会被归一**（`SanlosMusic-Setup-0.4.8.exe`，**去空白**）
⇒ GitHub 上不会出现带空格的下载 URL（带空格会 404）。
⚠ **正文 = `docs/releases/v0.4.8.md` ＋ CI 追加的 sha256 表 ＋ 「怎么确认这个安装包是官方的」**
⇒ 事后本地补的「已装版复验」段**不在**线上正文里 ⇒ 要**另行同步**（走网页编辑页）。

---

## 三、发版**前**的真机复验（**闸门**）

⚠ **为什么要先验**：v0.4.4 是「先发版、再装版复验」⇒ 万一有坑，**已经发出去了**。
⇒ 这次先**用自打产物**做一轮，**过了再发**；发版**后**再装版复验一轮（验的是**真正发出去的产物**）。

| 手段 | 为什么这么选 |
|---|---|
| `pack:probe`（输出到 `release-probe-048/`，**gitignored**） | 打出**带新代码**的产物；**不装** ⇒ **零注册表副作用**。⚠ 上一轮的 `release-probe/`（788 MB）**被文件监听器锁住、删不掉** ⇒ 这一轮换新目录，**不绕过可恢复删除** |
| 跑输出目录里的 `win-unpacked/Sanlos Music.exe` | 就是安装器要装的那份 exe ⇒ **口径等价** |
| ⚠ **产物路径按 asar 里的版本号挑**（不看目录名） | 目录可能因被占用而**留在暂存目录** ⇒ **只看输出目录会验错版本** |
| **隔离 userData**（临时目录，只复制 `session.bin` ＋ `Local State`） | **真实账号 ＋ 真 NAS**，但**不碰**用户真实偏好 / 下载目录 / 扫描状态 |
| 走 `sanlos://srv/...` | **不碰任何凭证**（token 只在主进程内存里） |
| **静音**（`setAudioMuted(true)`） | 位置照走，但机器不出声 |

⚠⚠ **打包会联网下工具链（**环境事实**，T139-02c）**：
electron-builder 需要 `winCodeSign`（含 `rcedit`，改 exe 图标 / 元数据）与 NSIS 工具链
⇒ 本机缓存里**只有 NSIS / 7z / icons，缺 winCodeSign** ⇒ 必须联网下一次。
⚠ **它只认环境变量**：`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`
（或 `npm_config_*` 同名变量）⇒ 仓库 `.npmrc` 里那份镜像配置**只有在经 npm 启动时**才生效，
而打包脚本是**直接 `node` 调 CLI**（不过 npm）⇒ **镜像没生效 ⇒ 回落 GitHub ⇒ 直连超时**。
⇒ **实测**：T137 当天 GitHub 可达 ⇒ 打包成功；本轮 GitHub 不通 ⇒
`connect ETIMEDOUT 57.155.223.240:443`（＝ github.com 的 IP）。
⇒ **解法**：给**探针打包脚本**注入这两个镜像环境变量（**只改 gitignored 的本地工具**，
**不动** `scripts/pack.cjs` / `electron-builder.yml` ⇒ **CI 与正式产物的口径不变**）。
⚠ **镜像可信**：builder 自带**官方 sha256**，镜像上的同名文件实测 sha256 **完全一致**
（`winCodeSign-2.6.0.7z` = `cdaec715…43a4`）⇒ 校验仍由 builder 自己执行，内容与官方一致。
⚠ electron 本体走镜像时**命中已有缓存**（`fb5e87f4…` = `https://npmmirror.com/mirrors/electron/v32.3.3`）
⇒ **不重复下 113 MB**。

⚠ **打包前先查「已装程序在不在跑」** —— 在跑就别覆盖它的目录（**不替用户杀进程**）。

### 复验清单（**13 项**：**12 项通过 ＋ 1 项真机不可观测**）

| # | id | 验什么 |
|---|---|---|
| 1 | `ep-init` | 探针：`/initialization/state` |
| 2 | `ep-suggest` | 探针：`/search/suggest`（固定 top-5 ＋ 带 score） |
| 3 | `ep-shared` | 探针：`/shared-library/list` |
| 4 | `ui-init` | 界面：连接页「音乐服务：已初始化」 |
| 5 | `ui-shared` | 界面：共享页列出共享库并能浏览 |
| 6 | `ui-suggest` | 界面：搜索页建议区出现 |
| 7 | `ui-cover-persist` | 界面：「有声」页补拉的封面，重扫后还在（T131-D2，**防倒退**） |
| 8 | `ui-playlist-panel` | 界面：「加入歌单」面板能打开（T132，**防倒退**） |
| 9 | `ui-playlist-sort` | 界面：排序 / 分页控件（T132）⇒ ⚠ 真实账号 **0 个歌单** ⇒ **不渲染** ⇒ 如实记 **skip** |
| 10 | `ui-discover` | 界面：发现页榜单先出（命中异步补） |
| 11 | `ui-about-no-icp` | 界面：「关于」页没有备案号（v0.4.7 的改动，**防倒退**） |
| 12 | **`ui-history-layout`** | **界面：「最近」页**不整页溢出**、列表**自己滚**、末尾几行**不被播放条压住**（**T139 本版唯一的用户可感知变化**）⇒ 判据**三条同时**成立 |
| 13 | `ui-resume-flush` | 界面：退出前补写「上次播放」（**最后一项**：它会关掉应用） |

⚠ **本版的判据也是「负向」的**：`asar` 里**不该**再有**缺陷版那条 CSS 规则**
⇒ 「正向标志命中」**证明不了**布局真修好了 ⇒ 另配一条**负向判据**（不许有）＋
**几何层**的真机判据（`ui-history-layout`）。

---

## 四、验收点

| 项 | 判据 |
|---|---|
| 版本号 | `package.json` / `package-lock.json` / `README.md` / `changelog.md` **全部是 0.4.8**，**没有残留的 0.4.7**（历史 changelog 段除外） |
| 回归 | `tsc` **0 错**；Vitest **全绿**；Playwright **全绿**；`npm run build` exit **0** |
| 字节体检 | `t115-10-bytes-check-all.mjs` ⇒ **bad=0** |
| blob 行尾 | 本次提交的 blob **全 LF、无 BOM**（`core.autocrlf=true` ⇒ blob 一律 LF） |
| 探针产物 | `app.asar` 内 `package.json` version = **0.4.8**；**asar 里没有「ICP备」/「备案号」**（防倒退）；**也没有缺陷版那条「最近」页 CSS**（**本版负向标志**）；正向标志全部命中 |
| 真机复验 | 逐项有结论（**通过 / 不通过 / 真机验不了并标注**） |
| Release | 存在、`draft=false`、`prerelease=false`、资产**恰好 3 个** |
| sha256 | **Release 正文表格** ＝ **资产 API 的 digest** ＝ **本地下载后实算** ⇒ **三个来源一致** |
| attestation | `Summary (attestation)` 成功 ⇒ 有构建来源证明页面 |
| 装版 | `D:\Sanlos Music\Sanlos Music.exe` FileVersion = **0.4.8**；`session.bin` **逐字未变**；注册表卸载项 = `Sanlos Music 0.4.8`（HKCU）、**无 0.4.7 残留** |

---

## 五、真机复验状态

> ⚠ **发版前**那一轮（自打产物）的逐项结论。
> ⚠ **真机验不了的**必须**如实标注**，不许含糊过去。

⚠ 手段：**隔离 userData** ＋ **真实 NAS**（FN 中继）＋ `sanlos://srv/...` ＋ **静音**。

<!-- t139-03b:section5 -->

| # | id | 实测 | 结论 |
|---|---|---|---|
| 1 | `ep-init` | `GET /initialization/state` → `http=200`、`code=0`、`initialized=true` | ✅ |
| 2 | `ep-suggest` | `GET /search/suggest?q=音乐` → 歌曲 / 专辑 / 歌手各 **5** 条（`playlist` **0**），共 **15** 条、**15** 条带 `score`（首条「音乐节」，score `2.1869769849590033`） | ✅ |
| 3 | `ep-shared` | `GET /shared-library/list` → `http=200`、`code=0`、**2** 个共享库（`/vol02/1000-0-3d135437`、`/vol1/1000/music/music`） | ✅ |
| 4 | `ui-init` | 连接页显示「**已初始化**」；未初始化提示条 **0** 条 | ✅ |
| 5 | `ui-shared` | 「共享」页列出 **2** 个库（1000-0-3d135437、music）；点进去 **11** 个子目录 | ✅ |
| 6 | `ui-suggest` | 搜索建议 **1335 ms** 出现；歌曲 5 ＋ 专辑 5 ＋ 歌手 5；错误条 **0** | ✅ |
| 7 | `ui-cover-persist` | 「有声」页补拉后落盘 **9** 条已知封面；点「**从头重扫**」后**仍是 9** 条、**丢了 0** 条 | ✅ |
| 8 | `ui-playlist-panel` | 「加入歌单」面板能打开；真实账号 **0** 个歌单 ⇒ 空态「还没有歌单 —— 先到「歌单」页新建一个」 | ✅ |
| 9 | `ui-playlist-sort` | ⚠ **真机不可观测**：真实账号 `playlist/list` 实测 **0** 个歌单 ⇒ 面板走空态 ⇒ 排序下拉与分页控件**不渲染** ⇒ 由自动化 `test/t132-playlist-panel-sort-paging.test.tsx`（**11** 条）覆盖 | ⏭ |
| 10 | `ui-discover` | 榜单 **317 ms** 出来（**4** 个榜）；命中数 **21502 ms** 后补上（25/50、9/50、0/50、0/50） | ✅ |
| 11 | `ui-about-no-icp` | 「关于」页备案号元素 **0** 个、整块**没有**「备案」/「ICP备」字样；而**开发者 `pure2199` / 公司「广西闪链时空网络科技有限公司」/ 官网**都还在（页面显示「版本 v0.4.8」） | ✅ |
| 12 | `ui-history-layout` | **文档高 761 == 视口高 761**（整页不滚）；NAS 列表视口可视 **201**px、内容 **672**px（**自己在滚**）；视口底边 **630** ≤ 播放条上沿 **696**；状态行「NAS 播放历史：已加载 14 / 14」⇒ **三条判据同时成立** | ✅ |
| 13 | `ui-resume-flush` | 退出前 `updatedAt=1795684006830` ⇒ 退出后读到 **1795684013856**（**变新了** ⇒ 退出那一刻被重写过） | ✅ |

**合计：12 项通过 / 0 项失败 / 1 项真机不可观测（如实标注）。**

⚠ **证据文件**：`release/verify/t139-04-realmachine-result.json`（第 2 轮）、
`release/verify/t139-04-realmachine-result.run1.json`（第 1 轮，**含那一项失败**）、
`release/verify/t139-03a-shared-diag.json`（对照诊断的逐 500ms 采样）。

### ⚠ 第 1 轮跑出过**一次**失败（`ui-shared`），已定位为**偶发**，**不是本版回归**

- **现象**：第 1 轮里 `.sanlos-shared__item` **一度出现、随后消失** ⇒ 脚本的 `waitFor` 通过了，
  但随后的 `click` 扑空（Playwright 报错只有 `waiting for locator(...)`，**没有**
  `waiting for element to be visible` ⇒ 元素是**消失**了，不是被遮挡）。
- **对照诊断**（`t139-03a-diag-shared-page.mjs`）：探针 **0.4.8** 与已装 **0.4.7**
  **各跑一轮**、点「共享」后逐 **500 ms** 采样 **12 秒**
  ⇒ **两个版本表现完全一致**（列表恒为 **2** 项、item 可见 1120×89、**全程没有消失**）
  ⇒ **不是这一版引入的回归**（0.4.8 与 0.4.7 的唯一代码差异就是 T138 的「最近」页布局修复）；
- **根因**：`src/pages/SharedLibrariesPage.tsx` 的 `loadLibraries()` 在请求失败时会
  `setLibraries([])` ⇒ **把已渲染的列表清空**。组件一旦重挂载且那次请求失败（中继带宽受限，
  0.5–4 Mbps）⇒ 列表就被清掉 ⇒ 这是**既有**的健壮性问题，**本版没有改动它**；
- **结论**：第 2 轮复跑**通过**（2 个库、点进去 11 个子目录）。
  ⇒ **如实记录**这一轮偶发，**不假装它没发生过**，也**不在本版顺手改**（那是另一件事）。

---

## 六、执行记录（**待回填**）

### 1. commit 与 tag

（待回填）

### 2. 发版实测（CI run 号 / asset / attestation）

（待回填）

### 3. 装版实测

（待回填）

### 4. 线上正文同步（网页编辑页）

（待回填）

---

## 七、遗留 / 待办

- ⏳ **歌单面板排序 / 分页**的**真机**复验（真实账号 `playlist/list` `total=0` ⇒ 面板是空态
  ⇒ **控件不渲染**）⇒ 需要一个**有歌单的账号**才能验；
- ⏳ **fnOS 音乐服务的版本号仍然取不到**（`/version` 等候选端点全是 SPA 兜底页）⇒ 待 fnOS 暴露版本端点；
- ⏳ **本机记录段的「上限 240px」真机看不到效果**（本机记录为空）⇒ 由契约单测钉住；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU** ⇒ 要回按机器需 `/allusers`；
- ⏳ 本地旧的 `release-probe/` ＋ `.pack-staging*`（约 **1.5 GB**）因**文件被工作区监听器占用**
  ⇒ 本会话内**删不掉** ⇒ 需退出 MiniMax Code 后再清。
