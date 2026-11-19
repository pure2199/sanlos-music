# T115 设计规格：里层命名全量改名（`fnm` / `fnmusic` ⇒ `sanlos`）

- 状态：**已实施**
- 代号：T115
- 起因：T114 把仓库默认分支改成了 `sanlos-music`，但**里层**（包名 / appId / 自定义协议 /
  CSS 类名前缀 / preload 桥名 / 环境变量 / 工具脚本文件名 / 老规格文件名）**还全是旧代号**。
- 用户拍板：**「全改」**、**「以前版本不用理」**、**「后面版本能更新就行」**（现在没有用户，都是自己在用）

---

## 1. 问题：里层还有哪些旧代号

T114 之前的清点（`release/verify/t115-01-scan-legacy-names.mjs`）：

| 扫描目录 | 文件数 | 旧代号命中 |
| --- | --- | --- |
| 入库目录（不含 gitignore 的 `release/`） | 519 | **3373 处** |

按 token 分组：`fnm-` **2200**、`fnm`（独立词）**331**、`fn-` **302**、`fnmusic` **189**、
`fnPlayer` **139**、`FN-Music` **126**、`FNM_` **86**、camelCase 变体 **0**。

⚠️ **为什么不能「全局替换」**：同一个词在仓库里指的是**四样不同的东西**，
其中两样**一个字都不能动**：

| 指代 | 是什么 | 例子 | 处理 |
| --- | --- | --- | --- |
| **A. 本客户端的内部标识** | 包名 / appId / 协议名 / CSS 前缀 / 桥名 / 环境变量 | `fnm://`、`fnm-app__nav`、`window.fnPlayer` | ✅ **全改** |
| **B. NAS 服务端的东西** | 飞牛 NAS 的产品名与接口字段 | 飞牛音乐、`fnos.net`、`fnId`、连接接口返回的 `fn: [...]` 数组、`FN_USER`/`FN_PASS`/`FN_ID` | ❌ **一个字都不动** |
| **C. 历史事实** | 历史产物名、旧 userData 目录名、历史文档里的事实 | `FN-Music-Setup-0.2.4.exe`、`fnmusic-desktop`（旧 userData 目录）、changelog 里的实测记录 | ❌ **不动** |
| **D. 第三方项目名** | 别人的仓库 | `XDORG-N1/FnMusic`（Apache-2.0） | ❌ **不动** |

⚠️ **B 类里最阴险的一个**：`fn` 既是「本客户端的认证桥全局名」（`window.fn`），
    **也是飞牛连接接口返回的数组字段名**（`fn: ['xxx.fnos.net:443']`），
    **还是 Vitest 的 `vi.fn()`**（672 处）。
    ⇒ 任何「把 `fn` 换成 `sanlosAuth`」的全局规则都必然误伤 ⇒ 只能**逐文件点名**。

---

## 2. 判定规则

| 规则 | 内容 |
| --- | --- |
| **R-A 当前态** | `src` / `electron` / `shared` / `test` / `e2e` / `mock-server` / `scripts` / `tools` / `.github` / 根级配置 / `README.md` / `THIRD_PARTY_NOTICES.md` / `CODE_SIGNING_POLICY.md` / `docs/packaging.md` / `docs/signing.md` ⇒ **全量改** |
| **R-B 历史文档** | `docs/changelog.md` / `docs/calibration.md` / `docs/build-verification.md` / `docs/releases/*.md` / `docs/superpowers/{specs,plans}/*.md` ⇒ **内容一个字都不改**（那是当时的事实）；**只**允许改「指向被改名文件的路径指针」 |
| **R-C 白名单** | `FN-Music-*`（历史产物名 ＋ 归一化测试输入）/ `FnMusic`（第三方仓库）/ `RequireFn`（Node 的 `require`）/ `FN_*`（飞牛侧变量）/ `fnmusic-desktop`（旧 userData 目录名 ＋ 迁移源） ⇒ **原样保留** |
| **R-D 指针规则** | 指针随文件走：`tools/fn-*` ⇒ `tools/sanlos-*`；被改名的 spec/plan 文件名 ⇒ 新名 |

