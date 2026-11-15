# T94 规格：发版 **v0.3.0**

> 一句话：把 **T90**（歌词源 2→6 ＋ 真逐字 ＋ 翻译 ＋ 罗马音三行）、
> **T92**（启动自动播放 300 ms 淡入）、**T93**（占位歌词视同「没匹配上」）
> 三批改动打成 **v0.3.0**，发到 GitHub Releases。

---

## 一、版本号（**用户拍板**）

| 项 | 值 |
|---|---|
| 版本号 | **0.3.0** |
| 标签 | `v0.3.0` |
| 日期 | 2026-11-15 |

- 理由：这是「**歌词源 2→6 ＋ 逐字 ＋ 翻译 ＋ 罗马音三行**」的功能大版本。
- ⚠️ **如实标注**：本仓库历史编号一直是 **0.2.x**（`v0.2.0` → `v0.2.9`，含 v0.2.9 那种「加两个功能」的 patch 递增）
  ⇒ 本次**跨到 0.3.0** 是**用户拍板**的，不是本仓库既有的编号惯例。
- ⚠️ **版本号只落在一处**：`package.json` 的 `version`
  （About 页 / 更新页走主进程 `app.getVersion()`；资产名与 `latest.json` 由 CI 从它推导）。

---

## 二、这一版装了什么

| 批次 | 内容 | 用户看得见的变化 |
|---|---|---|
| **T90** | 歌词源 **2 → 6**（网易云 / lrclib / QQ / 酷狗 / 酷我 / 咪咕）、**真逐字**（词级时间戳）、翻译**以原文行为锚**重新定时、**罗马音第三行** | 设置里多 4 个源；卡拉OK 填色跟着唱的那个字走；日语歌下面多一行罗马音；翻译不再丢行、不再挂错行 |
| **T92** | 启动自动播放 **300 ms 线性淡入**（锚在 `playing` 事件） | 启动后第一声不再「炸」出来（实测出声瞬间 = 稳态的 **42.8%**，无淡入时是 **71%**） |
| **T93** | 占位歌词（「此歌曲为纯音乐，请欣赏」）**视同「没匹配上」** | 线上搜不到词时**改读内嵌歌词**（实测那首粤剧：内嵌 **265 行**对白终于被读出来） |

**这一批的量**（`v0.2.9..HEAD`）：

| 项 | v0.2.9 | 本版 | Δ |
|---|---|---|---|
| 改动文件 | — | **50 个** | +10999 / -276 行 |
| 测试文件 | 118 | **125** | **+7** |
| 测试条数 | 2431 | **2639** | **+208** |

---

## 三、改哪些文件（**4 个**，别多改）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `package.json` | `"version": "0.2.9"` → `"0.3.0"`（**只这 1 行**） | LF |
| `docs/releases/v0.3.0.md` | **新增**：CI 的 Release 正文来源（`release.yml` 找不到这份文件会直接 **throw**） | LF（`release.yml` 按 LF 拼正文） |
| `docs/changelog.md` | 「未发布（Unreleased）」段 → `## 0.3.0 —— 2026-11-15`；「当前版本」行 → `0.3.0` | **CRLF**（保持原样） |
| `README.md` | **9 处**版本引用（当前版本 / 下载链接 / 两个资产名 / 发布说明链接 / attestation 命令 / 两条 Unblock-File 命令 / 静默安装命令） | LF |

⚠️ **不动** `docs/packaging.md` 与 `docs/signing.md`：
里面的 `v0.2.4` / `v0.2.5` / `v0.2.6` 是**流程示例**，不是「当前版本」
⇒ 上一版（v0.2.9）发版时也**没有**动它们 ⇒ 本轮同例。

---

## 四、发布链路（**CI 自动**，本机不打包）

