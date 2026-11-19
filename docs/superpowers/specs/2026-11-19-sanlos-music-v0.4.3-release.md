# T117 —— 补 `localStorage` 第四个旧键的回落 ＋ 发版 v0.4.3

> 起因：**T116（发版 v0.4.2）的真机复验查出 T115 漏了一个键** ⇒
> 用户的「有声读物扫描结果」在 v0.4.2 里**读不到** ⇒ 这一版把它补上并发布。

规格日期：**2026-11-19**　｜　用户拍板：**「做 T117：补回落 ＋ 发 v0.4.3」**

---

## 一、起因（**不是推测，是 T116 真机复验的实测结论**）

### 1. T115 的「旧键回落」名单只有**三个**键

`docs/superpowers/specs/2026-11-19-sanlos-music-inner-rename-design.md` §五
逐个列了三个 `localStorage` 键（`local-history` / `resume` / `lyric-overrides`）
⇒ 落进 `shared/legacyStorageKeys.ts` ⇒ 新键没有时**回落读旧键**。

⚠ **但代码里其实有第四个键**：`src/state/audiobookStore.ts` 的
`STORAGE_KEY = 'sanlos-audiobook-state'`（T115 之前是 `'fnmusic-audiobook-state'`）
—— **它没有进那份名单** ⇒ **没有回落**。

### 2. 本机实测（**T116 的 Phase B，真实 userData**）

| 键 | 在不在真实 userData 里 |
|---|---|
| `fnmusic-local-history` | ✅ 在 |
| `fnmusic-resume` | ✅ 在 |
| `fnmusic-lyric-overrides` | ✅ 在 |
| **`fnmusic-audiobook-state`** | ✅ **在**（**第四个**，T115 漏掉的） |
| `sanlos-audiobook-state` | ❌ **不在**（新键从没写过） |

⇒ **v0.4.2 读不到**那份落盘（`load()` 只认新键 ⇒ 返回 `null`）。

### 3. 后果（**三条，按用户能感知的顺序**）

| # | 后果 | 机理 |
|---|---|---|
| ① | **有声读物的自动判定失效** | `restore()` 读不到落盘 ⇒ `hits` 为空 ⇒ `isAudiobook(albumId)` 对**自动判定**的专辑返回 `false` ⇒ **T112 修的「有声读物被误配桌面歌词」那条缺陷又回来了**（桌面歌词会给 `0001` 这种集标题**随便匹配**别的歌） |
| ② | **「有声」页的手工改判丢失** | 用户点过的「这是有声读物」/「这不是有声」记在同一个落盘里 ⇒ 一起丢 |
| ③ | **下次进「有声」页会全库重扫一次** | `scannedAt` 读不到 ⇒ 页面认为「没扫过」⇒ 自动开扫。⚠ **很贵**：实测 **87 页 / 6–47 分钟**，每页 2000 首 ⇒ 纯打 NAS 流量 |

⚠ **丢的不是「一份缓存」**：本机旧键里的 `scannedCount` 是 **173 671**
⇒ 用户**真的扫过一次全库**（17 万首）⇒ 重扫一次是几十分钟的 NAS 流量。

### 4. 为什么 `version` 没问题（**可以直接兼容**）

T115 **只改了键名**，`STATE_VERSION` 一直是 **3** ⇒ 旧键里的 `version` 也是 **3**
⇒ 回落读到的内容**不需要任何转换**（实测旧键 JSON 以 `{"version":3,` 开头）。

---

## 二、修法（**旧键回落 ＋ 自然迁移**）

### 1. 旧键字面量的**唯一居所**：`shared/legacyStorageKeys.ts`

新增一条（**一个字都不能改** —— 它就是数据在磁盘上的原样）：

```ts
/** 旧的「有声读物扫描结果」键（T115 之前）。 */
export const LEGACY_AUDIOBOOK_STATE_KEY = 'fnmusic-audiobook-state'
```

### 2. 回落点：`src/state/audiobookStore.ts` 的 `localStorageAudiobookPort.load()`

