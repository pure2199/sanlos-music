# T116 规格：发版 **v0.4.2**

> 一句话：把 **T115**（里层命名全量改名：`fnm` / `fnmusic` ⇒ `sanlos`）
> 与 **T114**（仓库默认分支改名 ⇒ `sanlos-music`）打成 **v0.4.2**，
> 发到 GitHub Releases，并**装到本机**做真机复验。

---

## 一、版本号（**用户拍板**：2026-11-19「现在发 v0.4.2」）

| 项 | 值 |
|---|---|
| 版本号 | **0.4.2** |
| 标签 | `v0.4.2`（**注解标签**） |
| 日期 | 2026-11-19 |

- 理由：`v0.4.1..HEAD` 之间是 **T114 ＋ T115** 两批**纯改名**（**功能零变化**）
  ⇒ 语义上是**次版本**（对外可见的标识变化 ⇒ 不是纯补丁）
  ⇒ 从 **0.4.1** 升到 **0.4.2**。
- ⚠ **版本号落在一处**：`package.json` 的 `version`
  （About 页 / 更新页走主进程 `app.getVersion()`；资产名与 `latest.json` 由 CI 从它推导）。
- ⚠ **顺带对齐一个既有小瑕疵**：`package-lock.json` 的 root `version`
  自 **0.2.4** 起就再没同步过（v0.4.0 / v0.4.1 时也还是 `0.2.4`）
  ⇒ 本版把它同步到 **0.4.2**（该字段**不参与**依赖解析 ⇒ 不影响 `npm ci`；
  实证：v0.4.1 的 CI run 44479393534 在 lock 为 `0.2.4` 时**照样 success**）。
- ⚠ **绝不改历史标签**：`v0.4.1` 已发布 ⇒ 只**新增** `v0.4.2`。

---

## 二、这一版装了什么（**功能零变化，全是改名**）

| 批次 | 内容 | 用户看得见的变化 |
|---|---|---|
| **T114** | 仓库默认分支 `feature/fnmusic-desktop` ⇒ **`sanlos-music`**（GitHub 原生 rename） | **clone 地址变了**（旧的 `feature/fnmusic-desktop` 分支已不存在）；旧 **tag 全部保留** ⇒ 历史版本仍可下载 |
| **T115** | 里层命名全量改名：`fnm` / `fnmusic` ⇒ `sanlos` | **界面零变化**（产品名仍是「Sanlos Music」）；内部协议从 `fnm://` / `fnml://` 变成 `sanlos://` / `sanlos-media://`；npm 包名 `fnmusic-desktop` ⇒ `sanlos-music`；**appId** `com.fnmusic.desktop` ⇒ `com.sanlos.music` |

**这一批的量**（`v0.4.1..HEAD`）：

| 项 | v0.4.1 | 本版 | Δ |
|---|---|---|---|
| 改动文件 | — | **296 个**（**51 改名** ＋ 241 改 ＋ 4 新增） | 4 082 增 / 2 849 删 |
| 测试文件（`test/`） | 145 | **146** | **+1**（`test/t115-rename-contract.test.ts`，**27 条**契约钉子） |
| 测试条数 | 2 997 | **3 024** | **+27**（既有 **2 997** 条**一条未删、断言一条未弱化**） |
| E2E | 72 | **72** | 不变 |

### ⚠ 这一版**唯一**真正的「升级断点」：**appId 变了**

| 项 | v0.4.1 | v0.4.2 |
|---|---|---|
| `appId` | `com.fnmusic.desktop` | **`com.sanlos.music`** |
| 卸载项 GUID | `fa78624c-0069-55d6-b3c4-02b4967c19b0` | **变**（由 appId 推导） |
| ⇒ 后果 | — | **不是原地升级** ⇒ 旧版卸载项会残留在「已安装的应用」里 |

⇒ 处置：**先让 v0.4.1 自己的卸载器静默卸载，再装 v0.4.2 到同一路径**
（只删 `D:\Sanlos Music`；**登录态在 `%APPDATA%\Sanlos Music`，不在安装目录 ⇒ 不受影响**）。