⚠️ **R-B 的道理**：`docs/superpowers/specs/2026-11-02-fnmusic-desktop-design.md` 里写着
「基址常量 `const BASE = 'fnm://srv'`」——那是 **2026-11-02 当天真的这么写的**。
把它改成 `sanlos://srv` 就是**篡改历史**（读的人会以为 11-02 就长这样）。
⇒ 历史文档**只改文件名，不改正文**；**例外**只有「指向被改名文件的指针」——
    因为被指向的文件真改名了，指针不改就是**死链**（改的是指针，不是事实）。

---

## 3. 完整改名映射表

| # | 旧 | 新 | 作用面 |
| --- | --- | --- | --- |
| 1 | `com.fnmusic.desktop` | `com.sanlos.music` | **appId**（`electron-builder.yml`） |
| 2 | `fnmusic-desktop`（包名） | `sanlos-music` | `package.json` / `package-lock.json` 两处 |
| 3 | `fnm://` / `FNM_SCHEME='fnm'` | `sanlos://` / `SANLOS_SCHEME='sanlos'` | NAS 代理协议 |
| 4 | `fnml://` / `FNML_SCHEME='fnml'` / `LOCAL_MEDIA_SCHEME='fnml'` | `sanlos-media://` / `SANLOS_MEDIA_SCHEME='sanlos-media'` | 本地媒体协议 |
| 5 | `fnm-`（CSS 类名前缀、元素 id） | `sanlos-` | `src/**/*.css` / `*.tsx` / `index.html` / `lyric.html` / `island.html` / `test` / `e2e` |
| 6 | `fnPlayer`（preload 播放器桥） | `sanlosPlayer` | `electron/preload.ts` / `shared/playerBridge.ts` / `src/**` / `test/**` |
| 7 | `fnmusic`（preload 平台信息桥） | `sanlos` | `electron/preload.ts` / `src/vite-env.d.ts` / `test/login-page.test.tsx` |
| 8 | `fn`（preload 认证桥全局名）/ `FnBridge`（类型） | `sanlosAuth` / `AuthBridge` | `electron/preload.ts` / `shared/bridge.ts` / `src/lib/bridge.ts` / `src/vite-env.d.ts` / `test/app-guest-nav.test.tsx` / `test/login-page.test.tsx` |
| 9 | `FNM_*`（本客户端自己的环境变量） | `SANLOS_*` | `SANLOS_PACK_OUTPUT` / `SANLOS_CSC_AUTO_DISCOVERY` / `SANLOS_EXPECT_SIGNER_CN` / `SANLOS_CHART_URL` / `SANLOS_UPDATE_DIR` / `SANLOS_LYRIC_SOURCES` |
| 10 | `fnmusic-local-history` / `fnmusic-resume` / `fnmusic-lyric-overrides` | `sanlos-local-history` / `sanlos-resume` / `sanlos-lyric-overrides` | `localStorage` 键（**带旧键回落**，见 §5） |
| 11 | `registerFnmSchemePrivileges` | `registerSanlosSchemePrivileges` | `electron/proxy.ts` / `test/proxy.test.ts` |
| 12 | `tools/fn-*`（**37 个**） | `tools/sanlos-*` | 文件名 ＋ 全仓引用 |
| 13 | `docs/superpowers/{specs,plans}/*fnmusic*`（**14 个**） | `*sanlos-music*` | 文件名 ＋ 全仓引用 |
| 14 | `fnmusic-update`（更新目录） | `sanlos-update` | `electron/main.ts` |
| 15 | `FNMUSIC_OPENSSL` | `SANLOS_OPENSSL` | `tools/fn-httstack-verify.mjs` |

### 3.1 白名单（**一个字都不动**）