```ts
const raw =
  globalThis.localStorage?.getItem(STORAGE_KEY) ??
  globalThis.localStorage?.getItem(LEGACY_AUDIOBOOK_STATE_KEY)
```

⇒ **新键没有才回落读旧键**（旧键**只读**、**不删**）⇒ 与另外三个键**同一套纪律**。

### 3. 写入端：**只写新键** ⇒ 一次性迁移、幂等、零删除

`save()` **一个字都不改** ⇒ 第一次写入（下次扫描 / 下次手工改判）自然落到新键
⇒ 新键一有值 ⇒ 旧键**不再被读** ⇒ **天然幂等**。

### 4. ⚠ 为什么**不需要**「清空时新旧两个键都删」

另外三个键里，只有 `resume` 有「清空」入口（`resumeBridge.clear()`）
⇒ 只删新键的话，新键一消失、下次读就**回落到旧键** ⇒ 用户点了「清空」记录却复活。

**有声这个 store 没有「清空」入口** ⇒ 没有复活风险。
⚠ 而「撤销改判」（`setOverride(id, null)`）**只改新键** ⇒ 新键仍在 ⇒ 旧键不会被读回
⇒ **也不会复活**。（这条要在测试里钉住。）

### 5. ⚠ **不许**改的东西

- **不许**动 `STATE_VERSION`（改成 4 ⇒ 旧数据直接作废 ⇒ **正是要避免的事**）；
- **不许**动 `save()` 的落盘键（还是新键）；
- **不许**删旧键（删了＝把迁移的路堵死）；
- **不许**动 `hitOf` / `isAudiobook` / `setOverride` 的判定逻辑（**只改「读哪儿」**）。

---

## 三、改哪些文件（**仓库内 11 个，别多改**）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `shared/legacyStorageKeys.ts` | **新增** `LEGACY_AUDIOBOOK_STATE_KEY`（＋ 注释里「三个」改成「四个」） | LF |
| `src/state/audiobookStore.ts` | `load()` 加旧键回落（**只读**） | LF |
| `test/t117-audiobook-legacy-key.test.ts` | **新增**：回落与迁移的钉子（见 §四） | LF |
| `package.json` | `"version": "0.4.2"` → `"0.4.3"`（**只这 1 行**） | LF |
| `package-lock.json` | root `version` **两处** → `0.4.3` | LF |
| `docs/releases/v0.4.3.md` | **新增**：CI 的 Release 正文来源（缺则工作流 **throw**） | LF |
| `docs/changelog.md` | 「当前版本」行 → `0.4.3`；**新增** `## 0.4.3 —— 2026-11-19` 段 | **CRLF**（保持原样） |
| `README.md` | 版本引用（当前版本 / 下载链接 / 两个资产名 / 发布说明链接 / 未签名说明 / 两条 Unblock-File / 静默安装 / attestation 命令） | LF |
| `docs/superpowers/specs/2026-11-19-sanlos-music-v0.4.3-release.md` | **新增**：本规格（＋ §九 / §十 回填） | LF |
| `docs/calibration.md` | **追加**复验段（第九十五节） | **CRLF**（保持原样） |
| `docs/build-verification.md` | **顶部加一条**说明 | **CRLF**（保持原样） |

⚠ **不动** `docs/releases/v0.4.2.md` 与 `v0.4.1.md`（**已发布** Release 的正文来源）。
⚠ **不动**历史段：`docs/changelog.md` 里 `## 0.4.2` 及其以前的段**一字不改**。
⚠ **不动** T114 / T115 / T116 的**规格与复验文档正文**（那是**当时的记录**）。

---

## 四、测试（**新增钉子；既有测试一条不许删、断言一条不许弱化**）

新增 `test/t117-audiobook-legacy-key.test.ts`：

