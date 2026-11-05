# T58 设计规格：抹除用户私有标识与凭证残留

- 日期：2026-11-06
- 触发：用户指令「**就这样，该抹除的抹除，不要留**」
- 性质：**纯文本层脱敏** —— 不改任何运行时行为

> ⚠️ **本规格一律不写私有值原值**（口令 / 自有域名 / 证书 CN / FN ID 中继域名 /
> 真实内网 IP / 真实公网 IP / 本机路径 / 会话标识）。
> 本规格只记**类别**与**替换值**；原值由执行者在本机掌握，
> 验收扫描用**一次性脚本**完成，脚本用后即删。
> —— 规格文档本身若把原值抄进来，就等于**没抹**。

---

## 1. 起因

T57 轮全面复验后，仓库与工作区里散落着**用户私有的标识**与**一行明文口令**。
这些内容对开发过程有用，但**不该留在会被提交、会被打包、会被分享的地方**。

本轮把它们一次性清干净，并给出一套**可复用的判定口径**
（哪些该抹、哪些必须留、为什么留），避免以后再判一次。

### 1.1 关键前置事实（先核实，再动手）

| 事实 | 核实方式 | 结论 |
| --- | --- | --- |
| 私有域名是否被**代码**硬编码？ | `git grep -F '<自有域名>' -- src electron shared test e2e mock-server` | **没有**。代码里只有 `<fnId>.fnos.net` / `example-fn-id` / `myfn` / `abc` / `demo` 这类**通用占位** |
| 私有域名出现在哪？ | `git grep -F '<自有域名>'` | **只在注释与文档里**（`src/lib/address.ts` 的文件头注释 + 3 份设计文档 + `docs/calibration.md`） |
| 明文口令在不在版本库？ | `git grep -F '<明文口令>'` + `git log -S '<明文口令>'` | **工作树与历史都 0 命中** —— 只在被 gitignore 的 `.superpowers/` 里 |
| 有没有别的凭证形态？ | 扫 `set-cookie` / `access_token` / `Authorization` | 已跟踪文件 **0 命中**；`Bearer` 仅出现在 `test/proxy.test.ts` 的**假 token**（`Bearer EVIL` / `Bearer RENDERER`） |

⇒ **本轮全部改动都在注释、文档与探针脚本里 → 运行时行为零变化**（验收点 6 会自证这一点）。

---

## 2. 判定口径

把命中项分成两类：**凭证 / 私有标识（抹）** 与 **产品身份 / 通用示例（留）**。

### 2.1 抹（7 类）

| # | 类别 | 原值 | 替换为 | 理由 |
| --- | --- | --- | --- | --- |
| M1 | 明文口令 | （不入仓） | 删除所在文件 | 凭证本身 |
| M2 | 用户自有反代域名 | （不入仓） | `user-proxy.invalid` | 自有域名 |
| M2 | 用户证书 CN | （不入仓） | `cert-cn.invalid` | 自有泛域名证书的 CN |
| M2 | 私有域名通配写法 | （不入仓） | `*.invalid` | 同上 |
| M3 | FN ID 中继域名 | （不入仓） | `<FN-ID>.fnos.net` | 含私有 FN ID，是**可直达 NAS 的公开 URL** |
| M4 | NAS 真实内网 IP | （不入仓） | `192.168.100.xxx` | 真实内网地址 |
| M5 | NAS 真实公网 IP | （不入仓） | `<公网 IP>` | 真实公网地址 |
| M6 | 本机真实路径 | （不入仓） | `<我的音乐>\Sanlos music` | 本机「我的音乐」目录 |
| M7 | 本机会话标识 | （不入仓） | 仓库相对路径 | 会话 ID + Windows 用户名 |

替换词的选择：

- `.invalid` 是 **RFC 2606 保留顶级域**，保证永不可解析 —— 用它当占位，
  读者一眼知道「这是脱敏后的假域名」，且不会误当真去 ping；
- `<FN-ID>.fnos.net` 与代码里**既有的**占位写法（`electron/connection.ts`、
  `shared/constants.ts`、`test/address.test.ts` 都用 `<fnId>.fnos.net`）**保持一致**，
  不引入第二套写法；
- `192.168.100.xxx` **保留网段**（让「是哪个私网段」这条信息不丢），
  只抹掉最后一段主机号。

### 2.2 留（5 类）

| # | 项 | 留下的理由 |
| --- | --- | --- |
| K1 | 开发者署名（`shared/appInfo.ts` / `package.json` / `README.md` / `test/app-info.test.ts` / `test/settings-page.test.tsx` / `e2e/smoke.spec.ts` / `docs/changelog.md` / `docs/calibration.md`） | **产品身份**：关于页「开发者」栏、安装包属性、ICP 备案主体。抹掉 = 改产品行为 + 改写 3 条既有断言（**用户未推翻该前提**） |
| K2 | 公司名 / 官网 / ICP 备案号 | 公开的法定备案信息，本就公开可见 |
| K3 | 示例 IP（RFC1918 通用示例段） | ① 通用示例 ② **产品默认预填地址**（`src/pages/LoginPage.tsx` 的 `DEFAULT_ADDRESS`）③ 约 50 处测试断言。改它 = 改产品行为 + 改一堆断言（超出本轮范围） |
| K4 | 签名常量 `SIGN_PREFIX` / `SIGN_KEY` / `FN_SIGN_KEY` | 公开的协议常量，**不是凭证** |
| K5 | 中继域名通用占位（`<fnId>.fnos.net` / `example-fn-id` / `myfn` / `abc` / `demo`） | 代码与测试里**本来就是**通用占位，不是私有值 |