### ⚠ 用户**不会**丢的三样东西（T115 专门处理过）

| 东西 | 为什么丢不了 |
|---|---|
| **登录态** | `productName` 仍是 `Sanlos Music` ⇒ **userData 目录名不变** |
| **播放历史 / 续播位置 / 歌词覆盖** | `shared/legacyStorageKeys.ts` 存了三个**旧 localStorage 键**的字面量 ⇒ 新键没有时**回落读旧键**（只读、不删） |
| **与飞牛 NAS 的连通** | 飞牛侧标识（`fnos` / `fnId` / `FN_USER` / `FN_PASS` / `FN_ID` / 接口的 `fn: [...]` 数组字段）**一个字都没改** |

⚠ **但清空会「复活」旧数据** ⇒ `resumeBridge.clear()` **新旧两个键都删**（已改）。

---

## 三、改哪些文件（**仓库内 7 个**，别多改）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `package.json` | `"version": "0.4.1"` → `"0.4.2"`（**只这 1 行**） | LF |
| `package-lock.json` | root `version` **两处**（第 3 行 ＋ `packages[""].version`）→ `0.4.2` | LF |
| `docs/releases/v0.4.2.md` | **新增**：CI 的 Release 正文来源（`release.yml` 找不到这份文件会直接 **throw**） | LF |
| `docs/changelog.md` | 「当前版本」行 → `0.4.2`；**新增** `## 0.4.2 —— 2026-11-19` 段 | **CRLF**（保持原样） |
| `README.md` | **9 处**版本引用（当前版本 / 下载链接文字＋URL / 两个资产名 / 发布说明链接 / 未签名说明 / 两条 Unblock-File / 静默安装 / attestation 命令） | LF |
| `docs/superpowers/specs/2026-11-19-sanlos-music-v0.4.2-release.md` | **新增**：本规格（＋ §九 回填） | LF |
| `docs/calibration.md` / `docs/build-verification.md` | **追加**复验段 | **CRLF**（保持原样） |

⚠ **不动** `docs/packaging.md` 与 `docs/signing.md`（版本号是**流程示例**，上一版也没动）。
⚠ **不动** `docs/releases/v0.4.1.md`（**已发布** Release 的正文来源 ⇒ 改了会与线上不一致）。
⚠ **不动**历史段：`docs/changelog.md` 里 `## 0.4.1` 及其以前的段**一字不改**
（历史 changelog 是**当时的记录**，改它等于篡改历史）。
⚠ **不动** T114 / T115 的**规格与复验文档正文**（它们是**当时的记录**）。

---

## 四、发布链路（**CI 自动**，本机不打包）

```
本机：改 5 个文件 → 提交 → 推分支 → 打注解 tag v0.4.2 → 推 tag
                                            ↓
GitHub：手动 dispatch .github/workflows/release.yml
        （tag = v0.4.2，pack_only = false，sign = false）
                                            ↓
CI（windows-latest，Node 22）：
  checkout(v0.4.2) → npm ci → typecheck → test → build → pack
  → 断言产物**确实没签名**（--expect none）→ 写 latest.json
  → 产物改名归一（SanlosMusic-Setup-0.4.2.exe）
  → 签发 attestation（SLSA build provenance）
  → 拼正文（docs/releases/v0.4.2.md ＋ sha256 表 ＋ 验签说明）
  → gh release create v0.4.2（3 个资产）
```

| 决策 | 值 | 理由 |
|---|---|---|
| 签名 | **关掉（`sign=false`）** | SignPath Foundation 的申请**已被拒**（可见度不足）⇒ 签名路径**必然失败**在「Check SignPath configuration」⇒ 走**未签名路径**，替代信任锚 = **attestation** |
| `pack_only` | **false** | 要真发版（true 只出 artifact，不发 Release） |
| 本机打包 | **不做** | 产物**只能**由 CI 构建（可信构建的前提）；本机打包的包 attestation 不认 |
| 资产 | `SanlosMusic-Setup-0.4.2.exe` / `SanlosMusic-Portable-0.4.2.exe` / `latest.json` | **不带空格**（GitHub 把空格存成点 ⇒ 带空格的下载 URL 直接 404） |

