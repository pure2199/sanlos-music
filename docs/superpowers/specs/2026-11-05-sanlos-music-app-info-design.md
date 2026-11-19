# T41 设计规格：软件信息（关于页）

- 日期：2026-11-05
- 状态：**已获用户批准**（用户直接给定的信息：开发者 / 公司 / 官网 / ICP 备案号）
- 前置：T35（设置页 = 主区里的整页）、T40（窄窗口适配）

---

## 1. 背景与动机

用户要求把**软件信息**加进应用：

| 项 | 值 |
| --- | --- |
| 开发者 | `pure2199` |
| 公司 | 广西闪链时空网络科技有限公司 |
| 官网 | `https://www.sanlos.cn` |
| ICP 备案号 | `桂ICP备202507161号-1` |

⇒ 落点：**设置页新增「关于」分类**（用户自己找得到的地方），并同步到**打包元数据**与 **README**。

---

## 2. 关键设计决定

### 2.1 单一真相源：`shared/appInfo.ts`

四份信息**集中在一个模块**里 → 设置页显示它、`package.json` / `electron-builder.yml` 写同一份、
README 也抄同一份。**不各写一遍**（否则改了其中一处，另外几处就撒谎了）。

### 2.2 官网**不能**直接用 `<a href>`（这是本任务唯一的坑）

主窗口**没有**配 `setWindowOpenHandler` ⇒ 渲染层里的 `<a href="https://…">` 一旦被点，
**Chromium 会把应用窗口整个导航到那个网站** → 应用界面被替换掉，等于把软件弄坏。

⇒ 官网链接的点击处理：

1. `onClick` 里**先 `event.preventDefault()`**（拦住导航）；
2. 再请**主进程**用系统默认浏览器打开（`shell.openExternal`）。

### 2.3 白名单在**主进程**那一侧

`app:open-external` 这个 IPC 是「渲染层唯一能让主进程打开外部地址」的口子 ⇒ 白名单必须由**主进程**执行：

| 规则 | 值 |
| --- | --- |
| 协议 | **只允许 `https:`**（`http` / `file` / `javascript` / `data` 一律拒绝） |
| 主机名 | **精确匹配** `sanlos.cn` / `www.sanlos.cn`（**不做后缀匹配** → `sanlos.cn.evil.example` 不放行） |
| 账号密码 | 不许带（`https://user:pass@sanlos.cn` → 拒绝） |
| 端口 | 只允许默认 443（`https://sanlos.cn:8443` → 拒绝） |

**逻辑是纯函数**（`shared/appInfo.ts` 的 `isAllowedExternalUrl`）→ 可直接单测，不用起 Electron。
真正的「打开」动作抽到 `electron/externalLinks.ts`（**依赖注入**）→ 单测里喂替身，
不会在测试机上真的拉起浏览器。

### 2.4 主进程侧沿用既有约定

- `electron/ipc.ts` 的**模块顶层不得 import Electron**（它要能在 Vitest 里单测）→
  `shell` 一律**惰性解析**（`resolveShell()`），与既有的 `resolveIpcMain()` 一个套路；
- `registerPlayerIpc` 的参数**全部可注入** → 新增可选的 `openExternal`（单测注入替身）。

### 2.5 版本号：**不做**

「关于」页只放用户给的四项 + 应用名。**版本号**要经主进程 `app.getVersion()` 取，
需要再加一条 IPC + 加载态 → 本轮**不扩范围**（要的话再加）。

---

## 3. 影响文件清单

| 文件 | 改动 |
| --- | --- |
| `shared/appInfo.ts` | **新**：软件信息 + 外部链接白名单判定（纯函数） |
| `electron/externalLinks.ts` | **新**：`openExternalUrl()`（纯函数 + 依赖注入） |
| `electron/ipc.ts` | 新增 `app:open-external` 通道 + `resolveShell()` + `openExternal` 注入点 |
| `electron/preload.ts` | `fnPlayer.openExternal(url)` |
| `shared/playerBridge.ts` | `PlayerBridge.openExternal(url)` |
| `src/components/SettingsPanel.tsx` | 新增「关于」分类 + 内容 + 官网点击处理 |
| `src/components/settings-panel.css` | 「关于」信息表样式（只用语义变量） |
| `package.json` | `author` / `homepage` |
| `electron-builder.yml` | `copyright` |
| `README.md` | 新增「九、软件信息」 |
| `test/app-info.test.ts` | **新**：白名单规则 |
| `test/external-links.test.ts` | **新**：放行 / 拒绝 / 失败不炸 |
| `test/settings-page.test.tsx` | 分类数 5 → 6（**前提被用户显式推翻 → 改写为新行为断言**）+ 新增 3 条「关于」断言 |
| `test/tray-tooltip.test.ts` | IPC 通道集合 +1（同样**改写为新行为**）+ 2 条 `app:open-external` 行为断言 |
| `test/media-session.test.ts` | 假桥**只加** `openExternal` 空实现（CRLF → 用脚本写回） |
| `e2e/smoke.spec.ts` | 新增 1 条：「设置 → 关于」显示四件套（**只断言显示，不点链接** → 不会在测试机上拉起浏览器） |

---

## 4. 验收点

1. `tsc --noEmit` exit 0；
2. `vitest` 全绿且**总数 ≥ 1652**（既有断言一条不改；两处因**前提被用户显式推翻**而**改写**为新行为断言）；
3. `playwright` 既有 23 条 + 新增 1 条全绿；
4. **变异自证**（先红后复原）：
   - 放宽协议（允许 `http`）→ 白名单单测红；
   - 去掉 `openExternalUrl()` 的白名单校验 → 外链单测红；
   - 去掉 `preventDefault()` → 设置页单测红；
5. U+FFFD 扫描 0、无 BOM、行尾保持原样（`docs/calibration.md` / `test/media-session.test.ts` 仍 CRLF）；
6. 真机观感：「设置 → 关于」四件套齐全、官网点击**用系统浏览器打开**、**应用窗口不被导航走**。

---

## 5. 风险与待校准

- ⚠️ **白名单是按当前官网定的**：以后要加别的官方链接（如帮助文档、GitHub 仓库），
  得**显式**往 `EXTERNAL_LINK_ALLOWED_HOSTS` 里加（不自动放宽）。
- ⚠️ 「关于」分类加了以后，**设置页左侧导航变成 6 项** → 既有那条「五个分类」的断言已按新行为改写。
- ⚠️ **版本号未显示**（见 §2.5）。
