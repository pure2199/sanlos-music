# T137 —— 发版 v0.4.7（去掉备案号）

> ⚠ **本文件是规格**（发版前写死「要做什么、怎么验、什么算过」），
> **执行记录**在 §六，**真机复验结论**在 §五 —— 两者**分开写**，
> 免得「事后补的结论」看起来像「事先就知道」。

---

## 一、这一版发什么（**1 项**，**用户能直接感知**）

`v0.4.6..HEAD` 共 **3 个 commit**（其中 2 个是 v0.4.6 的**发版后回填**，纯文档）：

| # | 来源 | 改了什么 | 用户看得见什么 |
|---|---|---|---|
| ① | `9bdab44` | **去掉备案号**（单一真相源 `shared/appInfo.ts` 的 `icp` 字段 ＋ 设置页「关于」那一行 ＋ README 一行） | 设置 →「关于」里**不再有**「备案号」那一行；**开发者 / 公司 / 官网 / 项目地址一行都没少** |
| ② | `5fb2306` | v0.4.6 的**已装版复验**回填 | —— |
| ③ | `18f5f74` | v0.4.6 的 calibration ＋ 规格回填 | —— |

⚠ **本版是「删除」而不是「新增」** ⇒ 它的判据是**负向的**：
**asar 里不该再出现备案号** ⇒ 「正向标志命中」**证明不了**这件事
⇒ 必须另配一条**负向判据**（不许有），否则「装对了包」也证明不了「备案号真没了」。

⚠ **既有断言被显式推翻 ⇒ 改写为新行为断言**（一条不删、断言不弱化）：
`test/app-info.test.ts`、`test/settings-page.test.tsx`、`e2e/smoke.spec.ts`
三条断言全部改成「**不许再出现备案号**」，并各自补了一条**更宽的守卫**
（不许出现备案号字样 / 关于页整块不许有「备案」二字）。

---

## 二、发版链（**每一步都有证据**）

### 1. 版本号（**四处必须同步**）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `package.json` | `version` 0.4.6 ⇒ **0.4.7**（**只 1 行**） | LF |
| `package-lock.json` | root `version` **两处** ⇒ 0.4.7 | LF |
| `README.md` | 整篇 0.4.6 ⇒ 0.4.7（**12 处**，**逐条审过**：全是「当前版本」引用） | LF |
| `docs/changelog.md` | 「当前版本」行 ＋ 「未发布」段 ⇒ **新增** `## 0.4.7 —— 2026-11-22` 段（**历史段一字不动**） | **CRLF** |
| `docs/releases/v0.4.7.md` | **新增**（CI 的 Release 正文来源 ⇒ **缺它工作流直接 `throw`**） | LF |

⚠ **`package-lock.json` 必须同步**：CI 第一步是 `npm ci` ⇒ 不同步**直接失败**。
⚠ **README 那 12 处**逐条审过，含「**v0.4.6 及更早的产物未做代码签名**」⇒ 改后为
「**v0.4.7 及更早**」（v0.4.7 **同样未签名**，所以这句仍然成立）。
⚠ **changelog 的历史段一个字都不动**（`## 0.4.6 —— 2026-11-21` 必须仍在）。
⚠ **导语的件数必须与表格实际行数一致**（T135 踩过：写「七件事」而表里 8 行
⇒ 被自检脚本当场拦下）⇒ 本轮**自己**核了一遍（1 件事 / 1 行）。

### 2. 注解 tag ＋ 推分支

- `git tag -a v0.4.7 -F release/verify/tag-msg-v0.4.7.txt` ⇒ tag 对象 → 发版 commit；
- `git push origin sanlos-music` ＋ `git push origin v0.4.7`；
- 已验：远端有 tag；tag 内 `package.json` version = 0.4.7；tag 内 `docs/releases/v0.4.7.md` 存在。

⚠ **tag 必须先推送，再 dispatch** —— 工作流第一步就是
`actions/checkout` with `ref: ${{ inputs.tag }}` ⇒ **tag 不存在 ⇒ 直接失败**。

### 3. 网页 dispatch（**没有 `gh` CLI、没有 token ⇒ 只能走网页**）

工作流 `.github/workflows/release.yml`，三个输入：