| 白名单 | 为什么 |
| --- | --- |
| `LEGACY_USER_DATA_DIR_NAME = 'fnmusic-desktop'` | **迁移源**（`electron/userDataDir.ts`）——删了就要删 T89 的迁移逻辑 ＋ 它的测试 ⇒ 违反「既有测试一条不许删」 |
| `fnmusic-desktop`（其余出现处） | 旧 userData 目录名 = 历史事实（`electron/main.ts` 注释、历史文档） |
| `FN-Music-Setup-*` / `FN-Music-Portable-*` | **历史产物名**（v0.2.8 及以前真的叫这个）＋ T89-㉔ 归一化测试的**输入** |
| `FnMusic` | 第三方开源项目 `XDORG-N1/FnMusic`（Apache-2.0）的名字 |
| `RequireFn` | Node 的 `require` 函数类型，**与本项目代号无关** |
| `FN_USER` / `FN_PASS` / `FN_ID` / `FN_SERVER` / `FN_SIGN_KEY` / `FN_CON_*` / `FN_SEED_FILE` | **飞牛 NAS 侧**的变量名（真机探针用来连 NAS） |
| `fnos` / `fnId` / `fnid` / `myfn` / `fn`（NAS 接口字段） | 飞牛侧概念 |

---

## 4. 协议改名的**联动清单**（最容易漏的地方）

`fnm://` ⇒ `sanlos://` 不是「改个字符串」，它牵动**六处必须同步**的地方：

| 联动点 | 位置 | 漏了会怎样 |
| --- | --- | --- |
| **协议注册** | `electron/schemes.ts`（`registerAppSchemes()` —— **两个 scheme 必须合并成一次** `registerSchemesAsPrivileged`） | ⚠️ **静默覆盖**：只注册一次 ⇒ 另一个 scheme 的特权没了 ⇒ 渲染层 `fetch` 抛 `TypeError: Failed to fetch` ⇒ **整个曲库拉不出来**，而**单测全绿** |
| **CSP** | `index.html` / `lyric.html` / `island.html` 的 `img-src` / `media-src` / `connect-src` | 漏放行 ⇒ Chromium 的 URL 安全检查**直接拒绝** ⇒ 封面空白 / 本地播不了 |
| **客户端基址** | `src/api/client.ts` 的 `const BASE = 'sanlos://srv'` | 全部 API 请求打不出去 |
| **主进程代理** | `electron/proxy.ts`（`SCHEME` ＋ `protocol.handle`） | 代理不认这个 scheme ⇒ 全部 404 |
| **本地媒体** | `shared/localMedia.ts` 的 `LOCAL_MEDIA_SCHEME` ＋ `electron/localMedia.ts` | 本地曲目播不了 |
| **常量名** | `FNM_SCHEME` ⇒ `SANLOS_SCHEME`、`FNML_SCHEME` ⇒ `SANLOS_MEDIA_SCHEME` | 编译不过 |

⚠️ **`fnml://` 单独改成了 `sanlos-media://`**（而不是 `sanlosl://`）：
    `sanlos` 与 `sanlos-media` 两个 scheme **仍然合并成一次注册**（不改注册结构 ⇒ 不动那条「只能调用一次」的铁律），
    但名字自解释 ⇒ 半年后看代码不用猜 `l` 是什么。

---

## 5. `localStorage` 用户数据：**旧键回落**（不许静默丢数据）

三个键存的是**用户自己的数据**：

| 键 | 存什么 | 丢了会怎样 |
| --- | --- | --- |
| `fnmusic-local-history` | 本机播放记录（100 条） | 「本机记录」页空掉 |
| `fnmusic-resume` | 上次播到第几秒 | 续播失效 |
| `fnmusic-lyric-overrides` | T107「按歌指定歌词源」 | 每首歌的指定全丢 |

⇒ 改键名**必须**带**旧键回落**：读新键；**新键没有**才读旧键（旧键**不删**，只读）。
    之后第一次写入自然落到新键 ⇒ **一次性迁移、幂等、零删除**。

⚠️ **为什么不能用「全局替换」**：旧键名必须是**原样**的（它就是数据在磁盘上的样子）
    ⇒ 改键名这件事**不能**走「把 `fnmusic` 全换成 `sanlos`」的批量规则。

