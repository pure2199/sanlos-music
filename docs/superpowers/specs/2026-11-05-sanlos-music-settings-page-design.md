# T35 设计规格：设置页改成独立的整页（左侧分类 + 右侧内容）

- 日期：2026-11-05
- 状态：已获用户批准（问卷：改成独立的整页设置）
- 前置：Task 8（设置面板）、T23（自动更新）、T32 / T33（外部歌词源）

---

## 1. 背景与动机

用户反馈：**「设置页做得不对」**。

### 1.1 复现出来的具体症状

用真机探针（`release/verify/settings-shot.mjs`：复制真实 `userData` → 自动登录 → 打开设置 → 截图 + 量几何）复现：

| 症状 | 实测 |
| --- | --- |
| 面板**宽度只有 294px** | 主区宽约 1200px → 面板只占 **1/4** |
| 说明文字被**折成 2～4 行** | 「占位符：…」那段折成 4 行 |
| 输入框里的**示例 URL 被截断** | 看不全后半段 |
| 下半截（FFmpeg / 自动更新）**掉到视口外** | 只能在小窄条里滚动 |
| 面板**盖住顶栏** | 开着的时候别的顶栏按钮**点不到** |

⇒ 根因不是某一处样式，而是**形态错了**：一个 294px 的浮层，塞了 6 组设置。

### 1.2 用户拍板

| 决策点 | 结论 |
| --- | --- |
| 形态 | **改成独立的整页设置**（左侧分类 + 右侧内容） |
| 顶栏 | **保留且不被遮挡** |
| 分类 | 通用 / 歌词 / 下载 / 解码 / 更新（默认「通用」） |
| 数据模型 | **只改呈现，不改数据模型**（`prefs.json` 键、IPC、偏好白名单一字未动） |
| 主题开关 | **不在**设置页（顶栏已有，不重复加功能） |

---

## 2. 结构

### 2.1 视图模型

设置页从「顶栏下的浮层」变成**主区里的一个视图**（`App.tsx` 的 `MainView` 新增 `'settings'`）：

```
App
├─ .app-shell__topbar   ← 顶栏常驻，**设置页不再覆盖它**
│   └─ 「设置」按钮 → 进入 / 退出设置页
└─ .app-shell__main     ← 主区，任一时刻只有一个视图
    └─ case 'settings' → <SettingsPanel onClose={closeSettings} />
```

⚠️ **关闭后要回到来时的地方**：用户从「收藏」进去、关掉设置后被丢回「连接」页 = 迷路。
⇒ `App.tsx` 记住 `viewBeforeSettings`，关闭时恢复。

### 2.2 DOM

```html
<section class="fnm-settings" role="region" aria-label="设置">
  <nav class="fnm-settings__nav" aria-label="设置分类">
    <h1 class="fnm-settings__title">设置</h1>
    <button class="fnm-settings__nav-item" aria-current="page">通用</button>
    <button class="fnm-settings__nav-item">歌词</button>
    <button class="fnm-settings__nav-item">下载</button>
    <button class="fnm-settings__nav-item">解码</button>
    <button class="fnm-settings__nav-item">更新</button>
    <button class="fnm-settings__close">关闭设置</button>
  </nav>

  <div class="fnm-settings__content">
    <p class="fnm-settings__error" role="alert">…</p>   <!-- 永远在最上面 -->
    <fieldset class="fnm-settings__group">
      <legend class="fnm-settings__legend">关闭窗口时</legend>
      …
    </fieldset>
  </div>
</section>
```

- **`role` 从 `dialog` 改成 `region`**：它不再是一个模态浮层，是主区里的一个区域。
- **`aria-current="page"`** 标出当前分类（屏幕阅读器靠它播报）。
- **错误横幅永远在内容区顶部**（不属于任何一个分类）：用户可能正停在别的分类上 → 错误不能被藏起来。

---

## 3. 分类归属

