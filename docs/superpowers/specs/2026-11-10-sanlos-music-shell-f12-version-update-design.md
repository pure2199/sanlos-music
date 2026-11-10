# T82 规格 —— 外壳收尾：去掉 F12 调试入口 + 版本号 / 项目地址 + 自动更新从项目拉取

- **日期**：2026-11-10
- **状态**：已实施
- **前置**：T81（真逐字才卡拉OK）已发布 v0.2.1

---

## 一、为什么做这件事

用户提了四件事：

1. 去掉软件的 **F12** 按键调出（开发者工具）；
2. 给软件加入**版本号**；
3. 加入**项目地址**；
4. 加入**自动更新功能，从项目拉取**。

现状核对（读代码后的结论）：

| 事项 | 现状 | 缺口 |
|---|---|---|
| F12 | `electron/appShortcuts.ts` 把 **F12 / Ctrl+Shift+I 手工接回**成「打开开发者工具」（T36 为了去掉默认菜单栏的代价） | 与用户要求相反 ⇒ 要拆 |
| 版本号 | 渲染层**拿不到**版本号（sandbox + contextIsolation，碰不到 `package.json`）；只有 `update:check` 返回里带着 `current` | 需要一条 IPC + 关于页一行 |
| 项目地址 | `shared/appInfo.ts` 只有**官网** `https://www.sanlos.cn`，没有**项目地址** | 要加 + 白名单放行 |
| 自动更新 | **机制早就有**（T23：`update:check` / `update:download` / `update:install` 全在主进程） | ① 地址**默认空** ⇒ 必须手填；② 本项目**未签名** ⇒ 最后一步被签名闸挡住 |

⚠️ 第 4 项**不是**「从零写一个自动更新」，而是**把已有的机制接到项目上**。

---

## 二、判定口径

### 2.1 F12：不是「不接」，是**吞掉**

`resolveShortcut()` 若对 F12 返回 `null`，等于「不接管」——万一下面还有别的绑定（Chromium 内部、别的模块），
按键仍可能落到别处。

⇒ 改成**显式吞掉**：新增动作 `'swallow'`（拦下默认行为 + **不做任何事**）。

- F12 / Ctrl+Shift+I → `'swallow'`；
- `ShortcutTarget.openDevTools` **整个拆掉**（没人调了）；
- ⚠️ **Ctrl+C / Ctrl+V 一字不动**（那是 T36 接回来的，粘不了口令是硬伤）。

### 2.2 打包后彻底没有开发者工具

`webPreferences.devTools = !app.isPackaged`：

- **打包后**（用户手里的软件）⇒ `false` ⇒ **任何途径都开不出开发者工具**；
- **开发时**（`npm start`）⇒ `true` ⇒ 开发者仍能调试。

主窗口 / 经典悬浮窗 / 词岛 / 授权窗**四个窗口统一**。

### 2.3 版本号：**主进程是唯一真相源**

渲染层是 sandbox，**不许**读 `package.json` ⇒ 新 IPC `app:version` → `app.getVersion()`。

版本号显示在**设置 → 关于**（另有「当前版本」显示在**设置 → 更新**）。

### 2.4 项目地址：**仓库地址 + 更新源地址**是两回事

| 字段 | 值 | 用途 |
|---|---|---|
| `APP_INFO.repository` | `https://github.com/pure2199/sanlos-music` | **项目地址**（关于页显示 + 点开） |
| `APP_INFO.updateBaseUrl` | `https://github.com/pure2199/sanlos-music/releases/latest/download` | **自动更新源**（清单与安装包都在这） |

⚠️ 更新源用 **`releases/latest/download`**（不是某个具体 tag 的目录）⇒ **永远指向最新那版**，
发新版不用改代码。

⚠️ 白名单加 `github.com`，但**仍是精确匹配**（`github.com.evil.example` 不放行）。

### 2.5 自动更新：**没配地址 = 用项目地址**（主进程回落）

渲染层不碰网络、也不能指定地址 ⇒ 回落必须发生在**主进程**：

```
update:check → prefs.update.baseUrl（空则回落 APP_INFO.updateBaseUrl）
```

设置页同时给一个**「用项目地址」**按钮（一键填入并保存）。

### 2.6 签名闸：**默认一字不变**，另给一条**显式开关**

⚠️ 本项目**没有代码签名**（证书暂不办理）⇒ `verifyAuthenticode()` 对未签名包判**不通过**
⇒ 「启动安装」永远被挡。

**不能**为了「让功能能用」就悄悄把签名闸拆了（自动更新 = 远程代码执行）。
⇒ 新增偏好 `update.allowUnsigned`（**默认关**）+ 设置页开关「允许安装未签名更新」，
旁边写清风险。

