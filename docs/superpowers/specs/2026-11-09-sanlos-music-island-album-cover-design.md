# T76 —— 灵动态词岛左端换成专辑封面（规格）

> 用户指令（2026-11-09）：
> 「灵动歌词的左边音效动画换成专辑封面」

---

## ① 现状（**已查证**，非推测）

### ①-A 词岛左端现在是什么

`src/island/IslandApp.tsx` 的胶囊是**四段 flex 横排**：

```
[SpectrumBars side="left"] [曲目信息] [歌词] [SpectrumBars side="right"]
```

- 左端 = **8 根频谱柱**（`src/island/SpectrumBars.tsx`，高度由主进程转发的真实频谱驱动，24fps）；
- 右端 = 另 8 根（与左端**互为镜像**，保证左右对称）。

⇒ 用户说的「**左边音效动画**」= 左侧那组频谱柱。

### ①-B 缺口：词岛**拿不到封面**

词岛是**独立渲染进程**（`src/island/main.tsx`），它订阅主进程转发的 `LyricOverlayMessage`：

```ts
// shared/playerBridge.ts
export interface LyricOverlayTrack {
  id: string
  title: string
  artist: string
  // ⚠️ 没有 coverId
}
```

而主窗口的播放器 store 里是有封面的（`shared/types.ts` 的 `Song.coverId: string`，无封面为空串）。

⇒ **必须先把 `coverId` 透传到词岛**，否则词岛无从知道该显示哪张封面。

### ①-C 封面在渲染层**本来就能显示**

- 全项目封面地址的**唯一**拼装点是 `src/components/coverUrl.ts` 的 `coverUrl(coverId, size)`；
- 它拼出来的是 `fnm://srv/static/cover?coverId=…&size=…` —— **主进程协议代理**转发到 NAS 并附加凭证；
- ⇒ **渲染层永远拿不到 token**（既有纪律不变），词岛只要 `<img src={coverUrl(...)}>` 即可；
- `island.html` 的 CSP **已放行** `img-src … fnm:` ✓（不需要改 CSP）。

---

## ② 口径（用户指令的直接落地）

1. **只改左端**：左边频谱柱 → **专辑封面**；**右端频谱柱保持不变**（用户说的是「左边」）。
2. **没有封面 / 封面加载失败** → 显示**占位块**（♪ 字符，语义变量配色），不留浏览器默认破图。
3. **不引新 npm 依赖**；不新增出网路径（仍走 `fnm://` 协议代理）。
4. **经典悬浮窗一字不变**（它不显示频谱、也不显示封面）。
5. 既有测试**一条不删**；前提被本指令显式推翻的断言**改写为新行为断言**并说明。

---

## ③ 设计

### ③-A 数据链路（`coverId` 一路透传）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `shared/playerBridge.ts` | `LyricOverlayTrack` 增加 **`coverId?: string`**（**可选** ⇒ 经典窗与既有测试夹具一字不改；无封面 = 空串 / 未定义） |
| 2 | `src/player/lyricOverlay.ts` | `cachedTrack` 带 `coverId: song.coverId`（`Song.coverId` 已是 `normalizeCoverId` 归一化后的 `xxx_<hex>` 或空串） |
| 3 | `electron/ipc.ts` `sanitizeLyricMessage` | 透传 `coverId`，并**按 `xxx_<hex>` 口径过滤**（与 `src/api/client.ts` 的 `normalizeCoverId` 同口径；不合规一律当空串） |

⚠️ **为什么第 3 步要再过滤一次**（纵深防御）：主进程的消息净化器是**外部输入的唯一闸门**——
渲染层发来的 `coverId` 最终会被拼进 URL（`coverUrl()` 已 `encodeURIComponent`），
主进程这一层再按形状过滤 ⇒ 即使渲染层被绕过，也不会把任意字符串塞进封面地址。

### ③-B 词岛端的组件（`src/island/IslandCover.tsx`，**新增**）

- 有 `coverId` → `<img class="fnm-island__cover" src={coverUrl(coverId, ISLAND_COVER_SIZE)} alt={…}>`；
- **没有** `coverId` → 占位块（**不渲染 `<img>`**，与 `CoverImage` 的既有口径一致）；
- **加载失败**（404 / 解码失败）→ 切成占位块（`onError`）；
- 换封面 id 时**重置失败状态**（上一张的失败不该连累下一张）；
- 服务端尺寸常量 `ISLAND_COVER_SIZE = 160`（与托盘 `TRAY_COVER_SIZE` / 媒体会话 `MEDIA_ARTWORK_SIZE` 一致）；
  显示尺寸是 **CSS** 的事（56×56），**与**服务端 `size` 参数**无关**（同 `CoverImage` 的既有口径）。

### ③-C 胶囊布局

```
[封面 56×56] [曲目信息] [歌词] [右端频谱柱]
```

- `.fnm-island` 是 `display:flex; gap:14px; padding:10px 18px`；
- 封面 `flex: 0 0 auto`（**不许被挤扁**，与频谱柱同口径）；
- 封面用**圆角方形**（`border-radius: 12px`）+ `object-fit: cover`（不变形）；
- 只用**语义变量**（`--text-secondary` / `--surface-raised` / `--border`）⇒ 明暗两套主题都成立。

### ③-D 频谱柱的处置

- `SpectrumBars` 组件**保留**（右端仍在用，`side` prop 不变）；
- 只在 `IslandApp` 里**去掉左端那次调用** + 删掉随之失效的 `leftBins`（`noUnusedLocals` 会报错）；
- CSS 里 `.fnm-island__spectrum` 规则**保留**（右端仍命中）。

---

## ④ 既有断言的改写（**一条不删、强度只增**）

`test/lyric-island-app.test.tsx` 的 T47 段落有 4 条断言**以「左端有频谱柱」为前提**，
该前提被用户指令**显式推翻** ⇒ 改写为新行为断言：

| 原断言 | 改写后 |
|---|---|
| 「两端各 **8 根**柱子（右组是左组的镜像）」 | 「**右端**仍是 8 根柱子；**左端不再是频谱柱**（换成封面）」 |
| 「还没收到频谱 → 柱子是最小高度」 | 改为只钉**右端**（左端已无柱） |
| 「收到频谱 → 左 = **逆序**，右 = **原序**」 | 改为只钉**右端 = 原序** + 断言「左端没有 `.fnm-island__bar`」 |
| 「左右两端显示**同一组**频段」 | 改为「左端**不再**显示任何频段（只有右端有柱）」 |

⚠️ 原有那条「左右同源镜像」是在**双端**前提下的鉴别力断言；改写后仍然保留鉴别力
（若有人把左端柱子加回来 ⇒ 必红）。

---

## ⑤ 验收

- `tsc --noEmit` exit 0；
- `vitest run`：**条数只增不减**（基线 93 文件 / 2004 条）；
- `npm run build` exit 0；
- Playwright E2E：**27/27**（不增不减）；
- **变异自证**：至少 3 条（把封面改回频谱柱 / 删掉 `coverId` 透传 / 去掉 `coverUrl` 唯一拼装点）**全红**；
- 真机截图取证：词岛左端 = 专辑封面。
