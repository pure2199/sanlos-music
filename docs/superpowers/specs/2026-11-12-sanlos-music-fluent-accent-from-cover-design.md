# T89-④：Fluent 主题的强调色取自封面主色（§7.1 唯一还没落地的规格项）

> 日期：2026-11-12
> 状态：设计已定，待实现
> 关联任务：T89-④（用户指令「1.2.3.4.6 都做」的第 4 项）

---

## 一、先纠正一件事：取色**早就有了**，缺的是另一件事

本任务开工前先核对了规格与代码，结论与最初的判断不同，**必须写下来**：

| 规格条目 | 位置 | 实际状态 |
|---|---|---|
| 「全屏播放页：封面取色背景 + 逐行歌词」 | `2026-11-02-…-design.md:290` | ✅ **已实现**（T15 的 `extractCoverColor` + `--fnm-fullplayer__tint` + `full-player.css` 的渐变背景）。T31 还修过「取色白底」缺陷（失败不缓存 + 有限重试），真机实测 `tintVar=#d0cbc7` |
| 「Windows 11 Fluent 风：强调色 = **取自封面取色的** Fluent 强调色」 | `2026-11-02-…-design.md:281` | ❌ **没做** —— `--accent` 写死 `#0a66ff` / `#0067c0` |

⇒ **本任务做的是后者**（主题级的强调色），不是「再加一套取色」。

⚠️ 顺带更正一处**过时陈述**：`docs/calibration.md` 的 Step K 写着
「⚠️ 本版本**没有**主色提取实现，取色子项无代码可校准」——
这句是 **T15 之前**写的，现在**是假的**（T15 就有取色，T31 还修过它）⇒ 本任务一并更正。

---

## 二、方案

### 2.1 取色代码抽成共享模块（**既有行为一字不变**）

`src/components/coverColor.ts`（新）：

| 导出 | 说明 |
|---|---|
| `extractCoverColor(url)` | **原样搬**（T15 的平均色算法）⇒ 既有行为与既有断言一字不变 |
| `extractCoverDominantColor(url)` | **新增**：主色算法（给强调色用） |
| `getCachedCoverColor` / `clearCoverColorCache` | 原样搬 |
| `COVER_SAMPLE_SIZE` / `MAX_TINT_ATTEMPTS` / `TINT_RETRY_DELAY_MS` | 原样搬 |
| `coverUrlFor(coverId)` | 从 `FullPlayerPage.tsx` 搬（本来就是私有函数） |

⚠️ **既有 import 路径不能断**：`test/lyric-view.test.tsx` 从
`../src/pages/FullPlayerPage` 导入 `extractCoverColor` 等 ⇒
`FullPlayerPage.tsx` **re-export** 这几个名字 ⇒ **既有测试一字不改**。

⚠️ **两个算法共用同一个采样函数**（`sampleCoverPixels`）⇒ 一次图片加载、两次算法。

### 2.2 「主色」算法（为什么不能直接用平均色）

平均色的问题：封面 80% 米色 + 20% 蓝 ⇒ 平均出来是**灰米色** ⇒ 当强调色毫无个性。

主色算法：
1. 逐像素转 HSL；
2. **滤掉**：太暗（`L < 0.12`）、太亮（`L > 0.92`）、太灰（`S < 0.18`）、透明（`alpha < 128`）；
3. **量化**：色相分 **12 个桶**（每桶 30°）；
4. 取**权重最大**的桶（权重 = 饱和度 × 「亮度居中度」）；
5. 该桶内按权重平均 **HSL**（不平均 RGB ⇒ 不损失饱和度）⇒ 转 hex；
6. 一个都不剩 ⇒ 返回 `null`（纯黑 / 纯白封面 ⇒ 没有颜色可用）。

### 2.3 「Fluent 强调色」的判定（**这是本任务真正的难点**）

强调色会被当成**按钮底色**，上面的文字是 `--accent-text: #ffffff` ⇒
**白字压在强调色上** ⇒ 必须满足 **WCAG AA 对比度 ≥ 4.5**。

而封面主色是**任意的**：可能是纯黄（白字完全看不清）、可能是近黑（当按钮底色太闷）。

⇒ `toFluentAccent(hex)` 做四件事（**纯函数，无 DOM ⇒ 可完整单测**）：

