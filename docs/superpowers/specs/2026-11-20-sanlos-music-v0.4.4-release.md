# T121 —— 发版 v0.4.4（「有声」页按服务端目录浏览正式交付）

> 起因：**T120 改了行为**（「有声」页从「全库扫 87 页 ＋ 按 path 关键字挑」改成
> 「按服务端目录树浏览那个文件夹」）⇒ 已装的 v0.4.3 仍是旧路径
> ⇒ 用户拍板：**「请拍板发布 v0.4.4，将 T120 的服务端目录浏览能力正式交付。」**

规格日期：**2026-11-20**　｜　用户拍板：**「请拍板发布 v0.4.4，将 T120 的服务端目录浏览能力正式交付。」**

---

## 一、这一版发什么（**三件事**）

| # | 东西 | 来自 | 影响面 |
|---|---|---|---|
| ① | 「有声」页按**服务端目录浏览**（不再全库扫 87 页 / 17.3 万首） | T120 | **行为**（用户可见：快 3.5–8 倍） |
| ② | 修掉「扫描时把你手工改的判覆盖掉」 | T118 | **行为**（用户可见：改判不再消失） |
| ③ | 把「服务端不能浏览目录」这句过时的说明改对（6 处） | T119 | **文档 ＋ 文案**（客户端行为一字未改） |

⇒ v0.4.3..HEAD 共 **11 个 commit**、**17 个文件**。

---

## 二、发版链（**每一步都有证据**）

### 1. 版本号（**三处必须同步**）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `package.json` | `version` 0.4.3 ⇒ **0.4.4**（**只 1 行**） | LF |
| `package-lock.json` | root `version` **两处** ⇒ 0.4.4 | LF |
| `docs/changelog.md` | 「当前版本」行 ＋ **新增** `## 0.4.4 —— 2026-11-20` 段（**历史段一字不动**） | **CRLF** |
| `README.md` | 整篇 0.4.3 ⇒ 0.4.4（**12 处**，全是「当前版本」引用，逐条审过） | LF |
| `docs/releases/v0.4.4.md` | **新增**（CI 的 Release 正文来源 ⇒ 缺它工作流直接 `throw`） | LF |

⚠ **`package-lock.json` 必须同步**：CI 第一步是 `npm ci` ⇒ 不同步**直接失败**
（v0.4.3 那次也是改两处）。

### 2. 注解 tag ＋ 推分支

- `git tag -a v0.4.4 -F release/verify/tag-msg-v0.4.4.txt` ⇒ tag 对象 → commit `c21dab5`（= HEAD）；
- `git push origin sanlos-music` ＋ `git push origin v0.4.4`；
- 已验：远端有 tag；tag 内 `package.json` version = 0.4.4；tag 内 `docs/releases/v0.4.4.md` 存在。

### 3. 网页 dispatch（**没有 `gh` CLI、没有 token ⇒ 只能走网页**）

`.github/workflows/release.yml` 的 `workflow_dispatch` 输入：

| 输入 | 类型 / 默认 | 本次取值 | ⚠ |
|---|---|---|---|
| `tag` | string / 必填 | `v0.4.4` | |
| `pack_only` | boolean / **默认 `true`** | **取消勾选** | 默认勾上 ⇒ 不取消则**只打包、不发版** |
| `sign` | boolean / **默认 `true`** | **取消勾选** | 默认勾上 ⇒ 不取消则**必然失败**在 SignPath 检查步骤 |

⚠ **「默认勾上」这个坑**：`workflow_dispatch` 的布尔输入按 YAML 默认值渲染
⇒ 网页表单里默认就是勾着的 ⇒ **必须显式取消**，且取消后要用 DOM 查
`input[type="checkbox]:checked` ⇒ **查不到**才是真没勾（**读 `checked` 属性不可靠**）。

⚠ **同名 hidden input**：每个布尔输入还有一个 `type=hidden` 的同名 input
⇒ 按 `name` 选（`input[name="inputs[pack_only]"]`）会命中**那个 hidden 的**
⇒ `uncheck` 直接报「not a checkbox」⇒ **必须用 id**（`input#_r_p_` / `input#_r_q_`）。

### 4. CI 期望路径（**未签名**）

`pack_only=false` ＋ `sign=false` ⇒ 走：
`Upload unsigned artifacts` →（SignPath 那几步 **skipped**）→ `Verify unsigned artifacts`
→ `Write update manifest (unsigned)` → `Normalize asset names` → `Attest build provenance`
→ `Summary (attestation)` → `Prepare release notes with checksums` → `Publish GitHub Release`。

⇒ 产物**恰好 3 个**：`SanlosMusic-Setup-0.4.4.exe`、`SanlosMusic-Portable-0.4.4.exe`、`latest.json`
（**不发** `latest.yml` / `*.blockmap`）。

