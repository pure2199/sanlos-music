# T128 —— 接服务端「初始化状态」端点 `/initialization/state`（组 C 第二项）

> 起因：**ABCD 全做**里的 **C 组（接没用过的既有端点）**。
> T119 扒 NAS 自托管的 Web 前端时反解出 **19 组 / 92 条**端点，其中 4 条客户端一直没用：
> `/search/playlist`、`/search/suggest`、`/artist/list-all`、`/initialization/state`。
> T127 已接 `/search/suggest`；本任务接 **`/initialization/state`**。
>
> 规格日期：**2026-11-20**　｜　用户拍板：**「按方案开始」**（方案含三态设计 ＋ 连接页/搜索页两个落点）。

---

## 一、事实依据（**实测 ＋ 扒包**，不是推测）

### 1. 真机实测（2026-11-20，FN 中继 ＋ 真实 NAS，**只读 GET**）

探针：`release/verify/t127-01-probe-endpoints.mjs`（**gitignored**，不入库）

| 端点 | 实测 |
|---|---|
| `GET /initialization/state` | `code=0`，`data = { initialized: true }`，**`data` 只有这一个字段**，耗时 **174 ms** |

⚠ **端点不存在时的形状**（T119 记录的判据）：HTTP 200 但 body = **`null`**
⇒ `apiCall` 会因「响应不是预期信封」**抛错**（不是返回空对象）⇒ 客户端必须**捕获**。

### 2. ⭐ 扒 NAS Web 前端包得到的语义证据（**代码级证据，比推测硬**）

| 证据 | 出处（`release/verify/t118-web/` 的 chunk） | 含义 |
|---|---|---|
| `entryRoute = initialized ? (currentUser ? '/' : '/login') : '/welcome'` | `bdf49c3c…js` | **`initialized === false` ⇒ 路由到 `/welcome`（初始化引导页）** |
| `k = data?.initialized === false` | `8a84e406…js` | 服务端另有专门的「未初始化」分支 |
| `AppNotInitialized` = "The app has not been initialized." | `5e884898…js` 错误码表 | 「未初始化」是**服务端的一等状态** |
| `InitRequiresNASAdmin` = "Initialization requires NAS administrator permissions." | 同上 | 初始化**需要 NAS 管理员权限** |
| `clientLogin.serverNotInitialized` | `8a84e406…js` | 客户端登录流程也认这个状态 |

⇒ **结论**：`initialized` = **飞牛音乐这个「应用」有没有完成首次初始化**（扫库 / 建索引），
**不是**「NAS 有没有登录」。
⇒ **未初始化 ⇒ 曲库索引没建好 ⇒ 搜索 / 建议 / 榜单全是空的**。

### 3. ⭐ 客户端的真正价值

用户在桌面端搜不到东西却**不知道为什么** ⇒ 现在只能反复搜。
接上这个端点后，客户端可以**如实告诉他**「不是没找到，是服务端还没初始化，
请去飞牛音乐**网页端**完成初始化」。

⚠ **绝不能碰写操作**：`/initialization/prepare`、`/initialization/confirm` 是 **POST**
且要 NAS 管理员权限 ⇒ 本客户端**只读**、不写。

---

## 二、范围

**做**：接 `/initialization/state` ⇒ 客户端能知道「服务端音乐服务有没有初始化」。

**不做**：

| 项 | 理由 |
|---|---|
| 触发服务端初始化 | `prepare`/`confirm` 是 POST ＋ 要 NAS 管理员权限 ⇒ **只读** |
| 改 `sessionStore` | 既有断言 `Object.keys(session).sort()` 是**精确数组** ⇒ 加字段就红 ⇒ 状态放**独立 store** |
| 「未初始化」时自动降级 | 未初始化是**服务端状态**，客户端无能为力 ⇒ 只**如实告知** |

---

## 三、设计

### 1. ⭐ 三态（**本设计的核心**）

服务端状态一律**三态**：

| 值 | 含义 | 界面反应 |
|---|---|---|
| `true` | 已初始化 | 正常（显示「已初始化」） |
| `false` | **未初始化** | 显示**醒目提示**（含「去飞牛音乐网页端完成初始化」） |
| `null` | **未知**（老服务端没这端点 / 字段缺失 / 请求失败） | ⚠ **一个字都不显示**（界面与今天**完全一样**） |

⚠ **「未知」绝不当成「未初始化」** ⇒ 老服务端上**零可见变化**。
⚠ 实现上用 `boolean | null`（**不是** `boolean`）⇒ 类型层面就防住「忘了判空」。

### 2. 分层

| 层 | 做法 |
|---|---|
| **API**（新 `src/api/initialization.ts`） | `initializationApi.state(): Promise<boolean \| null>`；端点不存在 / 抛错 ⇒ 返回 **`null`**（**不崩**） |
| **Store**（新 `src/state/initializationStore.ts`） | 独立 zustand store（照 `discoverStore` 形状，`deps` 可注入）：`initialized`／`loaded`／`error` ＋ `load()` |
| **触发**（`src/App.tsx`） | 监听 `connected` 变 true ⇒ 拉**一次**（覆盖「手动登录」＋「会话恢复」两条路）⇒ 缓存，不重复打 NAS |
| **落点 A**（`src/pages/LoginPage.tsx`） | 「已连接」区块加一条事实「音乐服务：已初始化／未初始化」；未初始化时给**醒目提示** |
| **落点 B**（`src/components/SearchPanel.tsx`） | 搜索**空结果**处：未初始化 ⇒ 文案换成「服务端尚未初始化（曲库索引还没建好）」；否则仍是「没有找到」 |
| **Mock**（`mock-server/server.ts`） | 加 `/initialization/state`（默认 `true`；**按实例注入**可返回 `false` ⇒ 用来验未初始化界面） |

