# T49 设计规格：软件更名为「Sanlos music」

- 状态：**已实施**
- 代号：T49
- 起因：用户要求「软件名改成 Sanlos music」

---

## 1. 问题：仓库里「飞牛音乐」有**两个完全不同的指代**

改名不能靠「全局替换」—— 同一个词在仓库里指的是**两样东西**：

| 指代 | 是什么 | 例子 |
| --- | --- | --- |
| **A. 本软件的品牌名** | 这个 Windows 客户端自己叫什么 | 主窗口标题、顶栏、托盘提示、关于页、安装包 exe 名、fnOS 授权页上的 `app_name`、默认下载目录名 |
| **B. NAS 上的服务端产品名** | fnOS 里那个音乐应用叫什么 | 登录页大标题「**连接飞牛音乐**」、`mock-server` 注释、`src/api/types.ts` 的「服务端返回的字段名」 |

⚠️ **B 类一个字都不能改** —— 客户端连的正是 NAS 上的飞牛音乐服务；
把登录页标题改成「连接 Sanlos music」会让用户以为连的是别的服务。

另有一类**第三类**：**内部标识符与历史文档**（`package.json` 的 `name`、`appId`、
`fnm://` 协议名、`docs/superpowers/` 下的历史计划与规格）—— 它们**不是软件名**，
且部分**有破坏性**（见第 4 节）。

## 2. 判定规则

| 类别 | 处理 | 判定依据 |
| --- | --- | --- |
| **本软件的品牌名** | ✅ 改 | 这个名字出现在**本客户端自己的界面 / 元数据**里 |
| **NAS 上的服务端产品名** | ❌ 不改 | 这个名字指的是**被连接的那个服务** |
| **内部标识符** | ❌ 不改 | 它决定的是**路径 / 协议 / 安装标识**，不是用户看到的名字 |
| **历史文档** | ❌ 不改 | 它记录的是**当时的事实**，改了就失真 |

## 3. 改名清单（14 处代码 + 4 处测试）

| 位置 | 改什么 |
| --- | --- |
| `shared/appInfo.ts` | `APP_INFO.name`（关于页 + 安装包 copyright 同源） |
| `shared/constants.ts` | `NAS_OAUTH_APP_NAME`（fnOS 授权页上的 `app_name`） |
| `src/App.tsx` | 顶栏品牌 |
| `src/pages/LoginPage.tsx` | 「认证桥不可用：请在…桌面客户端内使用」 |
| `src/components/SettingsPanel.tsx` | 下载目录输入框的 placeholder |
| `index.html` / `lyric.html` / `island.html` | 三个窗口的 `<title>` |
| `electron/tray.ts` | 托盘空闲提示 |
| `electron/oauthWindow.ts` | 授权窗标题 |
| `electron/downloadManager.ts` | `DEFAULT_DOWNLOAD_SUBDIR`（默认下载目录名） |
| `electron-builder.yml` | `productName`（**exe 文件名 + exe 产品名**） |
| `package.json` | `description` |

## 4. 明确**不动**的（含理由）

| 不动的东西 | 理由 |
| --- | --- |
| `package.json` 的 `name: fnmusic-desktop` | 它决定 **userData 目录** `%APPDATA%\fnmusic-desktop` → 改了 = **登录态（`session.bin`）与偏好全丢** |
| `appId: com.fnmusic.desktop` | 决定 **Windows 安装路径 / 注册表项 / 升级链** → 改了会被当成另一个应用（自动更新、覆盖安装都受影响） |
| `fnm://` / `fnml://` 协议名 | 协议名是**对外契约**，改了要动注册、代理、测试、文档 |
| 登录页大标题「**连接飞牛音乐**」 | 指的是**被连接的 NAS 服务**，不是本客户端 |
| `docs/superpowers/` 下的历史计划与规格 | **历史记录**，改了就失真 |
| `mock-server` / `src/api/types.ts` 注释里的「飞牛音乐 API」 | 指**服务端 API** |

## 5. 用户拍板的两项

| 决策点 | 结论 |
| --- | --- |
| 默认下载目录「我的音乐\飞牛音乐」要不要一起改名 | ✅ **一起改**（→ `我的音乐\Sanlos music`） |
| fnOS 授权页上显示的 `app_name` 要不要改 | ✅ **一起改**（→ `Sanlos music`） |

## 6. 下载目录改名的**实际影响**（关键：老文件不受影响）

- 默认下载目录**只用于「新下载」落盘**；
- 已下载的条目在索引（`downloads.json`）里存的是**绝对路径**
  → 改了默认名，**老歌照样能播、照样在列表里**；
- 本地库登记的是**索引里的路径 + 用户手动添加的文件夹** → **都不扫默认目录**
  → 不存在「老歌凭空消失」；
- 老目录 `我的音乐\飞牛音乐` **不删**（那是用户的数据，删不删由用户决定）。

## 7. 既有断言的处理（**改写，不放宽**）

前提被用户**显式**推翻（软件名改了）→ 断言**改写为新值**，一条不删、一条不放宽：

| 测试 | 改法 |
| --- | --- |
| `test/app-info.test.ts` | `APP_INFO.name` → `Sanlos music` |
| `test/tray-tooltip.test.ts` | 托盘空闲提示 → `Sanlos music` |
| `test/oauth-window.test.ts`（×2 处） | `app_name` → `Sanlos music`；URL 编码断言 → `app_name=Sanlos%20music`（**含「URL 里不是明文」那半条**） |
| `test/download-manager.test.ts` | `DEFAULT_DOWNLOAD_SUBDIR` → `Sanlos music` |

⚠️ **不动**的：`test/favorite-writeback.test.ts` 的「连接飞牛音乐」（登录页标题）；
窄窗口 E2E 的品牌宽度断言是**下限**（`≥55px`）→ 拉丁文更宽，**仍然成立**。

## 8. 验收点

1. `tsc --noEmit` 0 错；vitest 全绿；playwright 24 绿；build 0；
2. **真机**：主窗口标题、顶栏品牌、词岛标题 = `Sanlos music`；默认下载目录 = `我的音乐\Sanlos music`；
3. U+FFFD 0、无 BOM、行尾保持原样；
4. **打包产物名** = `Sanlos music.exe`（`productName` 已生效；`appId` 不变）。