---

## 6. `appId` 改动的后果（**一次性断点**，用户已确认接受）

`com.fnmusic.desktop` ⇒ `com.sanlos.music` ⇒ NSIS 的**卸载项 GUID / 注册表项 / 安装目录标识**全变
⇒ **v0.4.1 ⇒ 新版本不是「原地升级」**，Windows 会认为是**另一个应用**：

- 旧版会**残留**在「已安装的应用」里（需手工卸载）；
- ⚠️ **但 userData 目录不受影响**（userData 目录名 = `productName` = `Sanlos Music`，
  **与 `name` / `appId` 无关**）⇒ **登录态（`session.bin`）、偏好、本机记录都不丢**。

⇒ **从本版起 `appId` 固定 ⇒ 之后版本之间升级正常**（这正是用户要的「后面版本能更新就行」）。

⚠️ 更新链（清单 / sha512 / attestation / 签名闸门）**与名字无关** ⇒ 一行都不用改。

---

## 7. 文件改名清单（**51 个**）

| 组 | 数量 | 改法 |
| --- | --- | --- |
| `tools/fn-*` ⇒ `tools/sanlos-*` | **37** | `git mv`（保留历史） |
| `docs/superpowers/specs/2026-11-*‑fnmusic-*.md` ⇒ `…‑sanlos-music-*.md` | **13** | `git mv` |
| `docs/superpowers/plans/2026-11-02-fnmusic-desktop.md` ⇒ `…-sanlos-music-desktop.md` | **1** | `git mv` |

⚠️ `release/verify/fnm-*`（**约 150 个**，`release/` 是 gitignore）**一个都不改**：
    那是历史一次性脚本，改名会让**台账与历史文档里的引用全部变成死链**。
    ⇒ 新写的验证脚本一律用 `t115-*` 前缀。

---

## 8. 执行方式（**规则驱动**，不手改）

> 一次跨 500+ 文件、3000+ 处的机械改名，手改必然漏；
> 而「漏一处」的后果是**运行时才炸**（协议名 / 类名 / 桥名三者不同步）。
> ⇒ 改名必须是**规则驱动 + 可重放 + 可复核**的。

`release/verify/t115-03-apply-rename.mjs`：

1. **规则表有序**（每条都写明为什么必须在这个位置；乱序 ⇒ `fnml` 被 `fnm` 规则先吃掉）；
2. **保护机制**：先把必须保留的字面量换成哨兵 → 跑规则 → 再还原；
3. **文件作用域规则**：认证桥的 `fn` 与飞牛的 `fn` 同形 ⇒ 只能**逐文件点名**；
4. **dry-run 报告**：逐行 diff 供人工判读（本次逐条看过 274 个文件的改动）；
5. **幂等**：再跑一次 ⇒ 0 处改动。

实测规模：扫 **522** 个文本文件 ⇒ 改写 **274** 个 + 改名 **51** 个。

---

## 9. 既有测试的处理（**一条不删、断言一条不弱化**）

前提被用户的新要求**显式推翻**（「全改」）⇒ 断言**改写为新值**（不是放宽）：

| 测试 | 处理 |
| --- | --- |
| `test/api-client.test.ts` | 请求 URL 断言 `fnm://srv/…` ⇒ `sanlos://srv/…`（**逐字改值**，不是「包含任一」） |
| `test/local-playback-source.test.ts` | `fnml://` ⇒ `sanlos-media://` |
| `test/proxy.test.ts` | `registerFnmSchemePrivileges` ⇒ `registerSanlosSchemePrivileges`；scheme 形状断言改新名 |
| `test/resume-playback.test.ts` | `fnmusic-resume` ⇒ 拆成**新键**（主路径）＋**旧键回落**（新增迁移用例） |
| `test/csp-media-src.test.ts` | 走常量 ⇒ 自动跟随；**并新增**「CSP 里不许再出现 `fnm:` / `fnml:`」的钉子 |
| `test/user-data-dir.test.ts` | **一个字都不改**（白名单：旧目录名 ＋ 迁移源） |
| CSS 选择器 / `vi.fn()` / NAS 接口的 `fn` 字段 | **一个字都不改**（不是本项目代号） |