| # | 钉子 | 为什么 |
|---|---|---|
| ① | 旧键字面量 = `fnmusic-audiobook-state`，且**在** `shared/legacyStorageKeys.ts` 里 | 旧名必须在「白名单文件」里，不能散落 |
| ② | 旧键有值、新键没有 ⇒ `restore()` **读得到** `scannedAt` / `overrides` | 「不再重扫 87 页」＋「手工改判不丢」 |
| ③ | 旧键的**候选专辑**能被还原成命中列表（`hits`） | **自动判定**靠的就是它 ⇒ 这是 T112 的地基 |
| ④ | 新键**优先**于旧键（不能被旧数据顶掉） | 与另外三个键同一纪律 |
| ⑤ | **旧键只读、不删**（回落后旧键仍在） | 迁移的路不能被堵死 |
| ⑥ | 写一次之后落**新键**，且内容**包含**旧键里的候选与改判 | **一次性迁移**（不丢数据） |
| ⑦ | 撤销改判（`setOverride(id, null)`）**不会**让旧数据复活 | 「清空/撤销 ⇒ 复活」这个坑的同款 |
| ⑧ | `STATE_VERSION` 仍是 **3** | 升版本 ⇒ 旧数据直接作废 ⇒ **正是要避免的** |

⚠ **不动** `test/t115-rename-contract.test.ts`：
它的负向扫描 token 集里**本来就没有** `fnmusic-*`（只有 `fnm-` / `fnm://` / `com.fnmusic.desktop` 等）
⇒ 新增第四个旧键**不会**让它变红 ⇒ **不需要**改白名单（也就不存在「弱化断言」的问题）。

---

## 五、发版 v0.4.3（**沿用 T113 / T116 的链路**）

### 1. 版本号：**0.4.3**

- `v0.4.2..HEAD` = **一个修复**（旧键回落）＋ **一处发布说明的改动**；
- ⇒ **次版本**（修的是「用户数据丢失」这一类，补丁号会被读成「无关痛痒」）；
- 版本号**只落 `package.json` 一处**（About 页 / 更新页走主进程 `app.getVersion()`）。

### 2. ⚠ 这一版**是原地升级**（appId **没变**）

`com.sanlos.music`（v0.4.2 也是它）⇒ NSIS 卸载项 GUID 不变
⇒ **不需要先卸载旧版** ⇒ 正好验证用户要的「**后面版本能更新就行**」。

### 3. 链路（本机不打包，产物只能由 CI 构建）

```
本机：改 11 个文件 → 提交 → 推分支 → 打注解 tag v0.4.3 → 推 tag
                                          ↓
GitHub：手动 dispatch .github/workflows/release.yml
        （tag = v0.4.3，pack_only = false，sign = false）
                                          ↓
CI（windows-latest，Node 22）：出包 → 断言确实没签名 → 写 latest.json
                              → 改名归一 → 签发 attestation → 拼正文（sha256 表自动追加）
```

⚠ **两个必须记住的坑**（T116 踩过）：
① `sign` 与 `pack_only` 在 dispatch 表单里**默认都是勾上的** ⇒ 必须**显式取消**
（复核 `input[type="checkbox"]:checked` 为空）；② `github.com` 网页端从这台机器直连
**会随机失败**（DNS 指到坏 IP）⇒ 必要时用 `release/verify/t110-proxy-pin.mjs` 钉 IP ＋ 临时改 HKCU 系统代理
⇒ **干完必须还原**（`ProxyEnable` 复原 ＋ 关掉本地代理进程）。

### 4. 验收点

**发布前（本机）**

1. `tsc --noEmit` ⇒ **0 错**；
2. `vitest` ⇒ **全绿**（既有 **3 024** 条**一条不删、断言一条不许弱化** ＋ 新增 §四 的 8 条）；
3. `playwright` ⇒ **既有 72 条全绿**；
4. `npm run build` ⇒ exit **0**；
5. 字节体检 ＋ 控制字符扫描 ⇒ **bad=0**；
6. `docs/changelog.md` / `docs/calibration.md` / `docs/build-verification.md` ⇒ **CRLF**、裸 LF 0、BOM 0、孤立 CR 0、U+FFFD 0；
7. 回填脚本**连跑 3 次 sha256 一致**（幂等）。

**发布后（CI 跑完）**