⚠ **本机没有 `gh` CLI，也没有 GitHub token** ⇒ **dispatch 这一步走内置浏览器**
（GitHub 网页上的「Run workflow」）—— 浏览器带的是用户已登录的会话。

⚠ **`github.com` 网页端链路会复发**（2026-11-18 实测：DNS 指到坏 IP ⇒ 连不通；
而 **SSH 与 `api.github.com` 都正常**）⇒ **别因为网页打不开就以为没权限**。
本轮开跑前先测一次：直连通 ⇒ 直接用；不通 ⇒ 用 `release/verify/t110-proxy-pin.mjs`
（本地 CONNECT 代理 ＋ 临时改 HKCU 系统代理）⇒ **干完必须还原**
（`ProxyEnable` 复原 ＋ 关掉代理进程）。

⚠ **`workflow_dispatch` 的布尔输入按 YAML 默认值渲染** ⇒ `sign` 与 `pack_only`
**默认都是勾上的** ⇒ 不手动取消就提交 ⇒ **必然**失败在对应的检查步骤
⇒ **取消勾选后用 DOM 查 `input[type="checkbox"]:checked` 复核**
（读 `checked` **属性**不可靠）。

⚠ **push 前先确认工作区干净、HEAD 就是要打 tag 的那个提交**
⇒ tag 必须落在**版本号已 bump** 的提交之后（资产名由 `package.json` 推导）。

---

## 五、验收点

### 发布前（本机）

1. `tsc --noEmit` ⇒ **0 error**；
2. `vitest run` ⇒ **146 files / 3 024 passed / 0 failed**（既有 **2 997** 条**一条未删、断言一条未弱化**）；
3. `npm run build` ⇒ **成功**；
4. 全量 `playwright test` ⇒ **72 passed**（**一条未删**）；
5. `git diff --numstat package.json` ⇒ **只 1 行**；
6. `docs/releases/v0.4.2.md` **存在**（CI 找不到会 throw）⇒ 标签里必须有；
7. 字节体检 + 控制字符扫描（改动的文件）⇒ **0 bad**；`docs/changelog.md` **0 裸 LF**；
8. 版本回填脚本**幂等**（连跑 3 次 ⇒ sha256 三次一致）；
9. `git status` ⇒ **干净**；`package.json` 的 `version` = **0.4.2**。

### 发布后（CI 跑完）

10. Release `v0.4.2` 存在，且是仓库的 **latest**（自动更新靠 `releases/latest/download`）；
11. 资产**恰好 3 个**（Setup / Portable / latest.json）⇒ 下载 URL **不 404**；
12. `latest.json` 的 `version` = **0.4.2**、sha512 **128 位**；
13. Release 正文末尾有 **sha256 表** ＋ attestation 验法；
14. 资产 digest（sha256）与 Release 页面**逐字一致**（走 `api.github.com` 资产端点下载验一遍）。

### 装上之后（本机）

15. `app.asar` 的 `version` = **0.4.2**；注册表卸载项 = 「**Sanlos Music 0.4.2**」；
    exe `FileVersion` = **0.4.2**；
16. **真机复验 6 项**（**已发布的二进制** ＋ 真实 NAS ＋ 真实账号）：
    ① 主窗口能起来；② **曲库拉得出来**（协议改名最凶的失败模式）；
    ③ 桌面歌词仍成立（对照组普通歌 ⇒ 窗口可见、行数 > 0；有声那集 ⇒ 0 行、窗口不可见）；
    ④ 本地播放走 `sanlos-media://` **真起播**且进度推进；
    ⑤ **「检查更新」能真拉到清单**（`https://github.com/pure2199/sanlos-music/releases/latest/download`）；
    ⑥ **登录态还在**（userData 目录名 `Sanlos Music` 没变）。