⇒ **新增**一条钉子测试：协议名 / 桥名 / appId / 包名 / 环境变量前缀**必须**是新的，
    且**旧名只允许**出现在白名单里（`LEGACY_USER_DATA_DIR_NAME`、历史产物名、第三方仓库名）。

---

## 10. 验收点

1. `tsc --noEmit` **0 错**；`vitest` **全绿**（既有 2997 条**一条不删**）；`playwright` **全绿**（既有 72 条**一条不删**）；`npm run build` **0**；
2. `release/verify/fnm-bytes-check.mjs` + `release/verify/t89-19-scan-control.mjs` ⇒ **bad=0**；
3. 改名脚本**连跑两次** ⇒ 第二次 **0 处改动**（幂等）；
4. **残留扫描**：旧代号命中**只**落在白名单里（历史文档正文 ＋ §3.1 白名单）；
5. **协议联动**：三个 HTML 的 CSP 都放行 `sanlos:` 与 `sanlos-media:`，且**都不再**有 `fnm:` / `fnml:`；
   `electron/schemes.ts` 的 `registerAppSchemes()` **一次**注册**两个** scheme；
   `src/api/client.ts` 的 BASE = `sanlos://srv`；
6. `preload` 暴露 `sanlos` / `sanlosAuth` / `sanlosPlayer`，**不再**有 `fnmusic` / `fn` / `fnPlayer`；
7. `package.json` `name` = `sanlos-music`（`productName` 仍 `Sanlos Music`）、`appId` = `com.sanlos.music`；
8. `LEGACY_USER_DATA_DIR_NAME` **仍**是 `'fnmusic-desktop'`；
9. `FN-Music-*`（历史产物名）在 `CODE_SIGNING_POLICY.md` / `README.md` / `release.yml` **仍在**；
10. 行尾 / BOM / U+FFFD：与改名前**逐字一致**（只替换标识符，不动换行）。

---

## 11. 真机复验清单（**待装新版后做**）

| # | 项 | 判据 |
| --- | --- | --- |
| 1 | 主窗口能起来 | 界面正常（截图） |
| 2 | **曲库能拉出来** | ⭐ 协议改名最凶的失败模式就是「曲库空」⇒ 必须真机拉一次 |
| 3 | 桌面歌词仍成立 | 对照组 262 行⇒可见；有声那集 0 行⇒不可见（T112 没被改坏） |
| 4 | 本地播放 | `sanlos-media://` 路由 ⇒ 真 `<audio>` 起播且进度推进 |
| 5 | **「检查更新」能真拉到清单** | baseUrl = `https://github.com/pure2199/sanlos-music/releases/latest/download` |
| 6 | 登录态还在 | `userData` 目录名没变 ⇒ 不用重新登录 |

---

## 12. 风险与回退

| 风险 | 兜底 |
| --- | --- |
| 协议注册漏一处 ⇒ 曲库空 | 验收点 5 + 真机第 2 项 |
| CSP 漏放行 ⇒ 封面空白 / 本地播不了 | 验收点 5（`test/csp-media-src.test.ts` 已钉） |
| `localStorage` 键改名 ⇒ 用户数据丢 | §5 的旧键回落（**只读回落，不删旧键**） |
| appId 变 ⇒ 不能原地升级 | 用户已确认接受；旧版残留需手工卸载 |
| 改名脚本漏改 | dry-run 报告逐行判读 ＋ 残留扫描 ＋ 幂等复跑 |

**回退**：三个 commit（规格 / 实现 / 复验）⇒ `git revert` 或 `reset --hard` 到 `cb19599` 即可。

---

## 13. 执行记录（回填）

**已完成**（2026-11-19）。