### 3. ⚠ 三条硬约束（**从既有断言里读出来的**，不是猜的）

1. ⭐ **提示文案绝不能包含「已连接」四个字** —— 既有断言是 `findByText('已连接')`
   （`test/login-page.test.tsx`）⇒ 多一个匹配就**红**。
2. **新增事实项的值不能是 `'demo'`** —— 既有断言 `getByText('demo')` 是**精确匹配**。
3. **既有 37 条 LoginPage 用例一条不许删、一条不许弱化**。

### 4. 错误处理

| 情况 | 行为 |
|---|---|
| 端点不存在（body = `null`）⇒ `apiCall` 抛「响应不是预期信封」 | **捕获** ⇒ `initialized = null`（未知）⇒ **不显示任何提示** |
| 网络 / 服务端错误 | 同上 ⇒ `null` ＋ store 记 `error`（**不弹给用户**） |
| 未初始化 | `false` ⇒ 两个落点都显示提示 |

---

## 四、钉子（**8 条**，新文件 `test/t128-initialization-state.test.tsx`）

| # | 钉子 | 钉住什么 |
|---|---|---|
| ① | `initializationApi.state()` 打 `/initialization/state`；返回 `{initialized:true}` ⇒ `true` | 端点路径 ＋ 透传 |
| ② | 响应里**没有** `initialized` ⇒ `null`（**不是 false**） | 缺失当未知 |
| ③ | 端点抛错 ⇒ **不崩**，返回 `null` | 老服务端兼容 |
| ④ | store：端点给 `false` ⇒ `initialized === false`；给 `true` ⇒ `true`；给 `null` ⇒ `null` | 三态映射 |
| ⑤ | 连接页：`false` ⇒ 显示「未初始化」提示 ＋ 事实项 | 落点 A（负向） |
| ⑥ | 连接页：`true` ⇒ 显示「已初始化」，**不**显示未初始化提示 | 落点 A（正向） |
| ⑦ | 搜索页空结果：`false` ⇒ 文案换成未初始化说明；`true`/`null` ⇒ 仍是「没有找到」 | 落点 B |
| ⑧ | **未知（`null`）⇒ 任何页面都不显示未初始化提示** | 不把「未知」当「未初始化」 |

---

## 五、影响文件清单

| 文件 | 动作 | 行尾 |
|---|---|---|
| `docs/superpowers/specs/2026-11-20-sanlos-music-t128-initialization-state.md` | 新建（本文件） | LF |
| `src/api/initialization.ts` | 新建：`initializationApi.state()`（三态） | LF |
| `src/state/initializationStore.ts` | 新建：zustand store（deps 可注入） | LF |
| `src/App.tsx` | `connected` ⇒ 拉一次 | LF |
| `src/pages/LoginPage.tsx` | 事实项 ＋ 未初始化提示 | LF |
| `src/pages/login-page.css` | 提示样式（只用语义变量 ＋ `var(--radius-*)`） | LF |
| `src/components/SearchPanel.tsx` | 空结果文案分流 | ⚠ **CRLF** ⇒ **Node 脚本改** |
| `mock-server/server.ts` | 加 `/initialization/state`（可注入 false） | ⚠ **CRLF** ⇒ **Node 脚本改** |
| `test/t128-initialization-state.test.tsx` | 新建（**8 条**钉子） | LF |
| `e2e/t128-initialization-state.spec.ts` | 新建（真 Electron：mock false ⇒ 提示出现） | LF |
| `docs/calibration.md` | 新增**第一百零七节** | ⚠ **CRLF** ⇒ **Node 脚本改** |
| `docs/changelog.md` | 「未发布」段加一行表格 | ⚠ **CRLF** ⇒ **Node 脚本改** |
| 台账（**仓库外** `progress-ledger.md`） | 新增 T128 段 | LF |

---

## 六、验收点

- `tsc --noEmit` **0 错**；
- `vitest` **全绿**（既有**一条不删、一条不弱化**，尤其 `test/login-page.test.tsx` 的 **37 条**）；
- `playwright` **全绿**（新增 1 条）；
- `npm run build` exit **0**；
- 字节体检 `release/verify/t115-10-bytes-check-all.mjs` **bad=0**；
- **变异自证 `MUTATION_OK`**：每个变体**认「红了哪几条」** ＋ **每个变体之间还原基线**。

---

## 七、遗留 / 如实标注的边界

- ⚠ **这台 NAS 上 `initialized` 恒 `true`** ⇒ 真机上**看不到**未初始化提示
  ⇒ 该界面用 **mock 注入 `false`** 证（如实标注，不假装真机验过）；
- ⚠ **「未初始化时能否登录成功」未实测**（这台机已初始化 ⇒ 测不了）
  ⇒ 若登录会失败，则客户端在登录页就报错 ⇒ 那种情况需要额外做**登录错误映射**（建议另立编号任务）；
- ⚠ **「未登录时能否查这个端点」未实测**（协议代理需要音乐服务凭据 ⇒ 客户端**登录后**才能查）
  ⇒ 故提示只能出现在**登录之后**（连接页 + 搜索页）；
- ⏳ **v0.4.5 未发**（本轮改了行为 ⇒ 发版另立编号任务）。