| 输入 | 这次取什么 | 为什么 |
|---|---|---|
| `tag` | `v0.4.7` | 要发布的标签 |
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
⚠ 但**资产名会被归一**（`SanlosMusic-Setup-0.4.7.exe`，**去空白**）
⇒ GitHub 上不会出现带空格的下载 URL（带空格会 404）。
⚠ **正文 = `docs/releases/v0.4.7.md` ＋ CI 追加的 sha256 表 ＋ 「怎么确认这个安装包是官方的」**
⇒ 事后本地补的「已装版复验」段**不在**线上正文里 ⇒ 要**另行同步**（走网页编辑页）。

---

## 三、发版**前**的真机复验（**闸门**）

⚠ **为什么要先验**：v0.4.4 是「先发版、再装版复验」⇒ 万一有坑，**已经发出去了**。
⇒ 这次先**用自打产物**做一轮，**过了再发**；发版**后**再装版复验一轮（验的是**真正发出去的产物**）。

| 手段 | 为什么这么选 |
|---|---|
| `pack:probe`（输出到 `release-probe/`，**gitignored**） | 打出**带新代码**的产物；**不装** ⇒ **零注册表副作用**（不覆盖 HKCU 卸载项、不动已装目录） |
| 跑暂存目录里的 `win-unpacked/Sanlos Music.exe` | 就是安装器要装的那份 exe ⇒ **口径等价** |
| ⚠ **产物路径按 asar 里的版本号挑**（不看目录名） | `win-unpacked` 可能因目录被占用而**留在暂存目录**（`.pack-staging-<时间戳>/`）⇒ **只看输出目录会验错版本** |
| **隔离 userData**（临时目录，只复制 `session.bin` ＋ `Local State`） | **真实账号 ＋ 真 NAS**，但**不碰**用户真实偏好 / 下载目录 / 扫描状态 |
| 走 `sanlos://srv/...` | **不碰任何凭证**（token 只在主进程内存里） |
| **静音**（`setAudioMuted(true)`） | 位置照走，但机器不出声 |

⚠ **打包前先查「已装程序在不在跑」** —— 在跑就别覆盖它的目录（**不替用户杀进程**）。

### 复验清单（**12 项**：**11 项通过 ＋ 1 项真机不可观测**）

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
| 11 | **`ui-about-no-icp`** | **界面：「关于」页**没有备案号**，但开发者 / 公司 / 官网**都还在**（**T137 本版唯一的用户可感知变化**）⇒ 判据**双向**（不会「整个关于块没渲染」也判过） |
| 12 | `ui-resume-flush` | 界面：退出前补写「上次播放」（**最后一项**：它会关掉应用） |

---

## 四、验收点

| 项 | 判据 |
|---|---|
| 版本号 | `package.json` / `package-lock.json` / `README.md` / `changelog.md` **全部是 0.4.7**，**没有残留的 0.4.6**（历史 changelog 段除外） |
| 回归 | `tsc` **0 错**；Vitest **全绿**；Playwright **全绿**；`npm run build` exit **0** |
| 字节体检 | `t115-10-bytes-check-all.mjs` ⇒ **bad=0** |
| blob 行尾 | 本次提交的 blob **全 LF、无 BOM**（`core.autocrlf=true` ⇒ blob 一律 LF） |
| 探针产物 | 暂存目录里 `app.asar` 内 `package.json` version = **0.4.7**；**asar 里没有「ICP备」/「备案号」**（**负向标志**）；正向标志 **5/5** 命中 |
| 真机复验 | 逐项有结论（**通过 / 不通过 / 真机验不了并标注**） |
| Release | 存在、`draft=false`、`prerelease=false`、资产**恰好 3 个** |
| sha256 | **Release 正文表格** ＝ **资产 API 的 digest** ＝ **本地下载后实算** ⇒ **三个来源一致** |
| attestation | `Summary (attestation)` 成功 ⇒ 有构建来源证明页面 |
| 装版 | `D:\Sanlos Music\Sanlos Music.exe` FileVersion = **0.4.7**；`session.bin` **逐字未变**；注册表卸载项 = `Sanlos Music 0.4.7`（HKCU） |

---

## 五、真机复验状态

> ⚠ **发版前**那一轮（自打产物）的逐项结论。
> ⚠ **真机验不了的**必须**如实标注**，不许含糊过去。

