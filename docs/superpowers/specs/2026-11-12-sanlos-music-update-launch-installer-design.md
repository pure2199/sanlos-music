# T89-⑥ 附带修复：「启动安装」在 Electron 主进程里取不到 shell（P0）

> 日期：2026-11-12
> 状态：设计已定，待实现
> 关联任务：T89-⑥（T87.18 本机 mock 实证）—— 实证过程里**发现**的阻断性缺陷
> 上游任务：T87（无证书可信发布）· T23（自动更新）

---

## 一、问题（真机实证发现的，不是推演出来的）

### 1.1 现象

应用「设置 → 自动更新」里下载完安装包后点「启动安装」，主进程返回：

```
启动安装包失败：当前进程没有 Electron 运行时，无法启动安装包
```

⇒ **安装器永远起不来** ⇒ 「自动更新」这条链路的**最后一步是断的**。

### 1.2 根因

`electron/update.ts` 的默认启动器 `defaultOpenPath()` 靠**惰性解析**拿 Electron 的 `shell`：

```ts
const req = (globalThis as unknown as { require?: (id: string) => unknown }).require
```

⚠️ **Electron 的主进程里 `globalThis.require` 是 `undefined`**。

实测（T87.18 探针，Electron 32.3.3 / Node 20.18.1）：

```json
{ "typeofGlobalThisRequire": "undefined", "typeofModuleScopeRequire": "function" }
```

⇒ `resolveElectronShell()` 恒返回 `null` ⇒ `defaultOpenPath()` 恒返回那句错误文案。

⚠️ **打包版一样坏**：主进程产物 `dist-electron/main.js` 是 esbuild 打成 **CJS** 的，
模块作用域里**有** `require`（Node 的 CJS 包装器提供），但 `globalThis.require` **仍然没有**
⇒ 「本地跑」与「装完跑」是**同一个**症状。

### 1.3 为什么一直没被发现

| 覆盖手段 | 为什么没抓到 |
|---|---|
| E2E `smoke.spec.ts`「自动更新：检查到新版本 → 下载校验通过 → 签名不过就不许安装」 | 只测**负路**（未签名 ⇒ 按钮被**禁用**）⇒ **走不到启动那一步** |
| `test/update.test.ts` | 全部**注入替身** `openPath` ⇒ 从不碰真实的惰性解析 |
| `test/update-store.test.ts` | 渲染层状态，不涉及主进程 |

⇒ **「启动安装」这条真机路径，此前从未被任何测试或实证覆盖过。**

---

## 二、方案

### 2.1 两处都改（根因 + 调用点）

| # | 位置 | 改法 | 为什么 |
|---|---|---|---|
| **1** | `electron/update.ts` | `resolveElectronShell()` 改成**优先用模块作用域的 `require`**，其次 `globalThis.require` | 修**根因**：主进程拿得到 `shell` ⇒ `defaultOpenPath()` 能用 |
| **2** | `electron/main.ts` | `createUpdateController({ …, openPath: (target) => shell.openPath(target) })` | 生产路径**不再依赖任何惰性解析** ⇒ 即使将来打包格式变了也不受影响 |

⚠️ **两处都改的理由**：① 是根因（`defaultOpenPath` 是公开导出，谁都可能用）；
② 是**兜底**（主进程本来就 `import` 了 Electron，不存在「顶层 import Electron」的问题）。

### 2.2 纪律不变的部分

- ⚠️ **仍然不许顶层 `import { shell } from 'electron'`**（`electron/update.ts`）：
  该文件要能在 **Vitest（普通 Node / ESM）** 里直接单测 ⇒ Electron 对象必须**惰性**解析
  （与 `electron/http.ts` 是同一套纪律）。
  ⇒ 因此改用「**类型声明 + `typeof` 守卫**」拿模块作用域的 `require`：

  ```ts
  declare const require: ((id: string) => unknown) | undefined
  ```

  ⚠️ `typeof require === 'function'` 是**安全**的守卫：ESM 里 `require` 根本不存在，
  `typeof` 不会抛 `ReferenceError`。

- ⚠️ **签名闸门一字不改**：`evaluateSignatureGate` / SHA-512 复核 / 同源校验全不动。
  本次只修「**拿到 shell 之后怎么启动**」这一环。

### 2.3 抽出一个可注入的纯函数（为了能单测）

```ts
export function pickRequire(moduleRequire, globalRequire): RequireFn | null
export function resolveElectronShellFrom(requireImpl): { openPath } | null
export function resolveElectronShell(requireImpl?): { openPath } | null
```

⚠️ 「主进程里真的拿得到 shell」这件事**单测验不了**（单测环境没有 Electron）
⇒ 由**真机实证**负责（见 §三）。

---

## 三、验收点

| # | 验收项 | 怎么验 |
|---|---|---|
| A1 | `tsc --noEmit` | exit 0 |
| A2 | 单元测试（新增 `test/update-launch-installer.test.ts`） | 钉住 `pickRequire` 的**挑选顺序**、惰性解析的各种容错分支、`defaultOpenPath` 不抛错 |
| A3 | 既有测试**一条不许删、断言一条不许削弱** | vitest 总条数只增不减 |
| A4 | **真机实证 F0 / F8 转绿** | `release/verify/t89-6-entry.ts`：生产路径能取到 `shell`；「启动安装」真的把安装器拉起来 |
| A5 | 实证**负路**不受影响 | 未授权仍被拒（F7）；篡改 1 字节仍被哈希闸门拦下（F11） |

---

## 四、明确不做的事

- ❌ 不改签名闸门口径（未签名包仍需用户显式授权 + SHA-512 相符）。
- ❌ 不改安装器本身的行为（仍然是 `shell.openPath`，仍然**完全静默**、不点任何按钮）。
- ❌ 不引入新 npm 依赖。
- ❌ **不改其它模块的惰性解析** —— ⚠️ **已逐个核对过，全仓库只有 `update.ts` 用错了**：

  | 模块 | 取 `require` 的方式 | 结论 |
  |---|---|---|
  | `electron/http.ts` | **模块作用域** `require`（`declare const require` + `typeof` 守卫） | ✅ 正确 |
  | `electron/ipc.ts` | 同上 | ✅ 正确 |
  | `electron/localLibrary.ts` | 同上 | ✅ 正确 |
  | `electron/oauthWindow.ts` | 同上 | ✅ 正确 |
  | `electron/tray.ts` | 同上 | ✅ 正确 |
  | `electron/session.ts` | 同上 | ✅ 正确 |
  | `electron/schemes.ts` | 同上 | ✅ 正确 |
  | **`electron/update.ts`** | **`globalThis.require`** | ❌ **孤例 ⇒ 本次修** |

  ⇒ 这也解释了为什么**出网栈**（自签 NAS 的证书放行）一直好使：
  `http.ts` 的 `resolveElectronSession()` 用的是**模块作用域**的 `require` ⇒ 主进程里拿得到 `session` ✓。
  ⇒ 本次修复**与既有惯例一致**（不是引入新写法，是把孤例改回惯例）。

---

## 五、待验证 / 待真机确认

- [ ] T87.18 实证 F0 / F8 转绿（本次必须做到）。
- [ ] 装上 v0.2.6 后，用户手动点一次「启动安装」是否真的拉起安装器
      （本次实证用的是**仓库构建**，不是打包产物）。
- [ ] 打包产物（`dist-electron/main.js`）里 `require` 的**模块作用域**是否存在
      ⇒ 由「本地 `npm start` 走一遍」确认（esbuild CJS 产物，理论成立）。