| 步骤 | 规则 | 为什么 |
|---|---|---|
| ① 无色相就放弃 | `S < 0.15` ⇒ 返回 `null` | 灰白封面**没有色相** ⇒ 硬凑一个颜色只会得到一个「脏色」⇒ 不如保持主题默认色 |
| ② 饱和度夹紧 | `S ∈ [0.45, 0.85]` | 太灰不像强调色；太艳刺眼 |
| ③ 亮度夹紧 | `L ∈ [0.22, 0.55]` | Fluent 强调色的观感区间（Windows 蓝 `#0067c0` ≈ `0.42`） |
| ④ **对比度不够就继续压暗** | 白字对比度 `< 4.5` ⇒ `L -= 0.02` 直到够 | ⚠️ **对比度优先于「保留原色」** —— 强调色看不清比颜色不准严重得多 |

产物三个值：
- `--accent`：强调色
- `--accent-hover`：同一色相、`L - 0.12`（悬停态）
- `--focus-ring`：强调色 + 35% 透明（与 `tokens.css` 的 `#0067c059` 同一形态）

### 2.4 接线

`src/ui/useCoverAccent.ts`（新）：

```
当前播放歌曲的 coverId
  → 变了就重新取主色（按 coverId 缓存）
  → toFluentAccent
  → 写 <html> 的内联 --accent / --accent-hover / --focus-ring
```

- ⚠️ **只在 Fluent 主题下生效**：Apple 风按规格是「单色高饱和点缀」（**固定**）⇒
  切回 Apple 风 ⇒ **移除内联覆盖** ⇒ 回到 CSS 里的主题色。
- ⚠️ **取不到色（无封面 / 加载失败 / 灰白封面）⇒ 移除覆盖** ⇒ 保持主题默认色。
- ⚠️ **不新增 CSS 令牌**（`tokens.css` 的变量集合有契约测试钉着）⇒ 只覆盖**已有**令牌。

---

## 三、影响文件清单

| 文件 | 改动 |
|---|---|
| `src/components/coverColor.ts` | **新增**：共享取色模块（搬 T15 的代码 + 新增主色算法） |
| `src/pages/FullPlayerPage.tsx` | 改成从新模块取，并 **re-export** 旧名字（既有 import 路径不变） |
| `src/ui/accentColor.ts` | **新增**：纯色彩数学（hex↔HSL、WCAG 对比度、`toFluentAccent`） |
| `src/ui/useCoverAccent.ts` | **新增**：hook（取色 → 转换 → 写 CSS 变量） |
| `src/App.tsx` | 调用 `useCoverAccent()` |
| `test/accent-color.test.ts` | **新增**：色彩数学单测 |
| `test/cover-accent.test.tsx` | **新增**：接线单测 |
| `docs/calibration.md` | 更正 Step K 的过时陈述 + 追加一节 |

---

## 四、验收点

1. `tsc --noEmit` exit 0；`vitest` 全绿（**既有测试一条不许删、断言一条不许削弱**）。
2. 色彩数学单测覆盖：
   - hex↔HSL 往返；
   - WCAG 对比度（黑↔白 = 21，`#0067c0` ↔ 白 = ?）；
   - `toFluentAccent` 对**任意输入**都保证白字对比度 ≥ 4.5（**性质测试**：扫一批颜色）；
   - 灰白封面 ⇒ `null`；
   - 输入非法（空串 / 非 hex）⇒ `null`，**不抛**。
3. 接线单测覆盖：Fluent + 有封面 ⇒ 写 `--accent`；Apple ⇒ **不写**；取不到色 ⇒ **移除**；
   切主题 ⇒ 覆盖被移除。
4. 既有 `test/lyric-view.test.tsx` 的取色相关用例**一字不改**且仍全绿。
5. 真机：切到 **Windows 11 风** ⇒ 播放不同歌曲 ⇒ 强调色随封面主色变化。

---

## 五、明确不做

- **Apple 风不改**（规格明写「单色高饱和点缀」）；
- 不加设置开关（本轮不扩范围；真机看下来若要「关掉封面取色」，再加一个偏好项）；
- 不做颜色过渡动画（`@property` 注册自定义属性才能过渡，会动 `tokens.css` 的变量集合 ⇒ 有风险）；
- 不改 `tokens.css` 的令牌集合（有契约测试钉着）；
- 不动 `extractCoverColor` 的平均色算法（既有行为与既有断言一字不变）。