⚠ 手段：**隔离 userData** ＋ **真实 NAS**（FN 中继）＋ `sanlos://srv/...` ＋ **静音**。
⚠ 探针产物：`.pack-staging-1795341607567/win-unpacked`（asar 版本 **0.4.7**）。

⚠ **本版的判据是负向的**：备案号**不该**出现 ⇒ 装版复验脚本里加了一条
**负向标志**（`NEG_FLAGS`：asar 里不许有「ICP备」/「备案号」）
⇒ 单靠「正向标志命中」**证明不了**备案号真的没了。

| # | id | 实测 | 结论 |
|---|---|---|---|
| 1 | `ep-init` | `code=0`；`initialized=true` | ✅ |
| 2 | `ep-suggest` | 各 **5** 条，共 **15** 条、**15** 条带 `score` | ✅ |
| 3 | `ep-shared` | **2** 个共享库 | ✅ |
| 4 | `ui-init` | 「已初始化」；提示条 **0** | ✅ |
| 5 | `ui-shared` | **2** 个库；进去 **11** 个子目录 | ✅ |
| 6 | `ui-suggest` | **2351 ms** 出现；错误条 **0** | ✅ |
| 7 | `ui-cover-persist` | 落盘 **9** 条已知封面 ⇒「**从头重扫**」⇒ **仍 9** 条、**丢 0** 条 | ✅ |
| 8 | `ui-playlist-panel` | 面板能打开；空态文案正确 | ✅ |
| 9 | `ui-playlist-sort` | ⚠ **真机不可观测**（0 个歌单 ⇒ 控件不渲染） | ⏭ |
| 10 | `ui-discover` | 榜单 **309 ms** 出来；命中 **12416 ms** 后补 | ✅ |
| 11 | **`ui-about-no-icp`** | 备案号元素 **0** 个；无「备案」/「ICP备」字样；**开发者 `pure2199` / 公司 / 官网都在**（版本 v0.4.7） | ✅ |
| 12 | `ui-resume-flush` | 退出前 `…874309` ⇒ 退出后 `…901098`（**变新**） | ✅ |

**合计：11 通过 / 0 失败 / 1 不可观测。**

⚠ **打包产物另有一道负向核验**（`t137-02b-check-probe-asar.mjs`）：
asar 版本 = **0.4.7**；asar 文本里含「ICP备」= **false**、含「备案号」= **false**；
正向标志 **5/5** 命中 ⇒ `PROBE_OK`。

---

## 六、执行记录（**实测**）

### 1. commit 与 tag

- 发版内容那一笔：`d74f959`（版本号四处同步 ＋ 新建 `docs/releases/v0.4.7.md` ＋ 发版规格）；
- 发版**前**复验那一笔：`0a3c9d8`（calibration 第一百一十七节 ＝ 发版前的闸门）；
- 注解 tag：`v0.4.7`（tag 对象 `6509b947` ⇒ 指向 `0a3c9d8`），**已推送**；
  tag 内 `package.json` 的 `version` = **0.4.7**，tag 内含 `docs/releases/v0.4.7.md` ＋ 发版规格；
- 分支 `sanlos-music`：`0a3c9d8` ⇒ `f4ad12d`（发版后补记「已装版复验」那一笔）。

### 2. 发版实测（CI run 号 / asset / attestation）

- 网页 dispatch：Release 工作流（`release.yml`），入参 `tag=v0.4.7` / `pack_only=false` / `sign=false`；
- run：**#24**（id `45011492868`，`workflow_dispatch`，
  `head_sha=0a3c9d8650bb9abf75bafeca810ed4810f19ff66`）⇒ **success**（约 7 分钟）；
- 步骤：`Typecheck` / `Unit tests` / `Build` / `Pack` / `Upload unsigned artifacts` /
  `Verify unsigned artifacts` / `Write update manifest (unsigned)` / `Normalize asset names` /
  `Attest build provenance` / `Prepare release notes with checksums` / `Publish GitHub Release`
  全 **success**；
  `Summary (pack only)` 与 `Check SignPath configuration` 等 **6** 个步骤 **skipped**
  ⇒ `pack_only=false` 与 `sign=false` **真的生效**（否则会卡在 SignPath 检查）；