---

## 三、验收点

| # | 验收点 | 怎么验 |
|---|---|---|
| ① | 三处 sha256 **逐字一致** | Release 正文表格（**期望值从这里解析**）＝ 资产 API `digest` ＝ 本地实算 |
| ② | 装版是**原地升级**、**不卸载** v0.4.3 | 注册表只有「Sanlos Music 0.4.4」一条，**无残留 0.4.3** |
| ③ | **用户数据一个字都没丢** | `session.bin` sha 前后一致、`Local Storage` 文件数不变、`prefs.json` 状态不变 |
| ④ | 装进去的**确实是带新代码的那份** | exe FileVersion = 0.4.4 ＋ asar 内 **5/5** 个 v0.4.4 标志命中 |
| ⑤ | **有声页走目录浏览** | 扫描窗口内 `/track/list` **零次** ＋ `/folder-view/list` > 0 ＋ 落盘 `folderPaths` 有值 |
| ⑥ | **判定口径没变** | 作品列表与 v0.4.3 **逐字一致**（9 部，含每部集数） |
| ⑦ | **T118 真机成立** | 扫描**进行中**的改判，扫完**还在**（落盘里还在 ＋ 按钮没回来） |
| ⑧ | **「目录没找到」不回落** | `/track/list` 计数**没新增** ＋ 如实报「没找到」 |

---

## 四、执行记录（**已回填**）

### 1. 三个 commit

| # | commit | 内容 |
|---|---|---|
| 1（规格） | 本文件 | — |
| 2（发版） | **`c21dab5`** | 版本号 bump（5 文件 / 240 插入 / 14 删除）＋ 注解 tag `v0.4.4` |
| 3（复验文档） | 见 §五 | 本规格 §四 / §五 ＋ `docs/releases/v0.4.4.md` 第五节 ＋ calibration 第一百节 ＋ build-verification 顶部 ＋ 台账 |

### 2. 发版实测

| 项 | 实测 |
|---|---|
| 注解 tag | `v0.4.4` → **`c21dab5`**，已推送 |
| dispatch | `tag=v0.4.4`、`pack_only` **取消勾选**、`sign` **取消勾选** ⇒ DOM 复核 `input[type=checkbox]:checked` = **0 个** |
| CI run | **#21** / **`44568675852`** = **success** |
| SignPath 几步 | **全部 skipped** ⇒ 走**未签名**路径 |
| attestation | ✅ 成功 ⇒ https://github.com/pure2199/sanlos-music/attestations/69747493 |
| Release | https://github.com/pure2199/sanlos-music/releases/tag/v0.4.4（`draft=false`、`prerelease=false`） |
| 资产 | **恰好 3 个**（Setup / Portable / `latest.json`） |
| 三处 sha256 | **`SHA256_OK`**（`problems: []`） |

| 文件 | 字节数 | sha256 |
|---|---|---|
| `SanlosMusic-Setup-0.4.4.exe` | 86 139 754 | `56ceae67f982923c3531aa2a77992fdedf12aff0ebbc5884d28eb3aceb1c732a` |
| `SanlosMusic-Portable-0.4.4.exe` | 79 033 151 | `b771b677ae7ace55d0d8fb1ac2ee0fb061624d8b6f184a2be669882d4ed0214f` |
| `latest.json` | 472 | `1c26e95d79e4fcf1e4d2d87b34c2e05f76d160106fbbcad44b186d2b27fc7d9d` |

### 3. 装版实测（`INSTALL044_OK`）

| 项 | 实测 |
|---|---|
| 装前 | **没有** Sanlos Music 在跑 ⇒ 才装（**不替用户杀进程**） |
| 安装器 | `/S /D=D:\Sanlos Music`（**`/D=` 最后一个、不带引号**）⇒ exit **0** |
| 落盘判据 | exe ＋ asar 存在 ＋ **连续 3 次大小不变** ＋ exe FileVersion **已是 0.4.4** |
| 主程序 | FileVersion **0.4.4** / ProductVersion 0.4.4.0 / ProductName `Sanlos Music` |
| 应用包 | `app.asar` **844 415 B**、mtime 2026-11-19T16:43:56Z、`package.json` version = **0.4.4**、**5/5** 个 v0.4.4 标志命中 |
| 卸载项 | **HKCU** `…\Uninstall\370ec968-468d-54c5-8c47-1ad7446b1631` ⇒ `Sanlos Music 0.4.4` / `0.4.4`；**无残留 0.4.3** |
| 快捷方式 | 开始菜单 `Sanlos Music.lnk` 在 |
| **用户数据** | `session.bin`（286 B）**逐字未变**、`Local Storage` **11 个文件未变**、`prefs.json` 未变 |

