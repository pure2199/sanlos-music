# T129 —— 发版 v0.4.5（「共享」页 ＋ 搜索建议 ＋ 初始化状态提示 ＋ 四个修复）

> ⚠ **本文件是规格**（发版前写死「要做什么、怎么验、什么算过」），
> **执行记录**在 §六，**真机复验结论**在 §五 —— 两者**分开写**，
> 免得「事后补的结论」看起来像「事先就知道」。

---

## 一、这一版发什么（**8 项**）

`v0.4.4..HEAD` 共 **11 个 commit**，其中 **8 项是用户能直接感知的功能 / 修复**：

| # | 来源 | 改了什么 | 用户看得见什么 |
|---|---|---|---|
| ① | `f292301` | 接 `/shared-library/*` ＋ 新增「共享」页 | 曲库多一颗「共享」页：列出这台 NAS 共享出来的音乐库（**只读**），可**按目录浏览**、下钻，里面的歌**直接能播** |
| ② | `c78bf8f` | 退出前强制补写一次「上次播放」位置 | 续播误差从**最多 10 秒**压到 **≈ 0** |
| ③ | `732bf2a` | 「发现」页榜单**先出** ＋ 命中**异步补** ＋ 二次进入不重打 NAS | 榜单**先出屏幕**（**30–40 秒**，不用等「你曲库里有几首」算完）；命中随后补上；「匹配中…」不等于「不在曲库」 |
| ④ | `f38eaec` | 页码**绝对上界** clamp（100 万页） | `page=1e300` 不会再以 `1e+300` 原样发给服务端 |
| ⑤ | `533ffb1` | MP4 / M4A 的 `moov` 读不全 / 在文件尾 ⇒ **补读一次** | 头里没有 `moov` 或超出窗口的 MP4，**内嵌歌词也能读到** |
| ⑥ | `ffb510c` | 接 `/search/suggest` ＋ `score` | 搜索页**先出「建议」**（歌曲 / 专辑 / 歌手各最多 5 条，**1.4 s**），完整结果随后补（**5.8 s**） |
| ⑦ | `e3f8900` | 接 `/initialization/state` ＋ 三态 | 服务端**没完成首次初始化**时，连接页如实说明「音乐服务：未初始化」＋ 给出下一步；搜索空结果**不再说「没有找到」** |
| ⑧ | `128ce1b` / `a3fef48` | v0.4.4 的装版复验回填（**文档**） | —— |

⚠ **④ 不是「越界保护」**：真正防越界的是既有两道护栏（按总数判断 ＋ 连续 N 页无进展就停）；
④ 只是**荒谬值兜底**（防 `1e+300` 这种值上线）。

⚠ **⑦ 老服务端上界面一个字都不变**（「未知」绝不当成「未初始化」）。

---

## 二、发版链（**每一步都有证据**）

### 1. 版本号（**四处必须同步**）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `package.json` | `version` 0.4.4 ⇒ **0.4.5**（**只 1 行**） | LF |
| `package-lock.json` | root `version` **两处** ⇒ 0.4.5 | LF |
| `README.md` | 整篇 0.4.4 ⇒ 0.4.5（**10 处**，**逐条审过**：全是「当前版本」引用） | LF |
| `docs/changelog.md` | 「当前版本」行 ＋ 「未发布」段 ⇒ **新增** `## 0.4.5 —— 2026-11-20` 段（**历史段一字不动**） | **CRLF** |
| `docs/releases/v0.4.5.md` | **新增**（CI 的 Release 正文来源 ⇒ **缺它工作流直接 `throw`**） | LF |

⚠ **`package-lock.json` 必须同步**：CI 第一步是 `npm ci` ⇒ 不同步**直接失败**。
⚠ **README 那 10 处**逐条审过，含「**v0.4.4 及更早的产物未做代码签名**」⇒ 改后为
「**v0.4.5 及更早**」（v0.4.5 **同样未签名**，所以这句仍然成立）。

### 2. 注解 tag ＋ 推分支

- `git tag -a v0.4.5 -F release/verify/tag-msg-v0.4.5.txt` ⇒ tag 对象 → HEAD；
- `git push origin sanlos-music` ＋ `git push origin v0.4.5`；
- 已验：远端有 tag；tag 内 `package.json` version = 0.4.5；tag 内 `docs/releases/v0.4.5.md` 存在。

⚠ **tag 必须先推送，再 dispatch** —— 工作流第一步就是
`actions/checkout` with `ref: ${{ inputs.tag }}` ⇒ **tag 不存在 ⇒ 直接失败**。

