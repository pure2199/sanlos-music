# T78 —— 桌面歌词浮层的**卡拉OK 扫光改成固定亮蓝**（规格）

> 起因（2026-11-09）：T77 上线后的**真机观察** —— 用户要「打开软件」看一眼，
> 结果截图里桌面歌词的**文字整体是主题蓝**，与 T77 的口径（「固定白字 + 深色描边，
> **不跟主题走**」）不一致。
>
> 用户拍板（同轮问卷）：
> **「固定亮蓝扫光」** —— 已唱部分用**固定的亮蓝**（不跟主题走）；未唱部分纯白 + 深描边。
> 整体观感 = 酷狗桌面歌词。

---

## ① 现状（**已查证**，非推测）

| 位置 | 代码 | 结论 |
|---|---|---|
| 已唱词着色 | `src/ui/lyrics/lyric-view.css` `.fnm-lyricview__word--sung` | `color: var(--accent)` ⇒ **主题色**（Apple `#0a66ff` / Fluent `#0067c0`） |
| 当前词扫光 | 同上 `.fnm-lyricview__word--karaoke` | `background-image: linear-gradient(90deg, var(--accent) …)` + `background-clip: text` ⇒ **也是主题色** |
| 基础文字 | `src/ui/lyrics/lyric-overlay.css` | T77 已覆盖为 `--lyric-float-text` / `-text-dim`（纯白 / 暗白）**两主题同值** |

⚠️ **真机实测**（2560×1440 整屏截图，浮窗区域逐像素统计）：
**主题蓝 3518 像素 / 白 218 像素** ⇒ 视觉上「白色歌词」几乎看不到，**整行都是主题色**。

⚠️ **规格漏洞**：T77 规格只写了「覆盖 `--text-primary` / `--text-secondary`」，
**没有覆盖到着色层** ⇒ 基础字是白的、但**被着色层盖住的部分是主题色**
⇒ 与「不跟主题走」的口径冲突。

⚠️ **为什么这条着色**必须**单独**处理**：它来自**共享组件** `lyric-view.css`
（词岛 / 歌词舞台 / 主界面**都在用**）⇒ **不能**直接改共享文件，
否则会**连带改掉另外三处**的卡拉OK 颜色（那是 T71 的一致性承诺）。

---

## ② 口径（用户已拍板）

1. **已唱部分** = **固定亮蓝**（**不跟主题走** ⇒ 两套主题**同值**）；
2. **未唱部分** = 纯白（当前行）/ 暗白 0.66（下一行），**一字不变**；
3. **深色描边**、**卡拉OK 推进逻辑**、**双行推进**、**词岛 / 歌词舞台 / 主界面**——**全部不变**；
4. 改法**只在桌面浮层内覆盖**（选择器带 `.fnm-lyricoverlay` 前缀）⇒ 作用域最小。

---

## ③ 设计

### ③-A 语义令牌（`src/styles/tokens.css`）

新增 **1 个**令牌（**两套主题同值**）：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--lyric-float-accent` | 固定亮蓝 `#4da6ff` | 已唱词着色 + 当前词扫光渐变 |

⚠️ 为什么是 `#4da6ff`：
- **够亮**（压在任意壁纸上、和纯白形成明显区分）；
- **够蓝**（一眼是「卡拉OK 扫光」，不是正文色）；
- 与两套主题的 `--accent`（`#0a66ff` / `#0067c0`）**明显不同**
  ⇒ 真机上「改没改」**一眼可见**（深蓝 → 亮蓝）。

⚠️ `test/theme.test.tsx` 钉着「两套主题的语义变量集合**完全相同**（不多不少）」
⇒ 这个令牌**两套主题都要写**（值相同）。

### ③-B 样式覆盖（`src/ui/lyrics/lyric-overlay.css`）

```css
.fnm-lyricoverlay .fnm-lyricview__word--sung {
  color: var(--lyric-float-accent);
}

.fnm-lyricoverlay .fnm-lyricview__word--karaoke {
  background-image: linear-gradient(90deg, var(--lyric-float-accent) 0%, var(--lyric-float-accent) 100%);
}
```

⚠️ **只覆盖 `background-image`**：`background-size`（= 词内进度）、
`background-repeat`、`background-position`、`color: transparent`
都由共享规则继续提供 ⇒ **扫光进度逻辑一字不改**。

⚠️ **特异性**：`.fnm-lyricoverlay .fnm-lyricview__word--karaoke`（0,2,0）
> `.fnm-lyricview__word--karaoke`（0,1,0）⇒ 覆盖成立。

⚠️ **着色层仍然 `text-shadow: none`**（T77）⇒ 描边只由底层原文提供一份，**不加倍**。

### ③-C 测试（`test/lyric-overlay-style.test.ts`）

**新增 3 条**：

1. `--lyric-float-accent` 在**两套主题里都存在**且**值相同**（照抄 T77 的令牌同值范式）；
2. `.fnm-lyricoverlay .fnm-lyricview__word--sung` 用 `var(--lyric-float-accent)`；
3. `.fnm-lyricoverlay .fnm-lyricview__word--karaoke` 的 `background-image` 用
   `var(--lyric-float-accent)`（且**不含** `var(--accent)`）。

⚠️ 第 3 条是**鉴别力**所在：谁把扫光改回主题色 ⇒ 必红。

### ③-D 变异自证

**M7**「把扫光改回主题色（`var(--accent)`）」⇒ 必红。

---

## ④ 验收

- `tsc --noEmit` exit 0；
- `vitest run`：**条数只增不减**（基线 96 文件 / 2042 条）；
- `npm run build` exit 0；
- Playwright E2E：**27/27**（不增不减）；
- **真机复验**：重启应用 → 桌面歌词「已唱词」= **亮蓝 `#4da6ff`**（不是主题深蓝）、
  「未唱词」= 纯白、深描边仍在、**背景仍透出桌面**。
