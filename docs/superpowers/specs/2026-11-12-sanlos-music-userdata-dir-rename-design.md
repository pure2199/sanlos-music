# T89-②：userData 目录改名 —— `%APPDATA%\fnmusic-desktop` → `%APPDATA%\Sanlos Music`

> 日期：2026-11-12
> 状态：设计已定，待实现
> 关联任务：T89-②（用户指令「1.2.3.4.6 都做」的第 2 项）

---

## 一、问题

软件早已改名「Sanlos Music」（T49/T50），但**用户数据目录**还叫 `fnmusic-desktop`：

```
C:\Users\<user>\AppData\Roaming\fnmusic-desktop\
  prefs.json           （偏好：更新地址、歌词源、下载目录、窗口位置…）
  session.bin          （DPAPI 加密的登录凭据）
  local-library.json   （本地曲目登记）
  Local Storage\  Network\  Preferences\  Cache\  …  （Chromium 自己的）
```

用户看到的是「一个叫 fnmusic-desktop 的陌生文件夹」，与软件名对不上。

**为什么不能直接改名**：改了目录，用户升级后就是**配置与凭证全丢**（看着像「登录被踢了」），
而且这种丢法**不会报错**、最难排查。

⚠️ 目录名不是随便定的：`package.json` 的 `name` 决定 Electron 的
`app.getName()` ⇒ 决定 userData 默认路径。**`appId`（`com.fnmusic.desktop`）不能动**
—— 它决定 Windows 安装路径 / 注册表项 / 升级链，改了会被当成另一个应用。

---

## 二、探针实测（**不靠猜**）

`release/verify/t89-2-userdata-probe.cjs`（独立脚本）+
`release/verify/t89-2-probe-app/`（带真实 `package.json` 的探针应用）。

| # | 问题 | 实测结果 |
|---|---|---|
| ① | `app.getPath('appData')` 在 ready 之前能取到吗？ | ✅ 能 = `C:\Users\<user>\AppData\Roaming` |
| ② | `app.setPath('userData', …)` 在 ready 之前能用吗？要目录已存在吗？ | ✅ 能，**且不要求目录已存在**（探针指向一个两段的不存在路径，`setPathOk: true`） |
| ③ | ⚠️ `app.setPath('userData', …)` 会不会**覆盖** `--user-data-dir`？ | ⚠️⚠️ **会**！探针 B：`userDataBefore` = 开关给的临时目录，`setPath` 之后变成我们指定的新路径 ⇒ **`setPath` 这条路会摧毁 E2E 的隔离**（E2E 靠 `--user-data-dir` 隔离用户数据，见 `e2e/helpers/app.ts` 第 18–23 行） |
| ④ | `package.json` 加 `productName` 会怎样？ | ✅ `app.getName()` = `Sanlos Music`，userData = `%APPDATA%\Sanlos Music`；⚠️ **但带 `--user-data-dir` 时开关仍然优先**（探针 C3：userData = 临时目录）⇒ **E2E 隔离不受影响** |
| ⑤ | ⚠️ 模块第一行时，userData 目录**已经被创建**了吗？ | ⚠️ **已经创建了，而且是空的**（探针 C1：`existsAtFirstLine: true` 而 `entriesAtReady: []`）⇒ **Electron 在跑 main.js 之前就把目录建好了** ⇒ 迁移**不能**指望「目标目录不存在」，只能走「逐项搬入 + 同名不覆盖」 |

**结论：走 `package.json` 的 `productName`，不要走 `app.setPath`。**

---

## 三、方案

### 3.1 目录名来源：`package.json` 加一行 `productName`

```jsonc
{
  "name": "fnmusic-desktop",        // ⚠️ **保留**：它是包标识，也是旧 userData 目录名的由来
  "productName": "Sanlos Music",    // ← 新增：Electron 用它算 userData 目录名
  "version": "0.2.5",
}
```

- ⚠️ **`name` 不删**：删了会让 `npm` 包名变化，也会让「旧目录叫什么」这件事失去依据。
- ⚠️ **`appId` 不动**（`electron-builder.yml` 里 `com.fnmusic.desktop`）—— 安装路径 / 注册表 / 升级链。
- ⚠️ `electron-builder.yml` 已有 `productName: Sanlos Music` ⇒ **打包产物名/安装包名一字不变**。
- ✅ **E2E 不用改**：`--user-data-dir` 优先于 productName（实测 C3）。

### 3.2 迁移：把旧目录的**内容**搬进新目录

⚠️ **不能整目录 rename**：Electron 已经把空的新目录建好了（实测⑤）⇒ `rename(legacy, target)`
会失败（目标已存在）。

⇒ **逐项搬入**（每项一次 `rename`，同卷 ⇒ 原子且 O(1)）：

```
legacy = <appData>\fnmusic-desktop
target = <appData>\Sanlos Music

对 legacy 里的每一项：
    若 target 里**没有**同名项 ⇒ 搬进去（rename）
    若 target 里**已有**同名项 ⇒ **跳过**（不覆盖），该项留在 legacy 里
搬完后：
    在 target 里写标记文件 userdata-migration.json
    若 legacy 已空 ⇒ 删掉这个空目录
```

**为什么「同名不覆盖」**：新目录是 Electron 刚建出来的（空的）⇒ 正常升级路径下
**没有同名项** ⇒ 全部搬过去，**一个字节都不丢**。只有在异常场景（目标已被写过）
才跳过，此时**旧的那份留在 legacy 里不删** ⇒ 回滚到旧版本仍然可用。