### 3. 网页 dispatch（**没有 `gh` CLI、没有 token ⇒ 只能走网页**）

工作流 `.github/workflows/release.yml`，三个输入：

| 输入 | 这次取什么 | 为什么 |
|---|---|---|
| `tag` | `v0.4.5` | 要发布的标签 |
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
⚠ 但**资产名会被归一**（`SanlosMusic-Setup-0.4.5.exe`，**去空白**）
⇒ GitHub 上不会出现带空格的下载 URL（带空格会 404）。

---

## 三、发版**前**的真机复验（**闸门**）

⚠ **为什么要先验**：v0.4.4 是「先发版、再装版复验」⇒ 万一有坑，**已经发出去了**。
⇒ 这次先**用自打产物**做一轮，**过了再发**；发版**后**再装版复验一轮（验的是**真正发出去的产物**）。

| 手段 | 为什么这么选 |
|---|---|
| `npm run pack:probe`（输出到 `release-probe/`，**gitignored**） | 打出**带新代码**的产物；**不装** ⇒ **零注册表副作用**（不覆盖 HKCU 卸载项、不动已装目录） |
| 跑 `release-probe/win-unpacked/Sanlos Music.exe` | 就是安装器要装的那份 exe ⇒ **口径等价** |
| ⚠ **产物路径两处都查** | `win-unpacked` 可能因目录被占用而**留在暂存目录**（`.pack-staging/`） |
| **隔离 userData**（临时目录，只复制 `session.bin` ＋ `Local State`） | **真实账号 ＋ 真 NAS**，但**不碰**真实偏好 / 下载目录 / 扫描状态 ⇒ 隔离目录里没有落盘 ⇒ 进页面**自动开扫** ⇒ 能测到真实耗时 |
| **对照组 = 已装的 0.4.4** | 同机、同账号、同数据、同一天 ⇒ 最强对照 |

⚠ **打包前先查「已装程序在不在跑」** —— 在跑就别覆盖它的目录（**不替用户杀进程**）。

---

## 四、验收点

| 项 | 判据 |
|---|---|
| 版本号 | `package.json` / `package-lock.json` / `README.md` / `changelog.md` **全部是 0.4.5**，**没有残留的 0.4.4**（历史 changelog 段除外） |
| 回归 | `tsc` **0 错**；Vitest **全绿**；Playwright **全绿**；`npm run build` exit **0** |
| 字节体检 | `t115-10-bytes-check-all.mjs` ⇒ **bad=0** |
| blob 行尾 | 本次提交的 blob **全 LF、无 BOM**（`core.autocrlf=true` ⇒ blob 一律 LF） |
| 探针产物 | `release-probe/win-unpacked/Sanlos Music.exe` 的 `app.asar` 内 `package.json` version = **0.4.5** ＋ **v0.4.5 标志命中** |
| 真机复验 | 8 项逐项有结论（**通过 / 不通过 / 真机验不了并标注**） |
| Release | 存在、`draft=false`、`prerelease=false`、资产**恰好 3 个** |
| sha256 | **Release 正文表格** ＝ **资产 API 的 digest** ＝ **本地下载后实算** ⇒ **三个来源一致** |
| attestation | `Summary (attestation)` 成功 ⇒ 有构建来源证明页面 |
| 装版 | `D:\Sanlos Music\Sanlos Music.exe` FileVersion = **0.4.5**；`session.bin` **逐字未变** |

---

## 五、真机复验状态（**待回填**）

> ⚠ **发版前**那一轮（自打产物）的逐项结论。
> ⚠ **真机验不了的**必须**如实标注**，不许含糊过去。

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

- ⏳ **T130**：主进程代理 30 s 超时返回业务信封 `code=-1` ⇒ `apiCall` 抛 `ApiError`
  而不是 `ApiNetworkError` ⇒ 渲染层「可重试 / 服务端拒绝」判断**误判**；
- ⏳ **T131**：D 组卫生项（mock-server 端口竞态、T118「扫描落盘覆盖补拉封面」、
  README `### Code signing policy` ＋ `.github/CODEOWNERS`、`scripts/pack.cjs` 跨卷 EXDEV）；
- ⏳ **T132**：B 组最后一项「歌单排序 / 分页」（真实账号 `playlist/list` `total=0`
  ⇒ **只能靠 mock 验**）；
- ⏳ **T119 端点表订正**（`reconnect-check` 应为 `reconnect/check`）⇒ 历史段不篡改 ⇒ 另立小任务；
- ⏳ GitHub 账号 **2FA 未启用**；卸载项落在 **HKCU** ⇒ 要回按机器需 `/allusers`。
