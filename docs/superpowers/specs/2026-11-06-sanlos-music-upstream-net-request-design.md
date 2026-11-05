# T56 规格：代理二进制路径改走 `net.request`（绕开 undici 的 ByteString 崩溃）

> 日期：2026-11-06
> 前置：T55（`e19a6a6` 规格 / `716195c` 实现）
> 状态：已拍板（用户在四个修法选项中选了「代理二进制路径改用 `net.request`」）

## 1. 起因

T55 的就绪判定改完之后，真机复验仍然拿不到转码产物：**只要走应用代理取产物就挂死**，
并在主进程弹「A JavaScript error occurred in the main process」。

T55 已定位到「就绪判定有窗口期」这一层并修好；本轮定位到**更下面一层**——
一个与就绪判定无关的**出网栈缺陷**。

## 2. 根因（字节级确认）

### 2.1 触发链

1. NAS 的转码产物端点 `GET /music/api/v1/download/track/transcode/file` 的响应带：

   ```text
   Content-Disposition: attachment; filename="占位曲目一 - 占位歌手二.mp3"; filename*=UTF-8''%E5%8D%A0%E4%BD%8D%E6%9B%B2%E7%9B%AE%E4%B8%80%20-%20%E5%8D%A0%E4%BD%8D%E6%AD%8C%E6%89%8B%E4%BA%8C.mp3
   ```

   `filename="…"` 这一段是**原始 UTF-8 字节**（`filename*` 是 RFC 5987 的百分号编码版）。

2. 主进程出网走 **Chromium 分区栈**（`electron/http.ts` → `session.fromPartition('fn-nas-v<epoch>').fetch()`）。
   Chromium 把响应头按 **UTF-8** 解码 ⇒ 上面那个头变成真正的 CJK 字符。

3. Electron 内部把上游响应头塞进 **undici 的 `Headers`** ⇒ `Headers.set` 要求
   **ByteString**（每个字符必须 ≤ 255）⇒ 抛
   `TypeError: Cannot convert argument to a ByteString because the character at index 22 has a value of 21344 which is greater than 255.`

4. `attachment; filename="` 恰好 **22** 个字符 ⇒ **index 22 就是文件名的第一个字符**，
   即 `占` = **U+5360 = 21344** —— 与报错里的数值**完全吻合**。

5. 该抛出发生在 **undici 的事件回调里**（不在我们的 `await` 链上）⇒
   变成**主进程未捕获异常**（弹错误框），同时那个 `fetch` **永远不会 settle**
   ⇒ 代理的二进制路径挂死 ⇒ 标准音质永远回退原始音质。

### 2.2 为什么别的路径没事

| 路径 | 上游是否带 `Content-Disposition` | 结果 |
| --- | --- | --- |
| `download/track/transcode/file` | **带**（中文歌名） | 崩 + 挂死 |
| `track/stream` | 不带 | 正常（实测 99 ms / 206） |
| `static/cover` | 不带 | 正常 |
| JSON 路径（`track/list` 等） | 不带 | 正常 |

### 2.3 为什么 Node 直连没事

Node 自己的 undici 把响应头按 **latin1** 解码 ⇒ 中文变成乱码字节（每字节 ≤ 255）⇒
**不抛错**。探针实测：同一端点、同一任务，Node 直连 **63 ms** 返回 206。

⇒ **同一台服务器、同一个端点，客户端栈不同 ⇒ 表现不同。** 这就是「代理挂 / 直连秒回」的全部原因。

### 2.4 服务端绕不过

实测 8 种查询参数（`inline=1` / `attachment=0` / `download=0` / `disposition=none` /
`contentDisposition=0` / `filename=0` / `noDisposition=1` / `type=stream`）**全部无效**，
`Content-Disposition` 照发。⇒ **只能改客户端。**

## 3. 方案

### 3.1 主路径：Electron 的 `net.request`

`electron/http.ts` 的 `HttpStack` 新增一个**流式**取上游的能力：

- Electron 运行时里走 **`net.request({ url, method, headers, session })`**；
- **`session` 传当前分区 session**（`fn-nas-v<epoch>`）⇒
  **证书放行语义一字不变**（自签 NAS 照常能用，`setCertificateVerifyProc` 照样生效）；
- `net.request` 的响应头是 **`Record<string, string | string[]>`（普通字符串）**，
  **不经过 undici 的 `Headers`** ⇒ **不做 ByteString 校验** ⇒ 非 ASCII 头**不会崩**。