8. Release `v0.4.3` 存在、是 **latest**、非草稿非预发布；
9. 资产**恰好 3 个**（Setup / Portable / `latest.json`）；
10. 正文 sha256 表 ≡ 资产 API `digest` ≡ **本机实算**（**三处逐字一致**）；
11. `latest.json` 的 `version` = **0.4.3**、sha512 **128 位**。

**装上之后（本机）**

12. `app.asar` 的 `version` = **0.4.3**；注册表卸载项 = 「**Sanlos Music 0.4.3**」；
13. ⚠ **原地升级**：v0.4.2 → v0.4.3 **不卸载**也能装 ⇒ userData **一字未动**；
14. ⭐ **旧键回落真机生效**（**核心验收点**）：
    隔离 userData（**复制真实 Local Storage** ⇒ 带旧键）里，
    **有声那一集仍然是 0 行 ＋ 桌面歌词窗不可见** ⇒ 证明「自动判定」回来了；
    对照组（普通歌）**仍然有词 ＋ 窗口可见** ⇒ 证明「这条路是通的」；
15. **登录态还在** ＋ 真实 userData 里**旧键仍在**（**只看不播**）。

---

## 六、风险与兜底

| 风险 | 兜底 |
|---|---|
| 回落读到的旧数据**形状不对** | `load()` 里已有形状校验（`version` 不符 ⇒ `null`）⇒ **坏数据不会进内存**（不会崩） |
| 升 `STATE_VERSION` 就会作废旧数据 | 本轮**明确不许升**（§二.5）＋ 测试 ⑧ 钉住 |
| 新旧键**同时有值** | **新键优先**（测试 ④）⇒ 不会回退 |
| 「有声」页自动重扫 | 回落后 `scannedAt` 有值 ⇒ **不扫**（测试 ②）⇒ 真机再验一次（验收点 14） |
| 覆盖安装会**动到 userData** | NSIS 安装器**只删安装目录**（`electron-builder.yml` 无 `deleteAppDataOnUninstall`）⇒ 实测复核 `session.bin` 未变 |
| CI dispatch 的布尔输入默认勾上 | 提交前**显式取消** ＋ DOM 复核 |
| `github.com` 网页端连不通 | `t110-proxy-pin.mjs` 钉 IP ＋ 临时改 HKCU 代理 ⇒ **用完还原** |

---

## 七、明确**不做**

| 不做 | 理由 |
|---|---|
| 顺手改「有声」页**自动全库扫描**的策略 | 那是**另一轮**的事；本轮只补回落 |
| 顺手修扫描落盘「用旧 `overrides` 快照覆盖手工改判」的竞态 | **既有问题**（T116 顺带发现）⇒ 另立编号任务，不混进本轮 |
| 删掉旧键 | 删了＝堵死迁移的路 |
| 改 `docs/releases/v0.4.2.md` | **已发布** Release 的正文来源 ⇒ 改了线上正文与本地文件会不一致 |
| 改历史 changelog / calibration 段 | 历史是**当时的记录** |
| 动 `github.com` 之外的账号设置（2FA） | 用户自己的账号 ⇒ **待用户决定**，不擅自动手 |

---

## 八、提交约定

| 批次 | 内容 |
|---|---|
| commit 1（**规格**） | 本文件 |
| commit 2（**实现**） | 回落 ＋ 钉测试 ＋ 版本号 bump ＋ 发布说明 ＋ changelog ＋ README |
| commit 3（**复验文档**） | 真机复验结果 ＋ `docs/releases/v0.4.3.md` 的「真机复验」段 ＋ calibration 第九十五节 ＋ 本规格 §九 / §十 回填 ＋ 台账 |

---

## 九、执行记录（**已回填**）

### 1. 三个 commit

| 批次 | commit | 内容 |
|---|---|---|
| 1（规格） | `b6087c9` | 本文件 |
| 2（实现 ＋ 发版） | `e3b3954` | 回落 ＋ 8 条钉子 ＋ 版本号 0.4.3 ＋ `docs/releases/v0.4.3.md` ＋ changelog ＋ README（**8 个文件**） |
| 3（复验文档） | 见 §十 | 本规格 §九 / §十 回填 ＋ `docs/releases/v0.4.3.md` 第三节 ＋ calibration 第九十五节 ＋ build-verification 顶部 ＋ changelog 0.4.3 段 |