---

## 五、真机复验状态（**已回填**）

### 1. 口径

- 跑的是 **`D:\Sanlos Music\Sanlos Music.exe`**（**真正装上去的那份**）
  ⇒ **不是** T120 那轮的「本机自打产物」；
- **真实 FN NAS** ＋ **真实账号** ＋ **隔离 userData**（只复制 `session.bin` ＋ `Local State`）
  ⇒ 真实账号 ＋ 真 NAS，但**不碰**用户本机的偏好 / 下载目录 / 扫描状态；
- 隔离目录里**没有**落盘 ⇒ 进「有声」页**自动开扫** ⇒ 能测到真实耗时。

### 2. ① 「有声」页按目录浏览

| 复验项 | v0.4.3（旧路径） | **v0.4.4（已装版）** | 结论 |
|---|---|---|---|
| 扫描耗时 | **56 041 ms** | **16 075 ms** | ✅ 快 3.5 倍（⚠ 只代表这台机这次） |
| `/track/list` | 88 次（87 页 ＋ 1） | **全程 1 次、扫描窗口内 0 次** | ✅ |
| `/folder-view/list` | 0 | **69 次** | ✅ |
| `/app-center/authed-dir/list` | 0 | **1 次** | ✅ |
| 作品 | 9 部 | **9 部（逐字一致）** | ✅ |
| 落盘 `version` | 3 | **3（没升）** | ✅ |
| 落盘 `scannedCount` | 173 671 | **5 244** | ✅ |
| 落盘 `folderPaths` | 无 | **`["/vol02/1000-0-3d135437/有声小说"]`** | ✅ |

> 「窗口内 0 次」的口径：默认落地页那一次 `/track/list` 发生在点「有声」页**之前 737 ms**
> ⇒ 与扫描无关 ⇒ 扫描那一段里它**一次都没被调用**。

### 3. ② T118（**第一次在真机上验**）

- 第一轮扫描 13 179 ms ⇒ 9 部；
- 目标《让青春继续第二季》（列表**最后一张** ⇒ 集数最少 ⇒ 详情页最快）；
- 点「从头重扫」⇒ **扫描进行中**点卡片进详情页 ⇒ 点「这不是有色」；
- ⭐ 改判**落在扫描窗口内** = **true**（早于扫描的最终落盘）⇒ 断言**不是白测**；
- 扫完落盘**还留着** `{albumId: "805e6d029e94436182cda98e8a4e5866", value: "not-audiobook", albumTitle: "让青春继续第二季"}`；
- 界面上「这不是有声」按钮**没有回来** ⇒ 改判**仍然生效**。

### 4. ③ 对照组②：「目录没找到」⇒ 如实报错 **且不回落**

- 错误条：「加载失败：服务端的目录里**没找到**叫「zzz-不存在的目录-t121」的文件夹 ⇒ …」；
- `/track/list` 计数 **1 → 0**（**没新增**）⇒ **没回落**；`/folder-view/list` 69 → 200 ⇒ 继续找目录。

### 5. 回归

| 项 | 实测 |
|---|---|
| `npm run typecheck` | exit **0**，零错误 |
| `npm test`（vitest） | **150 文件 / 3 054 条全绿** |
| `npm run e2e`（Playwright） | **72 passed** |
| `npm run build` | exit **0** |
| 字节体检 ＋ 控制字符 | **bad=0** |
| 文档回填脚本幂等 | 连跑 3 次 **sha256 一致** |

### 6. ⚠ 如实标注的边界

- ⚠ **回落路径真机验不了**（真 NAS 已是新版 ⇒ 回落**不触发**）⇒ 靠 **mock 的 ② 号钉子**覆盖；
- ⚠ **扫描刚开始约 1 秒内**状态行仍是旧口径（T120 那轮同样形态 ⇒ **不是本版新出现**）；
- ⚠ **落盘里「曲目封面」id 变了**（目录浏览拿不到独立曲目封面）⇒ **不用于显示**、判定**不看**它 ⇒ 无影响；
- ⚠ **耗时 / 曲目数只代表这台机、这个账号、这份数据、这个网络**。

---

## 六、遗留 / 待办

- ⏳ 共享库 `/shared-library/*` 未接；
- ⏳ **T118 遗留的另一个同类毛病**（扫描落盘覆盖**扫描期间补拉的封面**）仍未修 ⇒ 另立；
- ⏳ GitHub 账号 **2FA 未启用**（待用户决定）；
- ⏳ 卸载项落在 **HKCU（按用户）** ⇒ 要回按机器需 `/allusers`（触发 UAC）；
- ⏳ Release **v0.4.2 / v0.4.3 的线上正文**按用户「以前的版本不用管」**不改**。