开启后的判定（**只放宽「发布者身份」这一条，其余闸门一字不放**）：

| 条件 | 结果 |
|---|---|
| 有签名 且 签名者 == 预期 | 放行（原行为） |
| 未签名 且 `allowUnsigned` **开** 且 **SHA-512 与清单相符**（**启动前再验一次**） | 放行（明示「未签名」） |
| 未签名 且 `allowUnsigned` 关 | 拒绝（原行为） |
| 未签名 且 `allowUnsigned` 开 但 **SHA-512 不符** | **拒绝**（哈希是硬闸） |

⚠️ SHA-512 在**启动安装器前**再验一次（下载到启动之间文件理论上可能被换掉），
哈希来自**主进程自己缓存的清单**，不是渲染进程给的。

---

## 三、改动文件清单

| 文件 | 改什么 |
|---|---|
| `electron/appShortcuts.ts` | 删 `devtools` 动作；新增 `'swallow'`；拆 `openDevTools` 接缝 |
| `electron/main.ts` | 四个窗口 `devTools: !app.isPackaged`；`registerPlayerIpc` 传 `appVersion` |
| `electron/oauthWindow.ts` | 授权窗 `devTools: false`（加载外部页面，永远不需要调试） |
| `shared/appInfo.ts` | 加 `repository` / `updateBaseUrl`；白名单加 `github.com` |
| `shared/update.ts` | `UpdatePrefs` 加 `allowUnsigned?: boolean` |
| `shared/playerBridge.ts` | 桥加 `getAppVersion(): Promise<string>` |
| `electron/preload.ts` | 桥实现 `getAppVersion` |
| `electron/ipc.ts` | `app:version` 通道；prefs 清洗 `allowUnsigned`；`update:check` 回落项目地址；download/install 传 `allowUnsigned` |
| `electron/update.ts` | `launchInstaller` 支持 `allowUnsigned` + `expectedSha512`；控制器透传 |
| `src/state/updateStore.ts` | `allowUnsigned` 已存值 / 草稿 / 保存 |
| `src/components/SettingsPanel.tsx` | 关于页加「版本」「项目地址」；更新页加「当前版本」「用项目地址」「允许未签名」 |
| `src/components/settings-panel.css` | 新增行的样式（复用既有语义变量） |

### 测试

| 文件 | 处置 |
|---|---|
| `test/app-shortcuts.test.ts` | **改写 3 条**（前提被本任务推翻）：F12 认得 → 认得但**吞掉**；接线后调 openDevTools → **零动作**；替身没有 openDevTools → 改成「没有 copy/paste」 |
| `test/app-info.test.ts` | **改写 1 条**（白名单「就是那两条」→「就是那三条」）+ 新增项目地址/更新源断言 |
| `test/update.test.ts` | 新增 `allowUnsigned` 四条（放行 / 拒绝 / 哈希不符仍拒 / 默认关） |
| `test/app-version.test.ts`（新） | `app:version` IPC 返回主进程版本号 |
| `test/settings-page.test.tsx` | 新增：关于页显示版本 + 项目地址；更新页显示当前版本 + 未签名开关 |

⚠️ 被改写断言的**原鉴别力**要在别处**原样补回**：
「F12 不会被误认成别的动作」保留在改写后的断言里；「白名单精确匹配（不做后缀匹配）」保留在改写后的断言里。

---

## 四、验收点

1. **F12**：按下 → `preventDefault` 被调用、**没有任何动作**；`resolveShortcut` 返回 `'swallow'`。
2. **打包后** `webPreferences.devTools === false`；开发态 `=== true`。
3. **Ctrl+C / Ctrl+V** 行为**一字不变**（既有测试全绿，不许改）。
4. **关于页**：版本号 == `package.json` 的 `version`；项目地址可点开 GitHub。
5. **白名单**：`github.com` 放行；`github.com.evil.example` / `evil-github.com` **拒绝**。
6. **更新**：没配地址 → 「检查更新」**能拉到清单**（本机应得 `up-to-date`，因为当前就是 0.2.1）。
7. **签名闸**：默认 → 未签名包**拒绝启动**；`allowUnsigned` 开 → 放行；**SHA-512 不符 → 仍拒绝**。
8. **渲染层仍不能**指定安装路径 / 更新地址（老约束不破）。

---

## 五、不做什么

- **不**改自动更新的安全链条（https / 同源 / SHA-512 / 用户点击）——只加一条**显式、默认关**的未签名授权。
- **不**改版本号来源（仍是 `app.getVersion()`，与安装包 `FileVersion` 同源）。
- **不**新增 npm 依赖。
- **不**动 T81 的歌词逻辑。