### 2. 实现（**只改「读哪儿」**）

- `shared/legacyStorageKeys.ts`：**新增** `LEGACY_AUDIOBOOK_STATE_KEY = 'fnmusic-audiobook-state'`；头注释「三个」→「四个」；
- `src/state/audiobookStore.ts`：`localStorageAudiobookPort.load()` 改为
  `getItem(STORAGE_KEY) ?? getItem(LEGACY_AUDIOBOOK_STATE_KEY)`（旧键**只读**）；
- `save()` / `STATE_VERSION`（仍 **3**）/ `hitOf` / `isAudiobook` / `setOverride` **一字未改**；
- `test/t117-audiobook-legacy-key.test.ts`：**新增** §四 的 **8 条**钉子；
- ⚠ `test/t115-rename-contract.test.ts` **未动**（其负向 token 集里本就没有 `fnmusic-*`）⇒ 不存在「弱化断言」。

### 3. 回归（**全部实测**）

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | **0 错** |
| `vitest` | **147 文件 / 3 032 条全绿**（原 146 / 3 024 ＋ 新增 1 文件 / 8 条；**既有测试一条不删、断言一条不弱化**） |
| `playwright` | **72 passed** |
| `npm run build` | exit **0** |
| 字节体检 ＋ 控制字符（**8 个改动文件**） | **bad=0** |
| 变异自证 `t117-05-mutation-check.mjs` | **`MUTATION_OK`**：A 删回落⇒**3 红**、B 旧键优先⇒**2 红**、C 升 `STATE_VERSION`⇒**5 红**、D 回落时删旧键⇒**2 红**；还原后 **8/8 全绿** ＋ **字节级**与原文一致 |
| 回填/改写脚本幂等 | 连跑 3 次 **sha256 完全一致**（第 2、3 次 **0 处改动**）⇒ `RELEASE_EDITS_OK` |

### 4. 发版

| 步 | 实测 |
|---|---|
| 推分支 | `e23e0d5..e3b3954` 已推 |
| 注解 tag | `v0.4.3` → `e3b3954`（tagger `Mavis <mavis@local>`）已推 |
| 网页 dispatch | tag = `v0.4.3`；**`pack_only` 与 `sign` 两个勾都显式取消**（DOM 复核 `input[type="checkbox"]:checked` 为空） |
| CI | run **#20** id **44522673902** = **success**（335 秒；Typecheck / Unit tests / Build 全过，SignPath 步骤被跳过） |
| Release | id **451310330**、published **2026-11-19T12:23:57Z**、非草稿非预发布、资产**恰好 3 个** |
| sha256（**三处逐字一致**） | Setup `a740c0baccc15bab3dbd0e02cdd2040eee244fc9d9f0029a076afff67fbb5544`（86 138 684 B）／ Portable `f8413634af86bc6e18389a078343130119f63d848b0306d60133e5eada59b52a`（79 038 722 B）／ `latest.json` `b4d1387cac20cf7a22ce02e5ab3e3422d522999f27f5b0f7a23d1a424d217b1c`（472 B） |
| `latest.json` | `version` = **0.4.3**、sha512 **128 位**、size ≡ API size |
| 原地升级 | exe `FileVersion` `0.4.3 / 0.4.3.0 / Sanlos Music`；`app.asar` **839 627 B**（v0.4.2 839 536 B）；注册表「**Sanlos Music 0.4.3**」且**无残留 0.4.2**；`session.bin`（286 B）**逐字未变**、`Local Storage` **11 个文件未变**、`prefs.json` 未变 |

## 十、真机复验状态（**已回填**）

### 1. 口径

