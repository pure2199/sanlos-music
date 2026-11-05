# T44 设计规格：会话层加请求超时 + 登出不阻塞

- 日期：2026-11-05
- 状态：**已获用户批准**（用户报障：「软件老是有顿卡，点退出登陆没反应」）
- 前置：T7（会话层）、T18-1（中继域名不补端口的第一条例外）

---

## 1. 背景与动机

用户同时报了两个症状：

| 症状 | 原话 |
| --- | --- |
| 界面卡顿 | 「软件老是有顿卡」 |
| 登出无响应 | 「点退出登陆没反应」 |

⇒ 按**系统化调试**（先定位根因、再改）走，不猜。

---

## 2. 根因（Phase 1：证据链）

### 2.1 病根：主进程会话层的 HTTP 请求**没有超时**

`electron/session.ts` 的 `send()`：

```ts
return await this.http().fetch(url, { method, headers, body: bodyString })   // ⚠️ 不传 signal
```

`electron/http.ts` 的 `fetch(input, init)` **支持** `init.signal`（标准 `RequestInit`），
但会话层**从没传过** → 网络一抖动就挂到 **TCP 超时**（Windows 默认可达 21 秒+）。

**对照（Phase 2：找可用的参照）**：项目里**其它出网路径都有超时**——
`electron/probe.ts` 有 `PROBE_ERROR_TIMEOUT` 与逐候选超时控制；
**唯独会话层没有** → 这就是差异点。

⚠️ **用户的环境放大了它**：用户的 NAS 走**公网反向代理**（T43 实测：`https://<域名>/music`
能通，链路是 openresty → 443）→ 延迟更高、抖动更多。

### 2.2 症状 1：点「退出登录」没反应

链路（全部核对过）：

```
渲染层 LoginPage.handleLogout()
  └─ await bridge.logout()                    ← 渲染层在等
       └─ IPC 'auth:logout'
            └─ handleLogout(session)
                 └─ await session.request('user/logout')   ← ⚠️ **先等网络**
                      └─ send() → http.fetch（无超时）
```

⇒ 网络不通 / 中继不通 / NAS 无响应 → 这一行**永久挂住** → 渲染层 `await` 不返回
→ `busy` 锁死、按钮 `disabled` → **界面看着就是「点了没反应」**。

⚠️ 更糟：token 已失效（`99999`）时，`session.request()` 会**先 `relogin()`**
（一次**完整的登录往返**）→ 再重试登出 → 等得更久。

⇒ ⚠️ **`src/App.tsx` 里早就写着**同一设计（「立刻切视图，不等 `logout()`」，
并注明「登出要先通知服务端，网络不通时可能挂住十几秒」）——
**但 `handleLogout` 一直没做到**（外壳层做了，会话层没做）。

### 2.3 症状 2：老是有顿卡

- 任何业务请求在网络抖动时挂到 TCP 超时 → 界面「顿住」；
- token 一旦失效，**每个**请求都变成 **3 个网络往返**：
  `失败(99999)` → `relogin()`（完整登录往返）→ `重试`。
  ⚠️ `relogin()` 失败时**返回 false**（不抛），旧代码**照样重试** →
  多花一个网络往返，而那个请求**同样会挂到超时** → 顿得更久。

---

## 3. 关键设计决定

### 3.1 超时：**双保险**（缺一不可）

```ts
return await Promise.race([
  this.http().fetch(url, { ...init, signal: controller.signal }),  // ① 真取消
  expired,                                                          // ② 只等这么久
])
```

| 层 | 作用 | 为什么两层都要 |
| --- | --- | --- |
| ① `signal`（`AbortController`） | 底层请求**真取消**，不留悬挂连接 | 真 Electron 的 Chromium 分区 fetch **实测支持** `AbortSignal`（探针 `release/verify/t44-abort-probe.js` 量到 **1217ms** 就中断） |
| ② `Promise.race` 兜底 | 即便底层**不理会** `signal`，我们也**只等**超时 | 单测里的假 fetch 就不理 `signal`；不兜底则测试会永远挂着 |

⚠️ **超时后必须 `clearTimeout`**：否则请求提前返回后定时器仍会 reject
→ 变成**无人处理的 rejection**（Node 打警告）。

### 3.2 超时值：**30 秒**

用户走公网中继（实测约 230KB/s），曲库分页 / 专辑详情这类 JSON 在慢网下要几秒
→ 30 秒足够宽裕；而**不设上限**的代价是「顿住到 TCP 超时」。

⚠️ **绝不能影响流式路径**：`track/stream`（音频）与 `static/cover`（封面）走
`electron/proxy.ts` 自己的 `fetch`（**不经过** `session.send()`）→ 不会被这里截断。
（**已核对** `proxy.ts` 的两条路径：JSON 路径走 `session.request()`，二进制路径自己拼 URL。）

### 3.3 续期失败 → **不再重试**

```ts
const renewed = await this.relogin()
if (!renewed) {
  return { status: first.status, json }      // ← 把第一次的 99999 原样交回去
}
```