| 分类 | 内容（`legend`） |
| --- | --- |
| 通用 | 关闭窗口时（隐藏 / 退出）+ 窗口位置说明 |
| 歌词 | 桌面悬浮歌词 + 歌词来源（外部源 / 自定义模板 / 保存歌词源） |
| 下载 | 本地下载（本地优先 / 下载目录 / 清空） |
| 解码 | FFmpeg 兜底解码（检测 / 重新检测） |
| 更新 | 自动更新（更新服务器地址 / 预期签名者 / 检查 / 下载 / 安装） |

**一次只渲染当前分类**（不是六组堆在一起）→ 旧浮层「一屏塞六组」的问题从结构上消失。

---

## 4. CSS 契约

`src/components/settings-panel.css` 整体重写。关键声明：

| 选择器 | 关键声明 | 为什么 |
| --- | --- | --- |
| `.fnm-settings` | `display: flex; flex: 1 1 auto; min-height: 0; height: 100%` | 撑满主区 → 是「整页」；**横向**两栏 |
| `.fnm-settings` | **没有** `position: absolute` | 不再是浮层 → 不会盖住顶栏 |
| `.fnm-settings__nav` | `flex: 0 0 190px` | 左栏固定宽 |
| `.fnm-settings__content` | `flex: 1 1 auto; min-width: 0; overflow-y: auto` | 右栏自己滚 |
| `.fnm-settings__group` | `max-width: 900px` | 内容列限宽 → 说明文字一行放得下 |
| `.fnm-settings__hint` | `max-width: 860px; line-height: 20px` | 同上 |
| `.fnm-settings__option--stack` | `max-width: 560px` | 输入框限宽 → 示例 URL 看得全 |
| `.fnm-settings__legend` | `font-weight: 600; border-bottom: 1px solid var(--border)` | 组标题变成加粗小标题 |

⚠️ **颜色只用语义变量**（`src/styles/tokens.css`）→ 契约测试扫一遍，**不许出现硬编码色值**。

⚠️ `.fnm-settings` 必须 `flex: 1 1 auto; min-height: 0; height: 100%` —— 主区 `.app-shell__main` 是
**flex 列容器**，不这么写则高度百分比解析不出来（与曲库页面外壳 `.fnm-page` 同一套，踩过）。

---

## 5. 测试策略

| 层 | 文件 | 钉的是什么 |
| --- | --- | --- |
| 单测 | `test/settings-page.test.tsx`（新增 11 条） | `role=region`、五个分类、默认「通用」、**一次只显示一类**、关闭回调、错误横幅不被分类藏起来 |
| CSS 契约 | `test/settings-page-css.test.ts`（新增 10 条） | 每条关键声明 + **没有绝对定位** + **没有硬编码色值** |
| E2E | `e2e/smoke.spec.ts`（新增 1 条） | **真实几何**：设置页宽度 ≥ 主区 80%、上边缘在顶栏**之下**、五分类可切、开着时顶栏照样点得到、关掉回到来时的视图 |

⚠️ **既有测试一条不删、断言一条不削弱**：

- `test/settings-lyric-source.test.tsx`（11 条）：**断言一字未改**，只加「先点左侧『歌词』分类」这一步。
- `test/settings-panel.test.tsx`（4 条）：默认分类就是「通用」→ **一字未改**。
- E2E 里 `getByRole('dialog', {name:'设置'})` → `region`（形态变了，语义跟着变）。

---

## 6. 已知限制 / 待办

- **分类状态不跨开关保留**：设置页每次重新进入都停在「通用」。要不要记住上一次那一档，留给用户反馈。
- **窄窗口**：左栏固定 190px；窗口很窄时右栏会被挤窄（`min-width: 0` 保证不溢出，但内容会变窄）。
- **主题开关仍在顶栏**：没有搬进设置页（用户拍板：不重复加功能）。
- 真机肉眼复验（本轮只做了自动化验证）**尚未做**。