### 3.2 非 Electron 回落

单测环境（Vitest）里没有 Electron ⇒ 回落到注入的 `fetchImpl` / 全局 `fetch`，
**行为与 T56 之前完全一致**（`test/proxy.test.ts` 与 `test/proxy-range.test.ts` 的既有断言一条不改、不削弱）。

### 3.3 上游响应头一律用「普通记录」承载

新类型 `UpstreamStream`：

```ts
export interface UpstreamStream {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>   // 键统一小写；值是普通字符串
  readonly body: ReadableStream<Uint8Array> | null
}
```

⚠️ **绝不**把上游响应头塞进 undici 的 `Headers`（那正是崩溃点）。
代理只把**白名单**里的头写进返回给渲染进程的 `Response`，
且**逐个做 ByteString 安全性检查**（含 >255 字符的值一律**跳过**，宁可少转一个头，
也不能让整个响应失败）。

### 3.4 行为保持不变的部分

- `Range` 请求头照旧透传（`net.request` 不禁 `Range`；禁用的是 `Content-Length` / `Host` / `Cookie2` 等）；
- 上游 `206` / `content-range` / `accept-ranges` **原样透传**；
- 上游 `content-encoding` 存在时**照样删掉 `content-length`**（解压后长度未知）；
- `401 / 403` 的**静默续期一次再重发一次**逻辑不变（重发即重新构造一个上游请求）；
- 响应体**继续流式转发**（不整块读进内存）；
- 渲染进程带来的 `cookie` / `authorization` **照样不透传**（凭证只由主进程注入）。

## 4. 影响文件

| 文件 | 改动 |
| --- | --- |
| `electron/http.ts` | 新增 `UpstreamStream` 类型；`HttpStack` 新增**可选**方法 `stream?()`；`createHttpStack` 实现它（Electron 走 `net.request`，无 Electron 回落 fetch）；惰性解析 `net`（保持「模块顶层不得 import Electron」） |
| `electron/proxy.ts` | `proxyBinary` 改用 `http.stream?.()`；上游响应头改用普通记录；转发前做 ByteString 安全检查 |
| `test/http-stack.test.ts` | 新增回归用例（`net.request` 路径：分区 session 被带上、非 ASCII 响应头不崩、回落路径与改前一致） |
| `test/proxy.test.ts` | 新增回归用例（上游头里带中文时，代理仍能正常返回响应） |
| `docs/calibration.md` | 记录根因与修法（CRLF） |
| `docs/changelog.md` | 一行（LF） |

⚠️ `HttpStack.stream` 做成**可选**方法 ⇒ `test/probe.test.ts` / `test/oauth-window.test.ts` /
`test/tray-tooltip.test.ts` 里的假 `HttpStack` **不需要改**；代理在 `stream` 缺席时回落到 `fetch`。

## 5. 验收点

1. `tsc --noEmit` 0 错；
2. `vitest run` 全绿（基线 1853 / 85 文件 + 新增用例；**既有断言一条没删、没削弱**）；
3. `playwright test` 24 条全绿；
4. `npm run build` 通过；
5. **真机**：偏好临时改成 `standard` ⇒
   - `<audio>.src` **就是** `fnm://srv/download/track/transcode/file?downloadId=…`（不再是回退的 `track/stream`）；
   - 播放进度在走（不是 0:00）；
   - **不出现**「标准音质不可用：…」的灰字提示；
   - **不再弹**「A JavaScript error occurred in the main process」；
   - 测完把 `prefs.json` 逐字节还原。

## 6. 边界与已知限制

- **JSON 路径仍走 `session.fetch`**（本轮不动）：目前观测到的 JSON 端点都不带非 ASCII 响应头；
  若哪天某个 JSON 端点也开始带中文头，同一个崩溃会复现——**留作后续观察项**。
- `net.request` 是 Electron 的 legacy API：它与 `session.fetch` **共用同一个 Chromium 网络栈**
  （同一个 `URLLoader`），差别只在「响应头不经过 undici 的 ByteString 校验」。
- `net.request` 不支持 `AbortSignal`：上游请求的中止语义与 T56 之前一致（代理本来也没把
  渲染进程的取消信号透传给上游）。
- 不引新 npm 依赖（只用 Electron 自带 `net` 与 Node 内置 `node:stream`）。