**不删任何用户数据**：搬 = 改名（源路径消失、内容不丢）；跳过的项**原地保留**。
唯一被删除的是「搬空之后的 legacy 空目录」。

### 3.3 守卫：**只在「默认 userData」时迁移**

⚠️⚠️ **这是本任务最容易造成灾难的地方**：`app.getPath('appData')` 恒等于真实的 `%APPDATA%`，
而 `app.getPath('userData')` 可以被 `--user-data-dir` 改到别处（E2E 就是这么干的）。
若不设守卫，**每次跑 E2E 都会把用户真实的 `fnmusic-desktop` 搬走**！

⇒ 守卫条件（两者**都**满足才迁移）：

1. `resolve(app.getPath('userData')) === resolve(join(app.getPath('appData'), 'Sanlos Music'))`
   —— 即「当前用的就是默认目录，没被人为改过」；
2. `app.getPath('userData')` 与 `join(app.getPath('appData'), 'fnmusic-desktop')` **不是同一个目录**
   —— 即「确实存在一个旧目录要迁」。

守卫不通过 ⇒ **什么都不做**（`status: 'skipped'`），只记一行日志。

### 3.4 标记文件

`target/userdata-migration.json`：

```json
{ "version": 1, "from": "fnmusic-desktop", "to": "Sanlos Music", "moved": ["prefs.json", "session.bin", "…"], "skipped": [] }
```

- 作用 1：**幂等**。第二次启动看到标记 ⇒ 直接跳过（不再搬、不再写）。
- 作用 2：**可解释**。用户问「我的数据去哪了」，这个文件能回答。
- 作用 3：**回滚锚点**。回滚到 v0.2.5 时，legacy 已被搬空 ⇒ 旧版本会看到「未登录」。

### 3.5 调用时机

`electron/main.ts` **模块作用域最前面**（`registerAppSchemes()` 之前）⇒ 早于
`app.whenReady()` ⇒ 早于 Chromium 读 profile（`Local Storage` / `Preferences` /
`Network/Cookies` 都是 ready 前后由 Chromium 装载）⇒ 搬过去的 Chromium 数据**能被读回来**。

---

## 四、影响文件清单

| 文件 | 改动 |
|---|---|
| `package.json` | **+1 行** `"productName": "Sanlos Music"` |
| `electron/userDataDir.ts` | **新增**：目录名常量 + 迁移算法（纯函数、fs 可注入 ⇒ 可单测） |
| `electron/main.ts` | 模块作用域调用迁移 + 打一行日志 |
| `test/user-data-dir.test.ts` | **新增**：迁移算法单测（临时目录真造文件，不 mock fs） |
| `docs/calibration.md` | 追加一节（探针实测结论 + 迁移行为） |
| `docs/superpowers/specs/2026-11-12-sanlos-music-userdata-dir-rename-design.md` | 本文件 |

**不动**：`appId`、`package.json` 的 `name`、`electron-builder.yml`、E2E 夹具、
`shared/appInfo.ts`（软件名早就改好了）。

---

## 五、验收点

1. `tsc --noEmit` exit 0；`vitest` 全绿（**既有测试一条不许删、断言一条不许削弱**）。
2. 新增单测覆盖：
   - 旧目录不存在 ⇒ `no-legacy`，不产生任何副作用；
   - 旧目录存在 + 新目录为空 ⇒ **全部搬过去**，旧目录消失，`prefs.json` / `session.bin` 内容**逐字节相同**；
   - 新目录已有同名文件 ⇒ **不覆盖**，旧的那份**留在旧目录**；
   - **守卫**：`userData` 被 `--user-data-dir` 改走时 ⇒ **不迁移**（真实用户目录一个字节都不动）；
   - **幂等**：跑第二次 ⇒ `already-migrated`，不再搬；
   - 跨设备 `rename` 失败（EXDEV）⇒ 降级为「复制 + 保留源」，**不丢数据**。
3. 探针复跑：`electron release/verify/t89-2-probe-app` ⇒ userData = `%APPDATA%\Sanlos Music`。
4. 真机（**本机就是用户的机器**）：装 v0.2.6 后启动 ⇒ 旧目录被搬走、偏好与登录态还在。

---

## 六、风险与回滚

| 风险 | 处置 |
|---|---|
| 迁移把用户数据搬坏 | 逐项 `rename`（同卷原子）+ **同名不覆盖** + 跳过的项留在旧目录 ⇒ 最坏情况是「一部分在新、一部分在旧」，**没有丢失** |
| E2E 搬走用户真实数据 | 守卫（§3.3）拦死 ⇒ E2E 跑在临时目录时**完全不迁移** |
| 升级链断 | `appId` 不动 ⇒ 安装路径 / 注册表 / 升级链不变 |
| 用户回滚到 v0.2.5 | 旧目录已被搬空 ⇒ 旧版本会显示「未登录、偏好回默认」⇒ **数据没丢**，在新版本里改回去即可 ⇒ 回滚说明要写进 v0.2.6 发布说明 |
| Electron 以后改了 userData 规则 | 目录名由 `productName` 决定，规则变了会再搬一次 ⇒ 迁移是**幂等**的，且有标记文件可查 |

**明确不做**：
- 不改 `appId`；
- 不删除旧目录里的任何内容（除了「搬空后自动消失的空目录」）；
- 不在渲染层做这件事（渲染层不许碰文件系统）；
- 不把迁移逻辑塞进 `electron/main.ts` 里一坨 —— 拆成可单测的独立模块。