⇒ 渲染层收到 `99999` → 立刻切回登录页（`src/App.tsx` 已有这条路径）→ 比「干等」好得多。
⚠️ 既有测试「续期一次并重试成功」「续期后仍是 99999 时只重试一次」**都是续期成功**的场景 → 不受影响。

### 3.4 登出：**先启动通知 → 立刻清理 → 立刻返回**

```ts
const notifying = Promise.resolve(session.request('user/logout')).catch(() => undefined)
session.clear()          // ⚠️ 必须在通知启动**之后**
return toSessionInfo(session)
```

⚠️ **顺序有讲究**：通知必须在 `clear()` **之前**启动 —— `clear()` 会清掉 token，
之后就发不出去了。`request()` 是 async 函数：调用它会**同步**跑到第一个 await
（请求头已带上凭证、请求已发出），之后才挂起 → 这个顺序是安全的。

⚠️ 用 `Promise.resolve(...)` 包一层：单测里的假 `session.request` 可能返回 `undefined`。

### 3.5 文案：**超时**与**连不上**分开说

| 情况 | 文案 |
| --- | --- |
| 超时 | 「无法连接音乐服务（响应超时：30 秒内没有响应）」 |
| 其他 | 「无法连接音乐服务（网络不可达或服务未响应）」 |

⚠️ 两句都**以「无法连接音乐服务」开头** → 既有断言（`/无法连接音乐服务/`、`toContain('无法连接音乐服务')`）
**一条都不用改** → 「既有测试一条不许删、断言一条不许削弱」的约束**天然满足**。

### 3.6 超时值**可注入**

`SessionManagerOptions.requestTimeoutMs`（缺省 30 秒）→ 单测注入 **80ms**（别真等 30 秒）。

---

## 4. 影响文件清单

| 文件 | 改动 |
| --- | --- |
| `electron/session.ts` | 新增 `SessionRequestTimeoutError` + `describeNetworkFailure()` + `DEFAULT_REQUEST_TIMEOUT_MS`；`SessionManagerOptions` 加 `requestTimeoutMs?`；新增私有 `fetchWithTimeout()`；`send()` / `postJson()` 改走它；`request()` 的续期失败不再重试 |
| `electron/ipc.ts` | `handleLogout()` 改成「先启动通知 → 立刻清理 → 立刻返回」 |
| `test/session.test.ts` | **新增** 3 条（超时内失败 / 超时与连不上是两句话 / 续期失败不再重试） |
| `test/ipc-auth.test.ts` | **新增** 1 条（服务端挂住时登出也能立刻完成） |
| `docs/superpowers/specs/2026-11-05-fnmusic-request-timeout-design.md` | **新**：本规格 |
| `README.md` / `docs/changelog.md` / `docs/calibration.md` | 文档同步 |

⚠️ **既有测试一条没删、断言一条没削弱**：本次**没有改写任何既有断言**
（超时文案刻意做成「无法连接音乐服务」的**超集**，让既有子串匹配继续成立）。

---

## 5. 验收点

1. `tsc --noEmit` exit 0；
2. `vitest` 全绿且**总数 ≥ 1697**（基线 1693 + 新增 4）；
3. `playwright` 既有 **24 条**全绿（本任务不改 UI → 不新增 E2E）；
4. **变异自证**（先红后复原，哈希回基线）**4 处**：
   - 去掉超时 → 「超时内失败」**红**；
   - 续期失败仍重试 → 「不再重试」**红**；
   - 登出改回等网络 → 「挂住也能立刻完成」**红**；
   - 超时与连不上不再区分 → 「是两句话」**红**；
5. U+FFFD 扫描 0、无 BOM、行尾保持原样（`docs/calibration.md` 仍 CRLF）；
6. 真机：点「退出登录」**立刻**有反应；公网链路抖动时界面不再长时间顿住（**用户复验**）。

---

## 6. 风险与待校准

- ⚠️ **「顿卡」可能不止这一个原因**：本轮定位并修掉了**一个高概率根因**
  （无超时 → 挂到 TCP 超时）。若用户复验后仍卡，需要**继续查**（下一步可用
  Chromium DevTools 的 Performance 面板 + 主进程日志）。
- ⚠️ **30 秒超时可能仍偏长**：如果用户觉得「还是顿」，可以把 `DEFAULT_REQUEST_TIMEOUT_MS`
  调小（改一个常量即可）。⚠️ 调太小会让慢网下的大列表请求**误判为失败**。
- ⚠️ **续期失败不再重试**的副作用：原来「续期失败也重试一次」的行为没了 →
  这类请求会**立刻**返回 99999 → 渲染层判定「会话失效」→ **切回登录页**。
  这是**期望行为**（旧行为只是白等一个网络往返，然后同样失败）。
- ⚠️ **附带发现**：本机 `safeStorage`（DPAPI）**可用**（探针实测加密 37 字节、可回读）
  → `session.bin` 能正常落盘；用户的 `%APPDATA%\fnmusic-desktop` 里**没有** `session.bin`
  ⇒ 说明用户**在这台机器上从未成功登录过**（不是落盘坏了）。
- ⚠️ **真机未验**：登录后退出是否立刻响应、界面是否不再顿（用户侧操作）。