- 跑的是 **GitHub Release 的产物**（CI 构建、已装到 `D:\Sanlos Music`），**不是**源码构建的开发实例；
- 机器：**本机** Windows 10.0.26300 x64 / Node v26.13.0；**真实 NAS** ＋ **真实账号**；
- Phase A = **隔离 userData**（复制**真实 `Local Storage`** ⇒ 带旧键 ⇒ 正好是「升级后第一天」）；
  Phase B = **真实 userData**、**只看不播**。

### 2. 实验组（v0.4.3）—— Phase A **12/12** ＋ Phase B **2/2** 全过

| # | 判据 | 实测 |
|---|---|---|
| ① | 版本 = 0.4.3 | ✅ |
| ② | 连上真实 NAS | ✅ 导航 13 项；曲库首屏 15 首 |
| ③ | 起点：旧键在、新键不在 | ✅ 旧键 5 个、新键 0 个 |
| ④ | ⭐ 状态行「上次扫描：」⇒ `scannedAt` **回落成功**（**没触发**全库扫描） | ✅ 「上次扫描：2026/11/17 00:45:50 · 目录「有声小说」· 9 部」 |
| ⑤ | 「有声」页列出作品（`hits` 恢复） | ✅ **卡片 9 张** |
| ⑥ | 专辑详情页出现「有声」标记 ⇒ **自动判定**恢复（**不经秒搜** ⇒ 无 override 污染） | ✅ 「已按集序排列」 |
| ⑦ | 有声那一集推的是**空行** | ✅ 「01- 科学边界」**0 行** |
| ⑧ | 有声那一集桌面歌词窗**不可见** | ✅ |
| ⑨ | 有声那一集桌面歌词窗**没被干掉** | ✅ 窗存在 |
| ⑩ | 对照组：普通歌**有词** | ✅ 「庙堂之外 (五四特别版)」**67 行** |
| ⑪ | 对照组：桌面歌词窗**可见** | ✅ |
| ⑫ | 旧键**只读**：跑完整轮仍在 | ✅ 新键仍不在 |
| B | 真实 userData 自动登录 ＋ 旧键仍在 | ✅ |

### 3. 对照组（v0.4.2 缺陷版，同一份隔离 userData）—— **4/4** 全过

| 判据 | 实测 |
|---|---|
| 状态行「**正在扫描**」⇒ 读不到旧键 ⇒ 触发全库扫描（**判据有鉴别力**） | ✅ 「正在扫描…第 0 页 / 共 0 页（已扫 0 首）」 |
| 「有声」页**没有**作品 | ✅ **卡片 0 张** |

⇒ 两组**唯一**差别是版本号 ⇒ ④ 的判据**有鉴别力**（不是「这条路根本没通」）。

### 4. 旧键落盘原样（实测）

`version` = **3**、`scannedAt` = **1794847550212**（= 2026/11/17 00:45:50）、关键字「**有声小说**」、
`scannedCount` = **173 671**、候选 **10**、手工改判 **0**。

### 5. 这一轮纠正的一条判据设计错误

T116 那条「有声那一集 0 行」判据**其实不证明回落生效** ——
「有声」页的**秒搜**结果会 `setOverride(…, 'audiobook')` ⇒ 走那条路，判定会变成「自己写进去的」。
本轮**改走列表卡片** `.sanlos-audiobooks__item`（**只下钻、不写 override**）＋ **补对照组**
⇒ 判据这才有鉴别力。

### 6. 遗留 / 待办

- ⏳ 「有声」页扫描落盘用启动时的 `overrides` 快照 ⇒ 扫描中的手工改判可能被覆盖（**既有问题**）⇒ 另立编号任务；
- ✅ Release **v0.4.3 的线上正文已同步**（2026-11-19，用户确认）⇒ **逐字验收通过**（sha256 `55068397…cb7deacb`）；
- ⏳ Release **v0.4.2 的线上正文**按用户「以前的版本不用理」**不改**；
- ⏳ GitHub 账号 **2FA 未启用**（待用户决定）；
- ⏳ 卸载项在 **HKCU（按用户）** ⇒ 回按机器需 `/allusers`（触发 UAC）。