- Release：**id `454361943`**，`tag=v0.4.7`，**非 draft**、**非 prerelease**，
  `published_at=2026-11-22T10:21:09Z`，资产 **3** 个；
- 三个资产：下载到本地后 **sha256 与 GitHub API 的 digest 逐个一致（3/3）** ⇒

| 资产 | 字节数 | sha256 |
|---|---|---|
| `SanlosMusic-Setup-0.4.7.exe` | 86143705 | `c78fd5a41fc723c9e98cb038d3fd5a0b2578d3c2e3989c9039a00ca552626864` |
| `SanlosMusic-Portable-0.4.7.exe` | 79049945 | `fbeb0153a95bd2fd793b7a03e625e0cda4e94b7555222363871e76e124065a79` |
| `latest.json` | 472 | `6f9013deacae9d4485701c1799a700fb8cc580659b847128b1b6a440c5556152` |

- 构建来源证明（attestation）：`https://slsa.dev/provenance/v1` **#70730867**
  （页面 `https://github.com/pure2199/sanlos-music/attestations/70730867`；
  Created 2026-11-22 10:20:59 GMT；commit `0a3c9d86…`；run `45011492868/attempts/1`；
  trigger `workflow_dispatch`；workflow `release.yml`）。

### 3. 装版实测

- 安装包：Release 里的 `SanlosMusic-Setup-0.4.7.exe`（86,143,705 字节，
  sha256 与上表**逐字一致**）⇒ 静默**原地升级**装到 `D:\Sanlos Music`
  ⇒ **没有卸载 v0.4.6** ⇒ `INSTALL046_OK`；
- 主程序 exe `FileVersion` = **0.4.7**；`app.asar` 里 `package.json` 的 `version` = **0.4.7**；
  **6/6** 个 v0.4.7 正向标志命中；**负向标志**「ICP备」「备案号」**都不在**
  ⇒ 这一版是真的把备案号删掉了（不是界面藏起来）；
- 「已安装的应用」**只有**「Sanlos Music 0.4.7」一条（作用域 **HKCU**）⇒ **没有残留 0.4.6**；
- 用户数据：`session.bin`（登录态）**逐字未变**、`Local Storage` **8 → 8** 个文件、
  `prefs.json` 状态未变 ⇒ **升级没有动用户自己的东西**；
- **已装版真机复验 12 项：11 通过 / 0 失败 / 1 不可观测**（`REALMACHINE_OK`，
  证据 `release/verify/t137-04-realmachine-result-installed.json`）：
  ⭐「关于」页**没有备案号**，而**开发者 `pure2199` / 公司「广西闪链时空网络科技有限公司」/ 官网都在**
  （页面显示「版本 v0.4.7」）。

### 4. 线上正文同步（网页编辑页）

- Release 编辑页（`/pure2199/sanlos-music/releases/edit/v0.4.7`）⇒ 正文填入
  `docs/releases/v0.4.7.md` ＋ CI 追加段（本地重建文件 `release/verify/t137-body-final.md`：
  **6731** 字符、**全 LF**、sha256 `cac2cb5ed6dc3b66ad2ad4604d5b3a263fd64ef7446dee8811850a3eaf7aec28`）；
- ⚠ **网页表单提交后 GitHub 把 `\n` 统一成 `\r\n`** ⇒ 线上正文 **6906** 字符
  （CRLF **175** 处、**无落单** `\r`）⇒ **归一化行尾后与本地文件逐字节一致**
  （`EQUAL_LOCAL_FILE=true`）⇒ **属预期内**（渲染效果相同，且不再混行尾）；
- 提交后复核（公开 API）：`id=454361943`、draft=false、prerelease=false、
  三个资产的 name / size / digest **均未变**。

---

## 七、遗留 / 待办

- ⏳ **歌单面板排序 / 分页**的**真机**复验（真实账号 `playlist/list` `total=0` ⇒ 面板是空态
  ⇒ **控件不渲染**）⇒ 需要一个**有歌单的账号**才能验；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU** ⇒ 要回按机器需 `/allusers`；
- ⏳ 本地旧的 `.pack-staging*` 暂存目录（**约 722 MB**）因**文件被工作区监听器占用**
  ⇒ 本会话内**删不掉**（`DeleteDirectory` 报「系统调用级别不正确」）
  ⇒ 需退出 MiniMax Code 后再清。