> ⚠️ **K1 的残留要如实说明**：开发者署名与 FN ID 恰好是同一个字符串。
> 抹掉中继域名（M3）能挡住「拿 URL 直连 NAS」，但**挡不住**从公开署名反推 FN ID。
> 真正的收口是**轮换 NAS 账号口令**（用户侧待办）+ 若要连署名一起改，
> 需另开任务改 `shared/appInfo.ts` 并**改写**（不是删弱）3 条既有断言。

### 2.3 曲库 guid 不算私有标识

`docs/calibration.md` 里的 32 位十六进制串是**曲目 guid**，
是曲库里的公开标识，不是用户标识 → **保留**。

---

## 3. 影响文件清单

### 3.1 已跟踪（6 个）

| 文件 | 行尾 | 改动 |
| --- | --- | --- |
| `src/lib/address.ts` | LF | 文件头注释与 `isIpLiteral()` 注释里的私有域名换占位（**仅注释**） |
| `docs/calibration.md` | **CRLF** | 11 处私有值换占位；**须用脚本改并保持 CRLF** |
| `docs/superpowers/specs/2026-11-05-fnmusic-domain-port-design.md` | LF | 6 处；其中「不能把私有域名硬编码进白名单」那条论断改为不含原值的表述 |
| `docs/superpowers/specs/2026-11-05-sanlos-music-stream-quality-ready-design.md` | LF | 5 处 |
| `docs/superpowers/specs/2026-11-02-fnmusic-desktop-design.md` | LF | 2 处（IP + media 的 `src` 改相对路径） |
| `docs/superpowers/specs/2026-11-06-sanlos-music-redaction-design.md` | LF | **新**：本规格 |
| `docs/changelog.md` | LF | 新增 T58 一条（**不含任何私有值**） |

### 3.2 未跟踪 / 忽略区

| 目标 | 动作 | 规模 |
| --- | --- | --- |
| `.superpowers/` | **删**（含 M1 明文口令；gitignored 的 agent scratch；权威台账在仓库外） | 101 文件 / 3.9 MB |
| `release/verify/**` | 批量泛化 M2–M6 | ~40 文件 |
| `release/verify/tmp-build`、`release/verify/tmp-build2` | **删**（构建临时目录） | 7 文件 |
| `.pack-staging/` | **删**（11-04 旧打包中间产物） | 9 文件 / 190.6 MB |
| `.pack-staging-1793898142144/` | **先把唯一一份 `win-unpacked` 移进 `release-probe/`，再删** | 74 文件 / 265.4 MB |
| `release-probe/` | **保留**（安装包 + 便携版 + win-unpacked，用户还要用；内容不含私有标识） | 348 MB |
| 台账 `progress-ledger.md`（仓库外） | 批量泛化（12 行） | 4490 行 LF |

### 3.3 删除操作的边界

- 全部走**可恢复删除**（单条顶层 `rm -- "<绝对路径>"`，本地 runtime 转 `mavis-trash`）；
- 删前**先确认** `win-unpacked` 已移入 `release-probe/`（它曾是唯一一份免安装产物，
  T57 轮发布到 `release-probe/` 失败）；
- `.superpowers/` 与 `.pack-staging*` 均被 `.gitignore` 忽略 → **不影响 git 历史**。

---

## 4. 验收点

1. **全仓库（含 ignored）** 按 §2.1 的 7 类形态逐一扫描 → **0 命中**；
2. `git grep '<开发者署名>'` → 只剩 K1 的**开发者署名**那 8 处；
3. `git log -S '<明文口令>'` → **0 命中**（口令从未进过历史）；
4. `tsc --noEmit` exit 0；
5. `vitest` **1862 passed / 85 files**（**不增不减** —— 脱敏零行为变化）；
6. `playwright` **24 passed**；`build` exit 0；
7. **口径自证**：把 `src/lib/address.ts` 的注释改回旧文本 → **没有任何测试变红**
   （证明私有域名只存在于注释层，纯文本脱敏不影响行为）；
8. U+FFFD 扫描 **0 命中**；无 BOM；行尾保持（`docs/calibration.md` 仍 CRLF，其余保持原样）；
9. `git status` 干净；`git diff --stat` 只含 §3.1 的 7 个文件。

---

## 5. 风险与遗留

- ⚠️ **git 历史里的私有标识**：域名 / IP 这类半敏感标识**从 T 阶段早期起就在历史里**
  （本仓库**无 remote**，从未 push 过）。本轮**不重写历史** —— 沿用用户自己在
  `0361296 chore: 清除仓库中的真实 FN ID` 里立下的口径（**清当前版本，不改写历史**，
  避免 152 个 commit 的 sha 全变、台账的 sha 引用全断）。
  ⇒ **口令从未进过历史**（本轮用 `git log -S` 核实过），历史里只有域名 / IP / 路径；
  若用户要求连历史一起抹，需另开一轮重写（代价：全部 sha 变更 + 台账同步更新）。
- ⚠️ **K1 的开发者署名仍是公开信息**（见 §2.2 的说明）；
- ⚠️ 示例 IP 保留 → 文档里仍能看出「本机 NAS 曾被记成某个私网地址」这一条历史
  （校准记录里已注明它**有误**，真实值已抹成 `192.168.100.xxx`）；
- ⚠️ **未实测**：本轮是纯文本改动，不改行为 → 不需要真机回归；
  且 `docs/` 不进 electron-builder 的 `files` 清单 → 脱敏**不影响安装包**；
- ⚠️ `.superpowers/` 被删后，**superpowers 插件**若再在本工作区写 scratch 会重新建目录
  → 那时注意别把凭证写进去（探针一律用 `$env:FNM_USER` / `$env:FNM_PASS` 注入）。