| 项 | 实测 |
|---|---|
| 改动规模 | 改写 **274** 个文件的内容（**2816** 增 / **2816** 删 ⇒ 完全对称 ⇒ 纯标识符替换）＋ `git mv` 改名 **51** 个文件（`tools/fn-*` **37** ＋ `docs/superpowers/**fnmusic*` **14**） |
| 验收探针 | `release/verify/t115-05-verify-rename.mjs` ⇒ **19 条全过** ⇒ **RENAME_OK** |
| 类型检查 | `tsc --noEmit` ⇒ **0 错** |
| 单元测试 | **146** 个文件 / **3024** 条 ⇒ **全绿**（改名前 145 / 2997 ⇒ 既有 **2997 条一条不删**；新增 **27** 条契约钉子） |
| E2E | Playwright **72** 条 ⇒ **全绿**（既有 72 条一条不删） |
| 构建 | `npm run build` ⇒ **0** |
| 字节体检 ＋ 控制字符 | **bad=0** |
| 幂等 | 改名脚本连跑两次 ⇒ 第二次 **0 处改动** |
| 新增钉子 | `test/t115-rename-contract.test.ts`（**27** 条）：包名 / appId / 环境变量前缀 / **协议一次注册两个** / 三页 CSP / preload 桥名 / 旧代号白名单 / 文件改名 / **`localStorage` 旧键回落** |

**既有测试的处理**（前提被用户的新要求**显式推翻** ⇒ 断言**改写为新值**，**一条不删、一条不弱化**）：

| 测试 | 改法 |
|---|---|
| `test/user-data-dir.test.ts` | `name` 的断言改写为 `sanlos-music`；**并补** `expect(pkg.name).not.toBe(USER_DATA_DIR_NAME)`（不变量「目录名取自 `productName`」**原样钉住**） |
| `test/resume-playback.test.ts` | 「偏好文件里不该出现续播键」的断言**加钉**旧键名（旧键也不许进 `prefs.json`） |
| `test/api-client.test.ts` / `test/local-playback-source.test.ts` / `test/proxy.test.ts` | URL / scheme 断言**逐字改值**（不是「包含任一」） |
| CSS 选择器 / `vi.fn()` / 飞牛接口的 `fn` 字段 | **一个字都不改**（不是本项目代号） |

**新增的用户数据迁移**（三个 `localStorage` 键 ⇒ 新键没有才**回落读旧键**，旧键只读、不删）：
`shared/legacyStorageKeys.ts`（旧键字面量的**唯一居所**，改名脚本跳过它）＋
`src/state/historyStore.ts` / `src/player/resumeBridge.ts` / `src/state/lyricOverrideStore.ts`。
⚠️ **「清空」两个键都删**（只删新键 ⇒ 下次读回落到旧键 ⇒ 用户点了「清空」记录却复活）。

**顺手修的 bug**：`tools/sanlos-ui-repro.mjs` 原先指着旧 userData 目录名 `fnmusic-desktop`
⇒ 复制的是**一个不存在的目录** ⇒ 探针起不来 ⇒ 改成**从 `package.json` 读 `productName`**。

**⚠️ 待真机复验**（要装上**改名后的构建**才能验）：

| # | 项 | 判据 |
|---|---|---|
| 1 | 主窗口能起来 | 界面正常（截图） |
| 2 | **曲库能拉出来** | ⭐ 协议改名最凶的失败模式就是「曲库空」 |
| 3 | 桌面歌词仍成立 | 对照组 262 行⇒可见；有声那集 0 行⇒不可见（T112 没被改坏） |
| 4 | 本地播放 | `sanlos-media://` 路由 ⇒ 真 `<audio>` 起播且进度推进 |
| 5 | **「检查更新」能真拉到清单** | baseUrl = `https://github.com/pure2199/sanlos-music/releases/latest/download` |
| 6 | 登录态还在 | userData 目录名没变 ⇒ 不用重新登录 |

**⚠️ 发版提醒**：本轮改了 `appId` ⇒ **需要发一个新版本**（v0.4.2）才能让用户装到改名后的构建；
v0.4.1 ⇒ v0.4.2 **不是原地升级**（卸载项 GUID 变，旧版会残留，需手工卸载）。