---

## 六、风险与兜底

| 风险 | 兜底 |
|---|---|
| CI 跑了但 Release 没建出来 | 重跑同一个 workflow（Release 存在 ⇒ 走 upload/edit 分支，不会重复建） |
| 产物名错位（tag 里的 version 与资产名对不上） | 资产名由 `package.json` 推导 ⇒ **bump 提交必须在 tag 之前** |
| 客户端没收到更新 | 自动更新走 `releases/latest/download/latest.json` ⇒ **Release 必须是 latest** |
| 正文里的 sha256 写死 | **不写死** ⇒ 由 CI 在正文末尾**追加**（NSIS 内嵌构建时间戳 ⇒ 两次构建字节必然不同） |
| **`github.com` 网页端又连不通** | 本地 CONNECT 代理把 `github.com` 钉到可用 IP ＋ 临时改 HKCU 系统代理 ⇒ **用完还原**；**SSH 与 `api.github.com` 始终正常** ⇒ 推送与验收都不受影响 |
| `sign=true` 必然失败 | dispatch 表单里**显式取消**勾选 `sign` 与 `pack_only` ⇒ 复核 `input[type="checkbox"]:checked` 为空 |
| **装版时旧版还在跑** | 装前查进程 ⇒ 在跑就**停下来报错**，**不替用户杀进程**（用户自己开的应用） |
| **appId 断点 ⇒ 旧卸载项残留** | 先静默卸载 v0.4.1（只删安装目录，userData 不动）⇒ 只留一个干净的卸载项 |
| **T115 的真机口径** | 本轮**在已发布的二进制上**复验 6 项（源码构建那轮的口径保留在 calibration 里） |

---

## 七、明确**不做**

| 不做 | 理由 |
|---|---|
| 重新申请代码签名 | SignPath 已被拒 ⇒ 付费证书那条路用户不走 |
| 改 `docs/packaging.md` / `docs/signing.md` | 里面是**流程示例**，不是当前版本 |
| 改历史 changelog 段 / 历史规格 / 历史发布说明 | 历史是**当时的记录**，改它等于篡改历史 |
| 动 `v0.4.1` 标签 / `docs/releases/v0.4.1.md` | 已发布 ⇒ 只**新增** `v0.4.2` |
| 顺手修「发现页首载 30 秒」等**已知影响** | 那是**另一轮**工作；本轮只发版 |
| 本机打包产物 | 产物**只能**由 CI 构建（可信构建的前提） |
| 改 T114 / T115 的实现代码 | 那两批已定版并推上远端 |
| 替用户杀进程 | 用户自己开的应用 ⇒ 只**报告**，不擅自动手 |

---

## 八、⚠ 真机复验状态（**待回填**，不预写结论）

| 批次 | 真机复验 | 说明 |
|---|---|---|
| **T115**（里层改名） | ⏳ **待本轮** | 源码层已绿（tsc / Vitest 3 024 / E2E 72 / build / 字节 bad=0 / 验收探针 19 条）⇒ **本轮在已发布的二进制上复验 6 项**（口径升级） |
| **T114**（仓库改名） | ✅ **有** | 远端只剩 `sanlos-music`、API `default_branch=sanlos-music`、`master` 已删、tag `v0.4.1` 未动、提交数未变、CI success |

---

## 九、发版状态（**待回填**）

| 项 | 状态 |
|---|---|
| 规格 | ✅ 本文件 |
| 实现（7 个文件） | ⏳ 待回填 |
| 发布前验证 | ⏳ 待回填 |
| tag ＋ 推送 | ⏳ 待回填 |
| CI 出包 ＋ Release 验收 | ⏳ 待回填 |
| 装上 ＋ 真机复验 6 项 | ⏳ 待回填 |
| 复验文档 ＋ 台账 | ⏳ 待回填 |