```
本机：改 4 个文件 → 提交 → 推分支 → 打 tag v0.3.0 → 推 tag
                                            ↓
GitHub：手动 dispatch .github/workflows/release.yml
        （tag = v0.3.0，pack_only = false，sign = false）
                                            ↓
CI（windows-latest，Node 22）：
  checkout(v0.3.0) → npm ci → typecheck → test → build → pack
  → 断言产物**确实没签名**（--expect none）→ 写 latest.json
  → 产物改名归一（SanlosMusic-Setup-<版本>.exe）
  → 签发 attestation（SLSA build provenance）
  → 拼正文（docs/releases/v0.3.0.md ＋ sha256 表 ＋ 验签说明）
  → gh release create v0.3.0（3 个资产）
```

| 决策 | 值 | 理由 |
|---|---|---|
| 签名 | **关掉（`sign=false`）** | SignPath Foundation 的申请**已被拒**（可见度不足）⇒ 签名路径**必然失败**在「Check SignPath configuration」⇒ 走**未签名路径**，替代信任锚 = **attestation** |
| `pack_only` | **false** | 要真发版（true 只出 artifact，不发 Release） |
| 本机打包 | **不做** | 产物**只能**由 CI 构建（可信构建的前提）；本机打包的包 CI 签不了、attestation 也不认 |
| 资产 | `SanlosMusic-Setup-0.3.0.exe` / `SanlosMusic-Portable-0.3.0.exe` / `latest.json` | **不带空格**（GitHub 把空格存成点 ⇒ 带空格的下载 URL 直接 404） |

⚠️ **本机没有 `gh` CLI，也没有 GitHub token** ⇒ **dispatch 这一步走内置浏览器**
（GitHub 网页上的「Run workflow」）—— 浏览器带的是用户已登录的会话。

---

## 五、验收点

### 发布前（本机）

1. `tsc --noEmit` ⇒ **0 error**；
2. `vitest run` ⇒ **125 files / 2639 passed / 0 failed**（既有条数**一条未删、断言一条未弱化**）；
3. `npm run build` ⇒ **成功**；
4. `git diff --numstat` ⇒ `package.json` **只 1 行**；
5. `docs/releases/v0.3.0.md` **存在**（CI 找不到会 throw）⇒ 标签里必须有；
6. 字节体检 + 控制字符扫描（4 个文件）⇒ **0 bad**；`docs/changelog.md` **0 裸 LF**。

### 发布后（CI 跑完）

7. Release `v0.3.0` 存在，且是仓库的 **latest**（自动更新靠 `releases/latest/download`）；
8. 资产**恰好 3 个**（Setup / Portable / latest.json）⇒ 下载 URL **不 404**；
9. `latest.json` 的 `version` = **0.3.0**；
10. Release 正文末尾有 **sha256 表** ＋ attestation 验法；
11. `gh attestation verify`（有 gh 的机器上）对**新文件名**验得过。

---

## 六、风险与兜底

| 风险 | 兜底 |
|---|---|
| CI 跑了但 Release 没建出来 | 重跑同一个 workflow（`gh release view` 存在 ⇒ 走 upload/edit 分支，不会重复建） |
| 产物名错位（tag 里的 version 与资产名对不上） | 资产名由 `package.json` 推导 ⇒ **bump 提交必须在 tag 之前** |
| 客户端没收到更新 | 自动更新走 `releases/latest/download/latest.json` ⇒ **Release 必须是 latest**；本版**没有**破坏性存储变化 ⇒ 老用户可直接覆盖安装 |
| 正文里的 sha256 写死 | **不写死** ⇒ 由 CI 在正文末尾**追加**（NSIS 内嵌构建时间戳 ⇒ 两次构建字节必然不同） |

---

## 七、明确**不做**

| 不做 | 理由 |
|---|---|
| 改「线上优先 / 本地优先」政策 | T70 用户拍板的；本轮只**修判据**（T93），不动政策 |
| 把 NAS 自带的占位文案也当成「没有」 | 那句话**有信息量**（告诉用户这歌没词） |
| 尾读 MP4/M4A 的 `moov` | 另一轮（内嵌歌词在 MP4 里读不到） |
| 重新申请代码签名 | 用户明确**不做**（SignPath 已被拒 ⇒ 付费证书那条路用户不走） |
| 改 `docs/packaging.md` / `docs/signing.md` | 里面是**流程示例**，不是当前版本 |
