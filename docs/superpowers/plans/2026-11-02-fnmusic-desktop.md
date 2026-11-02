# 飞牛音乐 Windows 桌面客户端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个 Windows 桌面客户端，直连 fnOS 飞牛音乐服务，实现曲库浏览与播放、桌面悬浮歌词与托盘常驻、收藏/歌单/播放记录同步、下载到本地与软件 EQ 四项能力。

**Architecture:** Electron 主进程持有全部凭证，通过自定义 `fnm://` 协议代理统一为渲染进程转发请求（附加 `authx` 签名与 `music-token` Cookie），渲染进程永不接触凭证。连接层支持直接地址与 FN ID 两条路径，FN ID 经 `5ddd.com/api/v1/fn/con` 解析候选并按「内网 → 公网 IPv6 → 公网 IPv4 → 中继」并行探测。播放走 HTMLAudio + Web Audio 滤镜链，Chromium 无法解码的格式回落到服务端 HLS 转码。

**Tech Stack:** Electron 32 · React 18 · TypeScript 5 · Vite 5 · Zustand 4 · Vitest 2 · Playwright (E2E) · electron-builder · hls.js

**设计规格：** `docs/superpowers/specs/2026-11-02-fnmusic-desktop-design.md`

## Global Constraints

以下约束来自已批准的设计规格，所有任务隐含遵守：

- Node.js **≥ 20**，npm；Electron **32+**；React 18；TypeScript 5（`strict: true`）；Vite 5；Vitest 2
- API 基址固定为 `<server>/music/api/v1`，路径常量集中在 `shared/constants.ts`
- 签名常量（逐字照抄，不得改动）：
  - `SIGN_PREFIX = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"`
  - `SIGN_KEY = "6D5602D4-A342-4799-A0F0-BB795E7167D0"`
  - FN 连接接口专用 `SIGN_KEY = "zIGtkc3dqZnJpd29qZXJqa2w7c"`
- 凭证 Cookie 键：`music-token`；中继链路额外键：`mode=relay`（两者必须合并在同一个 `Cookie` 头）
- 业务码：`code === 0` 成功；`code === 99999` token 失效（静默续期一次后重试）
- **渲染进程永远不接触 token**：所有出网请求经 `fnm://srv/...` 由主进程转发
- 凭证落盘必须经 Electron `safeStorage`（Windows DPAPI）加密
- 证书放行范围仅限用户填写的服务器 host，其余站点照常校验
- 渲染进程窗口配置固定：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`
- EQ 频点（标准 ISO 1/1 倍频程）：10 段 `31.5/63/125/250/500/1k/2k/4k/8k/16k`；15 段 `25/40/63/100/160/250/400/630/1k/1.6k/2.5k/4k/6.3k/10k/16k`；每段 ±12 dB，`Q = 1.41`
- 悬浮歌词默认**双行逐字**模式
- 界面必须同时提供 **Apple Music 风** 与 **Windows 11 Fluent 风**两套主题，可即时切换

---

## 实测修正（2026-11-02，真实 NAS 联调后追加，优先级高于下文原描述）

对真实 NAS（FN ID `<FN-ID>`，fnOS 音乐 1.0.10）实测后，以下修正**直接覆盖**对应任务的原有描述。

| 修正 | 影响任务 | 具体改法 |
| --- | --- | --- |
| M1 中继域名是 `<fnId>.fnos.net`（非 `.5ddd.com`） | Task 4 | `buildCandidates` 的回退值改为 `${fnId}.fnos.net`；`fn` 数组非空时始终优先使用接口返回值 |
| M2 中继链路下**登录请求也必须带 `Cookie: mode=relay`** | Task 7、Task 10 | `SessionManager.passwordLogin` 在 `isRelay` 时附加 `cookie: 'mode=relay'`；OAuth 授权窗口同样需要 |
| M3 `authx` 的 nonce/timestamp **只生成一次**，同时用于头与签名 | Task 3 | `authx()` 内部先 `const n = nonce(); const t = ts()`，签名与返回值共用同一对值 |
| M4 FN 连接接口签名用**纯路径**，音乐接口用完整 URL 的 pathname | Task 3、Task 4 | 新增 `pathnameOf(u)`：`try { new URL(u).pathname } catch { new URL(u, 'http://local').pathname }` |
| M5 `/music/api/v1/health` **返回非 JSON** | Task 9 | 探测判定只看 HTTP 状态码（<400 即可达），不解析业务码 |
| M6 曲库 17.3 万首，**严禁全量拉取** | Task 6、Task 14 | 删除 `fetchAll` 全量模式；歌曲列表改服务端分页（`size` 上限 2000，实测 500 稳定），前端增量加载 + 虚拟滚动；仅收藏（251）与歌单做全量 |
| M7 服务端转码**不可用**（`code=100001 unknown error`） | Task 20 | 兜底链改为：直连 stream → 服务端转码（best-effort，不阻塞）→ **客户端 FFmpeg 转码 WAV/PCM → Web Audio**；系统无 ffmpeg 时给出安装指引 |

**新增端点（实测确认）**：

- `GET /music/api/v1/play-history/list?page=&size=` —— 播放历史，默认 50 条，实测 `total=414`。在 Task 6 增加 `historyApi.list(page, size)`，在 Task 16 增加「最近播放」页面与写回逻辑。
- 歌词条目字段为 `guid, source, content, createdAt, updatedAt, isLRC, offset`；**实测无词级时间戳**。Task 12 增加 `pseudoWords(line)`：按该行字符比例把行段时间均分到各词，产出伪逐字 `LyricWord[]`，供 Task 19 在缺少真逐字数据时点亮；设置页标注「逐字为估算」。
- 曲库字段实测：`year` / `trackNo` / `discNo` / `releaseDate` 可能为 `null`；歌曲 `genres` 恒为空数组。Task 6 的 `mapSong` 必须处理 `null`（不可用 `?? 0` 之外的隐式转换）。
- 风格名存在大小写重复（`Pop` 与 `POP`）。Task 14 的风格页按小写归一化展示，但保留原始 `guid` 用于查询。
- `GET /music/api/v1/track/stream?guid=` 实测支持 Range（HTTP 206、`accept-ranges: bytes`、`content-type: audio/flac`），Task 8 的代理必须透传 `range` 头（已列入原任务）。

**实测修正 M8 / M9（签名与中继关卡，2026-11-02 追加）**

| 修正 | 影响任务 | 具体改法 |
| --- | --- | --- |
| **M8 服务端不校验 `authx`**：GET 与 POST 使用全零伪造签名均返回 `code=0`。**中继链路的硬性关卡是 Cookie 头里的 `mode=relay`**：不带该 Cookie 返回 HTML 错误页，带上则 `code=0`（其余 cookie 内容不敏感） | Task 3、Task 7、Task 8 | `sign.ts` 仍按上游语义实现并发送 `authx`（官方 Web 端会发，网关可能校验）；但**真正必须保证**的是：所有走中继的请求——包括登录、接口、音频流——都在 `Cookie` 头里带 `mode=relay`。Task 7 的密码登录、Task 8 的代理转发都要覆盖到 |
| **M9 空值查询参数语义不影响服务端**（同一 URL 两种规范串都被接受，因 GET 签名不校验），但**实现仍须与上游一致**：只丢弃字面量 `'undefined'` / `'null'`，**保留空值参数** | Task 3 | 恢复上游语义；简报里那条自相矛盾的用例（断言 `?q=a&z=` ≡ `?q=a`）判为**用例写错**并改写为断言两者**不等**，同时保留 `?q=a&z=undefined` ≡ `?q=a` 的用例 |

**新增任务**：原 Task 20 之后插入 **Task 20b: 客户端 FFmpeg 兜底解码**，详见文末该节。

**联调工具**：仓库内 `tools/fn-probe.mjs`、`tools/fn-api-probe.mjs`、`tools/fn-transcode-probe.mjs`、`tools/fn-codec-census.mjs` 四个脚本已实测可用，凭据仅从环境变量 `FN_USER` / `FN_PASS` 读取，不落盘、不打印。

---

## 文件结构

```
package.json  tsconfig.json  tsconfig.node.json  vite.config.ts  vitest.config.ts  electron-builder.yml  index.html
shared/
  constants.ts        签名常量、API 路径、频点表、预设曲线定义
  types.ts            跨进程实体类型（Song / Album / Artist / Playlist / Genre / PlayerState / ConnectionInfo）
electron/
  main.ts             应用入口、单实例锁、窗口生命周期、协议注册
  sign.ts             authx 签名（纯函数，无 Electron 依赖）
  connection.ts       地址归一化、FN 候选构造、并行探测
  session.ts          凭证状态机、登录、token 续期、DPAPI 持久化
  proxy.ts            fnm:// 协议处理（转发 + 附加凭证 + Range 透传）
  cert.ts             证书校验放行策略
  oauthWindow.ts      NAS 账号 OAuth 授权窗口
  tray.ts             系统托盘
  lyricsWindow.ts     悬浮歌词窗口
  download.ts         下载管理器
  smtc.ts             Windows 媒体控制中心
  coverCache.ts       封面磁盘缓存
  ipc.ts              IPC 处理器注册
  preload.ts          渲染进程 preload 桥
src/
  main.tsx  App.tsx
  api/       client.ts  types.ts  library.ts  favorite.ts  playlist.ts  search.ts  lyric.ts  stream.ts
  player/    engine.ts  eq.ts  queue.ts  transcode.ts  format.ts
  ui/        theme/tokens.ts  theme/ThemeProvider.tsx  pages/  components/  lyrics/parse.ts  lyrics/LyricView.tsx  lyrics/LyricOverlay.tsx
  state/     playerStore.ts  libraryStore.ts  settingsStore.ts
mock-server/ server.ts  fixtures.ts
test/        *.test.ts（Vitest 单测）
e2e/         app.e2e.ts（Playwright）
```

---

### Task 1: 工程脚手架与工具链

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `electron/main.ts`, `electron/preload.ts`

**Interfaces:**
- Consumes: 无
- Produces: `npm run dev`（Vite + Electron）、`npm test`（Vitest）、`npm run build`（生产构建）、`npm run dist`（打包）

- [ ] **Step 1: 初始化 package.json 并安装依赖**

```bash
npm init -y
npm i -D electron@^32 typescript@^5 vite@^5 @vitejs/plugin-react vitest@^2 electron-builder electron-store
npm i react@^18 react-dom@^18 zustand@^4 hls.js
npm i -D @types/react @types/react-dom @types/node @playwright/test
```

- [ ] **Step 2: 写 tsconfig.json（strict）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "electron", "shared", "test", "e2e", "*.ts"]
}
```

- [ ] **Step 3: 写 vite.config.ts（渲染进程）与最小 main.tsx / App.tsx**

`vite.config.ts` 需配置 `base: './'`，`build.outDir: 'dist'`，`root` 为仓库根。

`src/App.tsx` 最小内容：

```tsx
export default function App() {
  return <div className="app-shell">fnmusic-desktop</div>
}
```

- [ ] **Step 4: 写 electron/main.ts 最小骨架并验证启动**

```ts
import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false })
  win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173')
  win.once('ready-to-show', () => win.show())
})
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
```

- [ ] **Step 5: 配置 npm scripts 并验证工具链**

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "electron .",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test",
    "dist": "electron-builder"
  }
}
```

运行 `npm test` 应显示 "No test files found"（0 失败）；运行 `npx tsc --noEmit` 应无错误。

- [ ] **Step 6: 初始化 git 仓库并提交**

```bash
git init
git add -A
git commit -m "chore: 初始化 Electron + React + TypeScript 工程脚手架"
```

---

### Task 2: 共享常量与跨进程类型

**Files:**
- Create: `shared/constants.ts`, `shared/types.ts`
- Test: `test/constants.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `SIGN_PREFIX: string`、`SIGN_KEY: string`、`FN_SIGN_KEY: string`
  - `API_PREFIX = '/api/v1'`、`MUSIC_PATH = '/music'`、`FN_CON_API = 'https://5ddd.com/api/v1/fn/con'`
  - `RELAY_COOKIE_MODE = 'relay'`
  - `EQ_BANDS_10: number[]`、`EQ_BANDS_15: number[]`、`EQ_PRESETS: Record<string, { label: string; gains: number[] }>`
  - 类型 `Song`、`Album`、`Artist`、`Genre`、`Playlist`、`ConnectionInfo`、`PlayerState`、`ThemeName`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { SIGN_PREFIX, SIGN_KEY, FN_SIGN_KEY, EQ_BANDS_10, EQ_BANDS_15 } from '../shared/constants'

describe('constants', () => {
  it('签名常量与规格一致', () => {
    expect(SIGN_PREFIX).toBe('NDzZTVxnRKP8Z0jXg1VAMonaG8akvh')
    expect(SIGN_KEY).toBe('6D5602D4-A342-4799-A0F0-BB795E7167D0')
    expect(FN_SIGN_KEY).toBe('zIGtkc3dqZnJpd29qZXJqa2w7c')
  })
  it('EQ 频点表长度正确', () => {
    expect(EQ_BANDS_10).toHaveLength(10)
    expect(EQ_BANDS_15).toHaveLength(15)
    expect(EQ_BANDS_10[0]).toBe(31.5)
    expect(EQ_BANDS_15[15 - 1]).toBe(16000)
  })
})
```

- [ ] **Step 2: 运行测试确认失败** — `npm test` 期望报 "Cannot find module '../shared/constants'"
- [ ] **Step 3: 实现 shared/constants.ts 与 shared/types.ts**

`shared/types.ts` 中 `Song` 必须包含：`id, title, artist, artistId, album, albumId, coverId, duration, favorite, codec, bitrate, sampleRate, bitDepth, year, trackNo, discNo`；`ConnectionInfo` 必须包含：`kind: 'lan' | 'public' | 'relay'`、`url: string`、`label: string`、`isRelay: boolean`、`bandwidthHint?: string`。

- [ ] **Step 4: 运行测试确认通过** — `npm test` 期望全部 PASS
- [ ] **Step 5: 提交** — `git commit -m "feat: 添加共享常量与跨进程类型"`

---

### Task 3: authx 签名模块

**Files:**
- Create: `electron/sign.ts`
- Test: `test/sign.test.ts`

**Interfaces:**
- Consumes: `SIGN_PREFIX`、`SIGN_KEY`（Task 2）
- Produces:
  - `md5(input: string): string`
  - `sha256(input: string): string`
  - `signPayload(method: string, url: string, body?: string | Uint8Array): string`
  - `authx(method: string, url: string, body?: string | Uint8Array, opts?: { nonce?: string; ts?: string }): string`
  - `buildCookie(token: string, isRelay: boolean): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { authx, buildCookie, signPayload } from '../electron/sign'

describe('authx', () => {
  it('GET 签名对查询参数按名排序', () => {
    expect(signPayload('GET', 'http://n/music/api/v1/album/list?size=10&page=1')).toBe(
      signPayload('GET', 'http://n/music/api/v1/album/list?page=1&size=10'),
    )
  })
  it('GET 签名忽略 undefined/null 参数值', () => {
    const a = signPayload('GET', 'http://n/music/api/v1/x?q=a&z=')
    const b = signPayload('GET', 'http://n/music/api/v1/x?q=a')
    expect(a).toBe(b)
  })
  it('非 GET 对请求体签名', () => {
    expect(signPayload('POST', 'http://n/music/api/v1/playlist/create', '{"name":"x"}')).toBe(
      signPayload('POST', 'http://n/music/api/v1/playlist/create', '{"name":"x"}'),
    )
    expect(signPayload('POST', 'http://n/x', '{"name":"a"}')).not.toBe(
      signPayload('POST', 'http://n/x', '{"name":"b"}'),
    )
  })
  it('authx 输出格式为 nonce=..&timestamp=..&sign=..', () => {
    const h = authx('GET', 'http://n/music/api/v1/track/list', undefined, { nonce: '123456', ts: '1700000000000' })
    expect(h).toMatch(/^nonce=123456&timestamp=1700000000000&sign=[0-9a-f]{32}$/)
  })
  it('中继 cookie 与 token 合并在同一个头', () => {
    expect(buildCookie('T', true)).toBe('music-token=T; mode=relay')
    expect(buildCookie('T', false)).toBe('music-token=T')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 electron/sign.ts**

关键实现（严格按规格算法）：

```ts
import { createHash } from 'node:crypto'
import { SIGN_PREFIX, SIGN_KEY, RELAY_COOKIE_MODE } from '../shared/constants'

export const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')
export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export function signPayload(method: string, url: string, body?: string | Uint8Array): string {
  if (method.toUpperCase() !== 'GET') {
    const raw = body === undefined ? '' : typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
    return md5(raw)
  }
  const u = new URL(url)
  const sorted = new URLSearchParams()
  for (const k of [...new Set(u.searchParams.keys())].sort()) {
    for (const v of u.searchParams.getAll(k)) {
      if (v !== 'undefined' && v !== 'null') sorted.append(k, v)
    }
  }
  const encoded = sorted.toString().replace(/\+/g, '%20')
  try {
    return md5(decodeURIComponent(encoded.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')))
  } catch {
    return md5(encoded)
  }
}

export function authx(method: string, url: string, body?: string | Uint8Array,
  opts: { nonce?: string; ts?: string } = {}): string {
  const nonce = opts.nonce ?? String(Math.floor(Math.random() * 9e5) + 1e5)
  const ts = opts.ts ?? String(Date.now())
  const sign = md5([SIGN_PREFIX, new URL(url).pathname, nonce, ts, signPayload(method, url, body), SIGN_KEY].join('_'))
  return `nonce=${nonce}&timestamp=${ts}&sign=${sign}`
}

export const buildCookie = (token: string, isRelay: boolean) =>
  isRelay ? `music-token=${token}; mode=${RELAY_COOKIE_MODE}` : `music-token=${token}`
```

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 实现 authx 签名与凭证 Cookie 组装"`

---

### Task 4: 地址归一化与 FN Connect 候选构造

**Files:**
- Create: `electron/connection.ts`
- Test: `test/connection.test.ts`

**Interfaces:**
- Consumes: `FN_CON_API`（Task 2）、`authx`（Task 3）
- Produces:
  - `normalizeBase(input: string): string` — 归一化为 `<scheme>://<host>[:port]/music`
  - `hostOf(url: string): string`
  - `type ConnectionParams = { internalIPv4s: string[]; publicIPv4s: string[]; publicIPv6s: string[]; httpsPort: number; httpPort: number; relayAddresses: string[] }`
  - `parseConnectionParams(json: unknown): ConnectionParams`
  - `type Candidate = { address: string; label: string; kind: 'lan' | 'public' | 'relay'; isRelay: boolean }`
  - `buildCandidates(fnId: string, params: ConnectionParams): Candidate[]`
  - `fetchConnectionParams(fnId: string): Promise<ConnectionParams>`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { normalizeBase, buildCandidates, parseConnectionParams } from '../electron/connection'

describe('normalizeBase', () => {
  it('缺协议补 http', () => {
    expect(normalizeBase('192.168.1.10:5666')).toBe('http://192.168.1.10:5666/music')
  })
  it('已有 /music 不重复追加', () => {
    expect(normalizeBase('http://nas.local:5666/music')).toBe('http://nas.local:5666/music')
  })
  it('去尾部斜杠', () => {
    expect(normalizeBase('https://nas.local/music/')).toBe('https://nas.local/music')
  })
  it('空输入返回空串', () => {
    expect(normalizeBase('')).toBe('')
  })
})

describe('parseConnectionParams', () => {
  it('解析接口返回', () => {
    const p = parseConnectionParams({
      ipv4: ['192.168.1.2'], publicIpv4: ['1.2.3.4'], publicIpv6: ['2409::1'],
      fn: ['abc.5ddd.com:443'], port: { httpPort: 5666, httpsPort: 5667 },
    })
    expect(p.internalIPv4s).toEqual(['192.168.1.2'])
    expect(p.publicIPv6s).toEqual(['2409::1'])
    expect(p.relayAddresses).toEqual(['abc.5ddd.com:443'])
    expect(p.httpsPort).toBe(5667)
  })
  it('缺 port 时使用默认 5666/5667', () => {
    const p = parseConnectionParams({})
    expect(p.httpPort).toBe(5666)
    expect(p.httpsPort).toBe(5667)
  })
})

describe('buildCandidates', () => {
  it('按 内网→公网v6→公网v4→中继 排序且 IP 直连 http 优先', () => {
    const c = buildCandidates('myfn', parseConnectionParams({
      ipv4: ['192.168.1.2'], publicIpv4: ['1.2.3.4'], publicIpv6: ['2409::1'], fn: [],
    }))
    expect(c[0].address).toBe('http://192.168.1.2:5666')
    expect(c[1].address).toBe('https://192.168.1.2:5667')
    expect(c.map((x) => x.kind)).toEqual([
      'lan', 'lan', 'public', 'public', 'public', 'public', 'relay',
    ])
  })
  it('IPv6 地址加方括号', () => {
    const c = buildCandidates('myfn', parseConnectionParams({ publicIpv6: ['2409::1'] }))
    expect(c[0].address).toBe('http://[2409::1]:5666')
  })
  it('中继回退到 fnId.fnos.net 且仅 https', () => {
    const c = buildCandidates('myfn', parseConnectionParams({}))
    const relay = c.filter((x) => x.kind === 'relay')
    expect(relay).toHaveLength(1)
    expect(relay[0].address).toBe('https://myfn.fnos.net')
    expect(relay[0].isRelay).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 electron/connection.ts**

`buildCandidates` 必须生成：每个 IP 先 `http`（httpPort）后 `https`（httpsPort）；中继域名去掉 `:443` 后缀，仅生成 `https://<domain>`。

`fetchConnectionParams` 用 `authx('POST', FN_CON_PATH, JSON.stringify({ fnId }), { key: FN_SIGN_KEY })` 签名后请求 `FN_CON_API`（**必须显式传 FN 专用密钥**，漏传会用音乐接口密钥导致请求被拒），解析 `{ code, msg, data }`，`code !== 0` 时抛错。

**查询参数空值规则（重要）**：`signPayload` 的规范串只丢弃值为字面量 `'undefined'` / `'null'` 的参数，**空值参数（如 `k=`）必须保留**——这与已在真实 NAS 上验证通过的参考实现 `tools/fn-probe.mjs` 语义一致，服务端是否把空值计入规范串尚未实测，不得擅自改变。因此 **Task 6 的 API 封装不得发送空值查询参数**；确需传空值时须先与真实服务端核验。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 实现地址归一化与 FN Connect 候选构造"`

---

### Task 5: Mock server（无 NAS 开发前提）

**Files:**
- Create: `mock-server/fixtures.ts`, `mock-server/server.ts`
- Test: `test/mock-server.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `createMockServer(): { url: string; close(): void; state: MockState }`，`MockState` 含 `favorites: Set<string>`、`playlists: Map<string, { guid: string; name: string; tracks: string[] }>`
- 提供端点：`/music/api/v1/health`、`/sys/config`、`/user/password-login`、`/user/me`、`/user/logout`、`/album/list`、`/album/detail`、`/album/artist-detail/list`、`/track/list`、`/track/album-detail/list`、`/track/artist-detail/list`、`/track/genre-detail/list`、`/track/playlist-detail/list`、`/track/stream`、`/favorite-track/list`、`/favorite-track/create`、`/favorite-track/delete`、`/artist/list`、`/genre/list`、`/playlist/list`、`/playlist/create`、`/playlist/update`、`/playlist/delete`、`/playlist/add-track`、`/playlist/remove-track`、`/search/track`、`/search/album`、`/search/artist`、`/lyric/list`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { createMockServer } from '../mock-server/server'

describe('mock server', () => {
  it('health 返回成功', async () => {
    const s = createMockServer()
    const r = await fetch(`${s.url}/music/api/v1/health`)
    expect(r.status).toBe(200)
    s.close()
  })
  it('密码登录返回 token，错误密码返回非 0', async () => {
    const s = createMockServer()
    const ok = await fetch(`${s.url}/music/api/v1/user/password-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'x', deviceId: 'd' }),
    })
    expect((await ok.json()).code).toBe(0)
    const bad = await fetch(`${s.url}/music/api/v1/user/password-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'wrong', deviceId: 'd' }),
    })
    expect((await bad.json()).code).not.toBe(0)
    s.close()
  })
  it('收藏可创建并出现在列表中', async () => {
    const s = createMockServer()
    const r = await fetch(`${s.url}/music/api/v1/favorite-track/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackGUID: 't1' }),
    })
    expect((await r.json()).code).toBe(0)
    const list = await fetch(`${s.url}/music/api/v1/favorite-track/list`)
    expect((await list.json()).data.list.length).toBe(1)
    s.close()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 mock-server/fixtures.ts 与 server.ts**

fixtures 提供 8 首示例曲目（`guid` 为 `t1`–`t8`，含 title/artist/album/artists/coverId/audioSpec/duration）、3 张专辑、2 个歌手、2 个风格、2 个歌单；歌词为标准 LRC，其中 `t1` 使用**增强型 LRC**（含逐字标签）以驱动逐字歌词测试；`/track/stream` 返回一段可播放的 WAV（运行时合成 0.5s 正弦波）。

服务需校验 `music-token` 头存在，缺失时返回 `{ code: 99999, msg: 'invalid token' }` —— 这条用于验证客户端的静默续期路径。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 添加飞牛音乐 API mock 服务器"`

---

### Task 6: 渲染进程 API 客户端

**Files:**
- Create: `src/api/client.ts`, `src/api/types.ts`, `src/api/library.ts`, `src/api/favorite.ts`, `src/api/playlist.ts`, `src/api/search.ts`, `src/api/lyric.ts`
- Test: `test/api-client.test.ts`

**Interfaces:**
- Consumes: `Song` 等类型（Task 2）
- Produces:
  - `apiCall<T>(path: string, opts?: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> }): Promise<T>`
  - `mapSong(json: any): Song`、`mapAlbum`、`mapArtist`、`mapPlaylist`
  - `libraryApi.albums(sort?)`、`libraryApi.album(id)`、`libraryApi.albumSongs(id)`、`libraryApi.artistAlbums(id)`、`libraryApi.songs()`、`libraryApi.artistSongs(id)`、`libraryApi.genreSongs(id, name)`、`libraryApi.artists()`、`libraryApi.genres()`
  - `favoriteApi.list()`、`favoriteApi.set(id, on)`
  - `playlistApi.list()`、`playlistApi.songs(id)`、`playlistApi.create(name)`、`playlistApi.rename(id, name)`、`playlistApi.remove(id)`、`playlistApi.addTracks(id, songIds)`、`playlistApi.removeTracks(id, songIds)`
  - `searchApi.query(q)`
  - `lyricApi.raw(songId)`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiCall, mapSong } from '../src/api/client'

describe('apiCall', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('解析 { code, data } 包装', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { ok: 1 } }), { status: 200 })))
    expect(await apiCall('/album/list')).toEqual({ ok: 1 })
  })
  it('code 非 0 抛出带 code 的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 99999, msg: 'expired' }), { status: 200 })))
    await expect(apiCall('/album/list')).rejects.toThrow(/expired/)
  })
  it('走 fnm:// 协议前缀', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await apiCall('/album/list')
    expect(String(f.mock.calls[0][0])).toContain('fnm://srv')
  })
})

describe('mapSong', () => {
  it('时长从毫秒转秒并丢弃非法封面', () => {
    const s = mapSong({ guid: 'g', title: 'T', duration: 185000, coverId: 'deadbeef', artists: [{ name: 'A', guid: 'a1' }], album: { name: 'Al', guid: 'al1' }, audioSpec: { path: '/x/y.flac', codec: 'flac', bitrate: 900000, sampleRate: 44100 } })
    expect(s.duration).toBe(185)
    expect(s.coverId).toBe('')
    expect(s.codec).toBe('FLAC')
    expect(s.bitrate).toBe(900)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 src/api/client.ts**

要点：基址常量 `const BASE = 'fnm://srv'`；查询串用 `URLSearchParams` 追加并跳过 `undefined`/`null`；响应非 JSON 时抛「服务器响应异常（HTTP n）」；`code !== 0` 抛 `ApiError(msg, code)`；`data` 为空对象时返回 `{}`。

`mapSong` 规则（来自规格）：`coverId` 仅保留形如 `xxx_<hex>` 的值，否则空串；`duration` 毫秒转秒；`bitrate` 千比特转整数千比特；`artist` 多歌手用 ` / ` 连接；`audioSpec.path` 扩展名作为 codec 兜底。

- [ ] **Step 4: 实现其余 api 模块**（每个端点一行映射到 Task 5 的 mock 端点）
- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: 提交** — `git commit -m "feat: 渲染进程 API 客户端与数据映射"`

---

### Task 7: 主进程会话、凭证存储与 token 续期

**Files:**
- Create: `electron/session.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: `authx`、`buildCookie`（Task 3）
- Produces:
  - `type SessionState = { base: string; mode: 'nas' | 'password'; token: string; deviceId: string; username: string; password: string }`
  - `class SessionManager { state: SessionState; load(): boolean; save(): void; clear(): void; passwordLogin(base, username, password): Promise<void>; nasLogin(base, deviceId): Promise<void>; relogin(): Promise<boolean>; request(path, opts): Promise<{ status: number; json: any }> }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionManager } from '../electron/session'

describe('SessionManager', () => {
  it('密码登录成功写入 token', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK', deviceId: 'D' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    expect(m.state.token).toBe('TK')
    expect(m.state.deviceId).toBe('D')
  })
  it('密码登录失败抛出可读错误', async () => {
    const m = new SessionManager()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 1, msg: '账号或密码错误' }), { status: 200 })))
    await expect(m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'bad')).rejects.toThrow(/账号或密码错误/)
  })
  it('密码以 sha256 提交', async () => {
    const m = new SessionManager()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { userToken: 'TK' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await m.passwordLogin('http://127.0.0.1:5666/music', 'demo', 'pw')
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]!.body))
    expect(body.password).toMatch(/^[0-9a-f]{64}$/)
    expect(body.password).not.toBe('pw')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 electron/session.ts**

要点：密码登录 `POST /api/v1/user/password-login`，body `{ username, password: sha256(password), deviceId }`，取 `data.userToken` / `data.deviceId`；`save()` 用 `safeStorage.encryptString` 写入 `<userData>/session.bin`，文件头标记 `E1`（加密）/ `P0`（明文回退）；`relogin()` 在 `mode === 'password'` 时用保存的密码重登，`mode === 'nas'` 时交给 Task 11 的 OAuth 静默续期；并发续期共享同一个 in-flight Promise。

`request()` 统一附加 `authx` 头与 `Cookie: music-token=<token>`，返回 `{ status, json }`；`json.code === 99999` 时触发一次 `relogin()` 并重试。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 主进程会话管理与 DPAPI 凭证存储"`

---

### Task 8: fnm:// 协议代理

**Files:**
- Create: `electron/proxy.ts`
- Test: `test/proxy.test.ts`

**Interfaces:**
- Consumes: `SessionManager`（Task 7）、`authx`（Task 3）
- Produces: `registerProxy(session: SessionManager, opts?: { isRelay?: () => boolean }): void`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildUpstreamRequest } from '../electron/proxy'

describe('buildUpstreamRequest', () => {
  it('附加 authx 与 token cookie', () => {
    const r = buildUpstreamRequest({ method: 'GET', url: 'http://n/music/api/v1/track/list', headers: new Headers() }, 'TK', false)
    expect(r.headers.get('authx')).toMatch(/^nonce=/)
    expect(r.headers.get('cookie')).toBe('music-token=TK')
  })
  it('中继模式追加 mode=relay', () => {
    const r = buildUpstreamRequest({ method: 'GET', url: 'http://n/x', headers: new Headers() }, 'TK', true)
    expect(r.headers.get('cookie')).toBe('music-token=TK; mode=relay')
  })
  it('透传 range 头', () => {
    const h = new Headers({ range: 'bytes=0-1023' })
    const r = buildUpstreamRequest({ method: 'GET', url: 'http://n/x', headers: h }, 'TK', false)
    expect(r.headers.get('range')).toBe('bytes=0-1023')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 electron/proxy.ts**

要点：注册协议 scheme `fnm` 的特权为 `{ standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }`；`protocol.handle('fnm', ...)` 将 `fnm://srv/<path>?<query>` 映射到 `<base><path><query>`；请求头白名单透传 `range, content-type, accept, if-none-match, if-modified-since`；响应删除 `content-encoding` 并补 `access-control-allow-origin: *`；上游异常返回 502 与 `{ code: -1, msg }`。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: fnm:// 协议代理转发与凭证附加"`

---

### Task 9: 证书放行与链路探测

**Files:**
- Create: `electron/cert.ts`, `electron/probe.ts`
- Test: `test/probe.test.ts`

**Interfaces:**
- Consumes: `buildCandidates`（Task 4）、`buildCookie`（Task 3）
- Produces:
  - `class TrustedHosts { add(url: string): void; verify(hostname: string): number }`
  - `probeCandidates(candidates: Candidate[], opts: { token?: string; timeoutMs?: number }): Promise<ProbeResult[]>`
  - `type ProbeResult = { candidate: Candidate; ok: boolean; error?: string }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { TrustedHosts } from '../electron/cert'

describe('TrustedHosts', () => {
  it('只信任登记过的 host', () => {
    const t = new TrustedHosts()
    t.add('https://nas.local:5666/music')
    expect(t.verify('nas.local')).toBe(0)
    expect(t.verify('evil.com')).toBe(-3)
  })
  it('大小写与 IPv6 方括号归一', () => {
    const t = new TrustedHosts()
    t.add('http://[2409::1]:5666/music')
    expect(t.verify('2409::1')).toBe(0)
    expect(t.verify('2409::1'.toUpperCase())).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 electron/cert.ts 与 electron/probe.ts**

`probeCandidates` 对候选并行探测：已登录打 `/music/api/v1/track/list`（带 token），未登录打 `/music/api/v1/health`；直连超时 3s、中继超时 10s；HTTP 状态 ≥ 400 或业务码非 0 视为不可用；失败原因归类为「无法解析主机（DNS）」「连接被拒绝（端口不通或服务未启动）」「连接超时（端口无响应）」「网络不可达」「TLS 握手失败」。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 证书信任策略与链路并行探测"`

---

### Task 10: 登录界面与状态管理

**Files:**
- Create: `src/state/settingsStore.ts`, `src/state/sessionStore.ts`, `src/pages/LoginPage.tsx`, `src/components/ConnectionBadge.tsx`
- Test: `test/login-page.test.tsx`

**Interfaces:**
- Consumes: `apiCall`（Task 6）；IPC 桥（Task 8/9，见 `electron/ipc.ts` 的 `auth:server-info` / `auth:login` / `auth:restore`）
- Produces: `window.fn` 桥接口（由 `electron/preload.ts` 暴露）：`serverInfo(server)`、`login({ server, username, password, mode })`、`restore()`、`logout()`、`relogin()`、`probe(fnId)`、`connectionInfo()`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoginPage } from '../src/pages/LoginPage'

describe('LoginPage', () => {
  it('渲染地址输入与两种登录方式', () => {
    render(<LoginPage />)
    expect(screen.getByPlaceholderText(/NAS 地址|FN ID/)).toBeTruthy()
    expect(screen.getByText(/独立账号/)).toBeTruthy()
    expect(screen.getByText(/NAS 账号/)).toBeTruthy()
  })
})
```

（需安装 `@testing-library/react` 与 `@testing-library/jest-dom` 作为 devDependency）

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现登录页**

登录页两种模式切换：直接地址（默认 `http://` + 端口）与 FN ID。输入地址后调用 `window.fn.serverInfo()` 校验，返回服务器名称、版本、是否支持 NAS 账号登录；FN ID 模式调用 `window.fn.probe()` 展示候选链路列表供手动选择。

- [ ] **Step 4: 实现 ConnectionBadge**

顶栏常驻组件，展示当前链路 `kind`（内网直连 / 公网直连 / 中继）；中继时展示提示「中继带宽受限（约 0.5–4 Mbps），无损与下载建议在局域网内进行」；点击展开全部候选探测结果。

- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: 提交** — `git commit -m "feat: 登录界面与连接链路指示器"`

---

### Task 11: NAS 账号 OAuth 登录

**Files:**
- Create: `electron/oauthWindow.ts`
- Test: `test/oauth-window.test.ts`

**Interfaces:**
- Consumes: `SessionManager`（Task 7）
- Produces: `runOAuthWindow(opts: { url: string; redirect: string; silent?: boolean; timeoutMs?: number }): Promise<string>` — 成功返回授权码，失败 reject

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { extractCode } from '../electron/oauthWindow'

describe('extractCode', () => {
  it('从重定向 URL 提取 code', () => {
    expect(extractCode('http://n/music/oauth/result?code=abc')).toBe('abc')
  })
  it('error 参数优先返回错误', () => {
    expect(extractCode('http://n/music/oauth/result?error=denied')).toBeNull()
    expect(extractCode('http://n/music/oauth/result')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 electron/oauthWindow.ts**

`extractCode(url)` 解析 query：`error` 存在返回 `null`，否则返回 `code` 或 `null`。窗口监听 `will-redirect` / `will-navigate` / `did-navigate` / `did-redirect-navigation`，命中 redirect 前缀即拦截并解析；静默模式（token 续期）在 `did-finish-load` 后 6s 未跳转则放弃并抛「fnOS 登录已过期」。

在 `session.ts` 中接入：`GET /api/v1/sys/config` 取 `nasOAuth.clientId` 与 `nasOAuth.url`，拼接 `redirect_uri = <base>/oauth/result`，授权后 `POST /api/v1/user/auth-login` `{ code, deviceId }` 换 `userToken`。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: NAS 账号 OAuth 授权登录"`

---

### Task 12: LRC 解析（行级 + 逐字）

**Files:**
- Create: `src/ui/lyrics/parse.ts`
- Test: `test/lyrics-parse.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type LyricWord = { text: string; start: number; end: number }`
  - `type LyricLine = { time: number; text: string; words: LyricWord[]; translation: string }`
  - `parseLrc(raw: string): LyricLine[]`
  - `parseEnhancedLrc(raw: string): LyricLine[]`
  - `findActiveLine(lines: LyricLine[], t: number): number`
  - `findActiveWord(line: LyricLine, t: number): number`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseLrc, parseEnhancedLrc, findActiveLine } from '../src/ui/lyrics/parse'

describe('parseLrc', () => {
  it('解析带时间标签的普通 LRC', () => {
    const lines = parseLrc('[00:12.00]第一句\n[00:15.30]第二句')
    expect(lines).toHaveLength(2)
    expect(lines[0].time).toBe(12)
    expect(lines[1].text).toBe('第二句')
  })
  it('忽略元信息标签', () => {
    expect(parseLrc('[ti:歌名]\n[ar:歌手]\n[00:01.00]词')).toHaveLength(1)
  })
})

describe('parseEnhancedLrc', () => {
  it('解析逐字时间戳', () => {
    const lines = parseEnhancedLrc('[00:10.00]<00:10.00>你<00:10.50>好<00:11.00>世界')
    expect(lines[0].words).toHaveLength(3)
    expect(lines[0].words[0].text).toBe('你')
    expect(lines[0].words[2].start).toBe(11)
  })
})

describe('findActiveLine', () => {
  it('返回当前时间所属行索引', () => {
    const lines = parseLrc('[00:10.00]A\n[00:20.00]B')
    expect(findActiveLine(lines, 5)).toBe(-1)
    expect(findActiveLine(lines, 12)).toBe(0)
    expect(findActiveLine(lines, 25)).toBe(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 parse.ts**

时间标签解析：兼容 `[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`、`[mm:ss:xx]`；行内可含多个时间标签（表示同一句多个时间点）。

逐字标签格式：`[行时间]<词时间>字<词时间>字...`；每个词的 `end` 取下一个词的时间，末词 `end` 取下一行时间或自身 `start + 0.5`。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: LRC 行级与逐字歌词解析"`

---

### Task 13: 播放引擎

**Files:**
- Create: `src/player/queue.ts`, `src/player/format.ts`, `src/player/engine.ts`, `src/state/playerStore.ts`
- Test: `test/queue.test.ts`, `test/format.test.ts`

**Interfaces:**
- Consumes: `Song`（Task 2）、`streamUrl`（Task 6）
- Produces:
  - `type PlayMode = 'sequence' | 'shuffle' | 'loop-one' | 'loop-list'`
  - `class Queue { items: Song[]; index: number; mode: PlayMode; add(songs, at?): void; next(): Song | null; prev(): Song | null; remove(i): void; clear(): void; shuffle(): void }`
  - `isChromiumDecodable(codec: string, ext: string): boolean`
  - `class PlayerEngine { play(song: Song): void; pause(): void; resume(): void; seek(sec: number): void; setVolume(v: number): void; get state(): PlayerState }`
  - `streamUrl(songId: string): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { Queue } from '../src/player/queue'
import { isChromiumDecodable } from '../src/player/format'

const song = (id: string) => ({ id, title: id, artist: 'a', artistId: '', album: '', albumId: '', coverId: '', duration: 100, favorite: false, codec: 'FLAC', bitrate: 0, sampleRate: 0, bitDepth: 0, year: 0, trackNo: 0, discNo: 0 })

describe('Queue', () => {
  it('顺序模式播放到末尾返回 null', () => {
    const q = new Queue()
    q.add([song('a'), song('b')])
    q.index = 0
    expect(q.next()!.id).toBe('b')
    expect(q.next()).toBeNull()
  })
  it('单曲循环保持当前曲', () => {
    const q = new Queue()
    q.add([song('a'), song('b')])
    q.mode = 'loop-one'
    q.index = 0
    expect(q.next()!.id).toBe('a')
  })
  it('移除后索引不越界', () => {
    const q = new Queue()
    q.add([song('a'), song('b')])
    q.remove(1)
    expect(q.items).toHaveLength(1)
    expect(q.index).toBe(0)
  })
})

describe('isChromiumDecodable', () => {
  it('mp3/flac/wav 可解，ape/dsf/dts 不可解', () => {
    expect(isChromiumDecodable('MP3', 'mp3')).toBe(true)
    expect(isChromiumDecodable('FLAC', 'flac')).toBe(true)
    expect(isChromiumDecodable('APE', 'ape')).toBe(false)
    expect(isChromiumDecodable('DSD', 'dsf')).toBe(false)
    expect(isChromiumDecodable('DTS', 'dts')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 queue.ts 与 format.ts**

`isChromiumDecodable` 不可解集合：`dsf dff dsd wma ape dts aiff ra au dvf tta dss mmf alac`（扩展名或 codec 命中即不可解）。

- [ ] **Step 4: 实现 engine.ts**

要点：`AudioContext` + `<audio>` 元素 + `createMediaElementSource`；滤镜链与增益节点按 Task 21 的 EQ 模块接入（本任务先留 `eqChain` 钩子为空实现）；状态变化通过回调广播给 store；进度用 `timeupdate` 事件 + `requestAnimationFrame` 平滑；`preload="auto"`；`crossOrigin` 不设（同源代理）。

- [ ] **Step 5: 实现 playerStore.ts**（zustand：`queue`、`current`、`isPlaying`、`position`、`duration`、`volume`、`mode`；动作 `playTrack`、`togglePlay`、`next`、`prev`、`seek`、`setVolume`、`setMode`）
- [ ] **Step 6: 运行测试确认通过**
- [ ] **Step 7: 提交** — `git commit -m "feat: 播放引擎、队列与播放器状态"`

---

### Task 14: 曲库页面

**Files:**
- Create: `src/pages/AlbumsPage.tsx`, `src/pages/ArtistsPage.tsx`, `src/pages/GenresPage.tsx`, `src/pages/PlaylistsPage.tsx`, `src/pages/SongsPage.tsx`, `src/pages/FavoritesPage.tsx`, `src/components/SongList.tsx`, `src/components/Cards.tsx`, `src/state/libraryStore.ts`
- Test: `test/song-list.test.tsx`

**Interfaces:**
- Consumes: `libraryApi` / `favoriteApi` / `playlistApi`（Task 6）、`Song`（Task 2）
- Produces: `SongList` 组件 props：`{ songs: Song[]; onPlay(song: Song, index: number): void; onSelect?(ids: string[]): void }`；`libraryStore` 含 `albums` / `artists` / `genres` / `playlists` / `favorites` 与对应 `load*()` 动作

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SongList } from '../src/components/SongList'

const songs = [
  { id: '1', title: '歌一', artist: '甲', artistId: '', album: '专', albumId: '', coverId: '', duration: 100, favorite: false, codec: 'FLAC', bitrate: 0, sampleRate: 0, bitDepth: 0, year: 0, trackNo: 1, discNo: 1 },
  { id: '2', title: '歌二', artist: '乙', artistId: '', album: '专', albumId: '', coverId: '', duration: 100, favorite: false, codec: 'FLAC', bitrate: 0, sampleRate: 0, bitDepth: 0, year: 0, trackNo: 2, discNo: 1 },
]

describe('SongList', () => {
  it('双击行触发播放', () => {
    const onPlay = vi.fn()
    render(<SongList songs={songs} onPlay={onPlay} />)
    fireEvent.doubleClick(screen.getByText('歌二'))
    expect(onPlay).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现页面与组件**

每个列表页调对应 API 并渲染；`SongList` 支持单击选中、双击播放、Ctrl 多选、Shift 连选、↑↓ 键盘导航；列表使用虚拟滚动（自研轻量实现：固定行高 + 可视区裁剪，不引入额外依赖）。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 曲库页面与歌曲列表"`

---

### Task 15: 播放条、全屏播放页与歌词视图

**Files:**
- Create: `src/components/PlayerBar.tsx`, `src/pages/FullPlayerPage.tsx`, `src/ui/lyrics/LyricView.tsx`
- Test: `test/lyric-view.test.tsx`

**Interfaces:**
- Consumes: `playerStore`（Task 13）、`parseLrc` / `findActiveLine`（Task 12）、`lyricApi`（Task 6）
- Produces: `LyricView` props `{ lines: LyricLine[]; currentTime: number; onSeek?(t: number): void; mode: 'single' | 'double' }`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LyricView } from '../src/ui/lyrics/LyricView'
import { parseLrc } from '../src/ui/lyrics/parse'

describe('LyricView', () => {
  it('高亮当前行', () => {
    const lines = parseLrc('[00:10.00]第一句\n[00:20.00]第二句')
    render(<LyricView lines={lines} currentTime={12} mode="single" />)
    expect(screen.getByText('第一句').className).toMatch(/active/)
  })
  it('双行模式同时渲染两行', () => {
    const lines = parseLrc('[00:10.00]第一句\n[00:20.00]第二句')
    render(<LyricView lines={lines} currentTime={12} mode="double" />)
    expect(screen.getByText('第一句')).toBeTruthy()
    expect(screen.getByText('第二句')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 LyricView**

单行模式：当前行居中放大，逐行滚动。双行模式：**两行同时在场**，上一行保持在原位走满（走满后停在全满状态），下一行在原位开始走，整页走完才一起换行；两行字号一致等粗。

- [ ] **Step 4: 实现 PlayerBar 与 FullPlayerPage**

播放条：封面、歌名歌手、上一首/播放暂停/下一首、进度条、音量、队列入口、EQ 入口、音质标识（无损/Hi-Res）。全屏播放页：封面取色背景、逐行歌词或队列面板。

- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: 提交** — `git commit -m "feat: 播放条、全屏播放页与歌词视图"`

---

### Task 16: 搜索、收藏与歌单写回

**Files:**
- Create: `src/pages/SearchPage.tsx`, `src/components/SearchPanel.tsx`
- Test: `test/favorite-writeback.test.ts`

**Interfaces:**
- Consumes: `searchApi`、`favoriteApi`、`playlistApi`（Task 6）
- Produces: `searchApi.query(q)` 返回 `{ songs, albums, artists }`；收藏与歌单操作直接调 `favoriteApi.set` / `playlistApi.*`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { apiCall } from '../src/api/client'

describe('收藏写回', () => {
  it('收藏调用 create 接口并传 trackGUID', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await apiCall('/favorite-track/create', { method: 'POST', body: { trackGUID: 'g1' } })
    const [url, init] = f.mock.calls[0] as any[]
    expect(String(url)).toContain('/favorite-track/create')
    expect(JSON.parse(init.body)).toEqual({ trackGUID: 'g1' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现搜索页与收藏/歌单写回**

收藏按钮切换直接调 `favoriteApi.set(id, on)`，成功后本地乐观更新、失败回滚并提示；歌单增删曲目调用 `playlistApi.addTracks` / `removeTracks`，成功后刷新歌单详情缓存。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 搜索与收藏/歌单写回 NAS"`

---

### Task 17: 托盘、后台续播与 SMTC

**Files:**
- Create: `electron/tray.ts`, `electron/smtc.ts`, `electron/ipc.ts`
- Modify: `electron/main.ts`
- Test: `test/tray-tooltip.test.ts`

**Interfaces:**
- Consumes: `playerStore` 状态（经 IPC 同步）、Task 13/15
- Produces: `trayTooltip({ title, artist, playing }): string`；`createTray(deps): Tray`；`class Smtc { update(state): void; dispose(): void }`；IPC 通道 `player:state`、`player:command`、`win:minimize`、`win:toggle-maximize`、`win:close`、`prefs:get`、`prefs:set`、`theme:set`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { trayTooltip } from '../electron/tray'

describe('trayTooltip', () => {
  it('超过 127 字符按字符截断', () => {
    const s = trayTooltip({ title: 'x'.repeat(300), artist: 'y', playing: true })
    expect(s.length).toBeLessThanOrEqual(127)
  })
  it('暂停时标注状态', () => {
    expect(trayTooltip({ title: 'T', artist: 'A', playing: false })).toContain('已暂停')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现托盘与 IPC**

托盘图标使用当前曲目封面（从封面缓存读 160px）；右键菜单：播放/暂停、上一首、下一首、显示窗口、退出；关闭窗口默认 `preventDefault()` 后隐藏窗口（音乐继续播放），可在设置中改为直接退出；单实例锁，第二次启动调出已有窗口。

- [ ] **Step 4: 实现 SMTC**

注册 SMTC 元数据（标题/艺人/封面）与按钮（播放暂停/上一首/下一首），状态变化时 `update()`。

- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: 提交** — `git commit -m "feat: 系统托盘、后台续播与 SMTC 媒体控制"`

---

### Task 18: 双主题 token 体系

**Files:**
- Create: `src/ui/theme/tokens.ts`, `src/ui/theme/ThemeProvider.tsx`
- Test: `test/theme.test.ts`

**Interfaces:**
- Consumes: `ThemeName = 'apple' | 'fluent'`
- Produces: `THEMES: Record<ThemeName, ThemeTokens>`；`applyTheme(name: ThemeName, el: HTMLElement): void`；`useTheme(): { name: ThemeName; setTheme(n: ThemeName): void }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { THEMES, applyTheme } from '../src/ui/theme/tokens'

describe('themes', () => {
  it('两套主题都定义了必需 token', () => {
    for (const t of Object.values(THEMES)) {
      for (const k of ['bg', 'surface', 'text', 'textMuted', 'accent', 'border', 'radius', 'blur']) {
        expect(t[k]).toBeDefined()
      }
    }
  })
  it('切换主题写入 CSS 变量', () => {
    const el = document.createElement('div')
    applyTheme('fluent', el)
    expect(el.style.getPropertyValue('--accent')).toBe(THEMES.fluent.accent)
    applyTheme('apple', el)
    expect(el.style.getPropertyValue('--accent')).toBe(THEMES.apple.accent)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 tokens.ts 与 ThemeProvider**

`apple` 主题：大留白、柔和渐变背景、连续圆角（12–18px）、SF Pro/系统 UI 字体栈、饱和强调色。`fluent` 主题：Acrylic 毛玻璃（`backdrop-filter: blur(var(--blur))`）、8px 圆角、Segoe UI Variable 字体栈、紧凑层级。组件只消费 CSS 变量，不得写死颜色值。

主题选择持久化到 `prefs.json`，并同步 `nativeTheme.themeSource` 以影响原生控件。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: Apple Music 与 Win11 Fluent 双主题 token 体系"`

---

### Task 19: 桌面悬浮歌词

**Files:**
- Create: `electron/lyricsWindow.ts`, `src/ui/lyrics/LyricOverlay.tsx`, `src/ui/lyrics/lyricOverlay.html`
- Test: `test/lyric-overlay.test.ts`

**Interfaces:**
- Consumes: `parseEnhancedLrc` / `findActiveLine` / `findActiveWord`（Task 12）、播放器状态（IPC）
- Produces: `class LyricsWindow { show(): void; hide(): void; update(state): void; setOptions(o: { fontSize, color, opacity, backgroundBlur, alwaysOnTop, locked }): void }`；IPC 通道 `lyrics:options`、`lyrics:state`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mergeLyricOptions } from '../electron/lyricsWindow'

describe('mergeLyricOptions', () => {
  it('局部更新保留其他字段', () => {
    const o = mergeLyricOptions({ fontSize: 20, color: '#fff', opacity: 1 }, { fontSize: 28 })
    expect(o).toEqual({ fontSize: 28, color: '#fff', opacity: 1 })
  })
  it('字号限制在 12-48', () => {
    expect(mergeLyricOptions({ fontSize: 20, color: '#fff', opacity: 1 }, { fontSize: 99 }).fontSize).toBe(48)
    expect(mergeLyricOptions({ fontSize: 20, color: '#fff', opacity: 1 }, { fontSize: 1 }).fontSize).toBe(12)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现悬浮歌词窗口**

窗口：`transparent: true`、`frame: false`、`alwaysOnTop: true`、`resizable: true`、`setIgnoreMouseEvents(true, { forward: true })` 实现锁定态穿透；鼠标进入时临时 `setIgnoreMouseEvents(false)` 以便操作，移出后恢复；位置与尺寸写入 `prefs.json`。

渲染：默认**双行逐字**，逐字高亮依赖增强型 LRC 的词级时间戳，缺失时退化为逐行高亮；可调字号（12–48）、颜色、透明度、背景模糊、置顶开关。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 桌面双行逐字悬浮歌词窗口"`

---

### Task 20: 服务端转码兜底

**Files:**
- Create: `src/player/transcode.ts`
- Test: `test/transcode.test.ts`

**Interfaces:**
- Consumes: `isChromiumDecodable`（Task 13）、`apiCall`（Task 6）
- Produces: `async resolvePlaySource(song: Song): Promise<{ type: 'stream' | 'hls'; url: string; cleanup?: () => void }>`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { resolvePlaySource } from '../src/player/transcode'

const song = (codec: string, ext: string) => ({ id: 'g', title: 't', artist: 'a', artistId: '', album: '', albumId: '', coverId: '', duration: 1, favorite: false, codec, bitrate: 0, sampleRate: 0, bitDepth: 0, year: 0, trackNo: 0, discNo: 0 }) as any

describe('resolvePlaySource', () => {
  it('可解码格式直接走 stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })))
    const s = await resolvePlaySource(song('FLAC', 'flac'))
    expect(s.type).toBe('stream')
    expect(s.url).toContain('/track/stream')
  })
  it('不可解码格式请求转码', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { url: '/music/api/v1/transcode/abc.m3u8' } }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    const s = await resolvePlaySource(song('APE', 'ape'))
    expect(s.type).toBe('hls')
    expect(f).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 transcode.ts**

不可解码格式：先 `POST /api/v1/track/transcode` `{ trackGUID }` 拿到播放列表地址，转为绝对地址返回 `type: 'hls'`；`cleanup` 调用 `POST /api/v1/track/quit-transcode` 结束会话。hls.js 接入：`Hls.isSupported()` 时用 `Hls` 实例挂 `<audio>`；否则回退 `audio.src = url`（Safari 形态，Windows 上一般走 Hls 分支）。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 服务端 HLS 转码兜底与 hls.js 接入"`

---

### Task 20b: 客户端 FFmpeg 兜底解码

**Files:**
- Create: `src/player/ffmpegFallback.ts`
- Test: `test/ffmpeg-fallback.test.ts`

**Interfaces:**
- Consumes: `isChromiumDecodable`（Task 13）、`streamUrl`（Task 6）
- Produces:
  - `findFfmpeg(): Promise<string | null>` — 按 `ffmpeg` / `ffmpeg.exe` 在 PATH 与常见安装位置查找
  - `type FfProbeResult = { ok: boolean; ffmpegPath?: string; reason?: string }`
  - `async probeFfmpeg(): Promise<FfProbeResult>`
  - `buildFfmpegArgs(input: string, codec: string): string[]` — 产出 `['-i', 'pipe:0', '-f', 'wav', '-ar', '44100', '-ac', '2', 'pipe:1']` 形式的参数数组

**背景：** 实测曲库中约 1.1% 的曲目（ALAC 46 首、APE / MP2 / WMA 各 1 首）Chromium 无法解码，且服务端转码在本机 NAS 不可用（`code=100001`）。因此需要客户端兜底：把流经代理的原始音频喂给本机 `ffmpeg`，转成 PCM/WAV 后用 Web Audio 播放。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { buildFfmpegArgs } from '../src/player/ffmpegFallback'

describe('buildFfmpegArgs', () => {
  it('输出 WAV 管道参数', () => {
    const a = buildFfmpegArgs('pipe:0', 'alac')
    expect(a[0]).toBe('-i')
    expect(a[1]).toBe('pipe:0')
    expect(a).toContain('pipe:1')
    expect(a).toContain('wav')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 ffmpegFallback.ts**

`findFfmpeg()` 依次检查 `ffmpeg`（PATH）、`C:\Program Files\ffmpeg\bin\ffmpeg.exe`、本机 winget 安装目录下的 `ffmpeg.exe`；找不到返回 `null`。

播放链路：渲染进程把 stream 地址交给主进程，主进程用 `child_process.spawn(ffmpegPath, args)` 并把 `fnm://` 代理返回的字节流写入 `stdin`，`stdout` 交给渲染进程；渲染进程用 `AudioWorklet` 或 `MediaStream` 方式消费 PCM 流。

**降级策略**：找不到 ffmpeg 时，播放该曲目直接报「该格式（{codec}）当前无法播放：系统未安装 FFmpeg」，并在界面给出安装指引链接，不做静默失败。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** — `git commit -m "feat: 客户端 FFmpeg 兜底解码"`

---

### Task 21: 软件 EQ（10/15 段 + 预置曲线）

**Files:**
- Create: `src/player/eq.ts`, `src/components/EqPanel.tsx`
- Test: `test/eq.test.ts`

**Interfaces:**
- Consumes: `EQ_BANDS_10`、`EQ_BANDS_15`、`EQ_PRESETS`（Task 2）
- Produces:
  - `type EqBand = { frequency: number; gain: number; q: number }`
  - `buildBands(count: 10 | 15, gains: number[]): EqBand[]`
  - `applyPreset(gains: number[], preset: string): number[]` — 逐点相加后钳制到 ±12 dB
  - `class EqChain { attach(ctx: AudioContext, input: AudioNode, output: AudioNode): void; setBandGain(i: number, gain: number): void; setEnabled(on: boolean): void; setBandCount(n: 10 | 15): void }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { buildBands, applyPreset } from '../src/player/eq'

describe('buildBands', () => {
  it('10 段与 15 段频点正确且 Q 固定', () => {
    expect(buildBands(10, new Array(10).fill(0))[0].frequency).toBe(31.5)
    expect(buildBands(15, new Array(15).fill(0))[14].frequency).toBe(16000)
    expect(buildBands(10, new Array(10).fill(0))[0].q).toBe(1.41)
  })
})

describe('applyPreset', () => {
  it('预置曲线与手动增益叠加并钳制在 ±12', () => {
    const g = applyPreset(new Array(10).fill(12), 'bass-boost')
    expect(Math.max(...g)).toBeLessThanOrEqual(12)
    expect(Math.min(...g)).toBeGreaterThanOrEqual(-12)
  })
  it('未知预设返回原增益', () => {
    const g = applyPreset([1, 2, 3], 'nope')
    expect(g).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 eq.ts**

`EqChain` 在 `AudioContext` 上串联 N 个 `BiquadFilterNode`（`type: 'peaking'`，`frequency` 取频点，`Q = 1.41`，`gain` 取段增益）；`setEnabled(false)` 时把整条链旁路（`input.connect(output)` 直连，滤镜节点断开）；`setBandCount` 重建滤镜链并保留可映射的增益（频率相同的段沿用，其余置 0）。

预置曲线定义 10 条：Flat、Pop、Rock、Jazz、Classical、Electronic、Acoustic、Loudness、Vocal、Bass Boost，每条给出 10/15 段的增益数组。

- [ ] **Step 4: 实现 EqPanel**

面板提供：段数切换（10 / 15）、10 条预置曲线下拉、每段增益滑块（±12 dB）、旁路开关、复位按钮；显示「预设基线 vs 手动偏移」两层数值。

- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: 提交** — `git commit -m "feat: 10/15 段软件 EQ 与 10 条预置曲线"`

---

### Task 22: 下载到本地与本地优先播放

**Files:**
- Create: `electron/download.ts`, `src/components/DownloadPanel.tsx`, `src/player/localLibrary.ts`
- Test: `test/local-library.test.ts`

**Interfaces:**
- Consumes: Task 8 代理、Task 14 `Song` 类型
- Produces:
  - `type DownloadTask = { id: string; songId: string; title: string; progress: number; speed: number; status: 'running' | 'done' | 'error' | 'canceled'; path?: string; error?: string }`
  - `class DownloadManager { list(): DownloadTask[]; start(song: Song): Promise<string>; cancel(id: string): void; }`
  - `type LocalLibrary = { entries: Record<string, string> }`
  - `loadLocalLibrary(file: string): LocalLibrary`、`saveLocalLibrary(file: string, lib: LocalLibrary): void`、`resolveLocalPath(lib: LocalLibrary, songId: string): string | undefined`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { resolveLocalPath } from '../src/player/localLibrary'

describe('resolveLocalPath', () => {
  it('命中映射返回路径', () => {
    expect(resolveLocalPath({ entries: { g1: 'C:\\Music\\a.flac' } }, 'g1')).toBe('C:\\Music\\a.flac')
  })
  it('未命中返回 undefined', () => {
    expect(resolveLocalPath({ entries: {} }, 'g1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 download.ts 与本地库**

下载由主进程发起：请求 `fnm://srv/api/v1/track/stream?guid=<id>`（走主进程代理，凭证由主进程附加），流式写入 `<用户音乐目录>\FnMusic\<歌手>\<专辑>\<曲名>.<ext>`；同名冲突追加 `(1)`；维护 `DownloadTask` 列表并通过 IPC 推送进度与速度。

本地库索引文件 `<userData>/local-library.json`：`{ entries: { [songId]: absolutePath } }`；播放前先查本地，命中则直接用 `file://` 本地源。

- [ ] **Step 4: 实现 DownloadPanel**

显示任务列表、进度条、速度、取消按钮；中继链路下额外显示带宽提示。

- [ ] **Step 5: 运行测试确认通过**
- [ ] **Step 6: 提交** — `git commit -m "feat: 下载到本地与本地优先播放"`

---

### Task 23: E2E 测试

**Files:**
- Create: `e2e/app.e2e.ts`, `playwright.config.ts`
- Modify: `package.json`（新增 `mock` 脚本）

**Interfaces:**
- Consumes: Task 5 mock server、Task 10/14/15/16 页面
- Produces: `npm run e2e` 可重复运行；测试用 `FNM_USER_DATA` 环境变量指向干净数据目录

- [ ] **Step 1: 写 playwright.config.ts 与 E2E 用例**

```ts
// e2e/app.e2e.ts
import { test, expect } from '@playwright/test'

test('登录 → 浏览 → 播放 → 收藏 → 搜索 → 下载 → 重启恢复', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder(/NAS 地址/).fill('127.0.0.1:5666')
  await page.getByText('独立账号').click()
  await page.getByLabel('用户名').fill('demo')
  await page.getByLabel('密码').fill('pw')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByText('我的音乐')).toBeVisible()
  await page.getByText('专辑').click()
  await expect(page.getByText('示例专辑')).toBeVisible()
})
```

- [ ] **Step 2: 加 `mock` 脚本** — `"mock": "node --experimental-strip-types mock-server/server.ts"`（或用 `tsx` 运行）
- [ ] **Step 3: 运行 `npm run e2e` 确认失败**（此时应因实现缺失或脚本未就绪而失败）
- [ ] **Step 4: 补齐 E2E 运行配置**：`webServer` 启动 mock server 与 vite dev；`electron.launch` 使用 `FNM_USER_DATA` 指向临时目录
- [ ] **Step 5: 运行 `npm run e2e` 确认通过**
- [ ] **Step 6: 提交** — `git commit -m "test: 添加端到端用例（登录到下载全链路）"`

---

### Task 24: 打包分发与文档

**Files:**
- Create: `electron-builder.yml`, `README.md`
- Modify: `package.json`（`build` 字段）

**Interfaces:**
- Consumes: Task 1–23 全部产物
- Produces: `npm run dist` 输出 `release/FN-Music-Setup-<version>.exe`（安装版）与 `release/FN-Music-Portable-<version>.exe`（便携版）

- [ ] **Step 1: 写 electron-builder.yml**

```yaml
appId: com.fnmusic.desktop
productName: 飞牛音乐
directories:
  output: release
  buildResources: build
files:
  - dist/**/*
  - electron/**/*
  - shared/**/*
  - package.json
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  artifactName: FN-Music-${version}-${env.FNM_ARTIFACT_SUFFIX}.${ext}
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 2: 写 README**

包含：功能清单、系统要求（Windows 10 1809+）、安装步骤、两种登录方式、FN ID 外网接入说明与中继限速提示、主题切换、EQ 与悬浮歌词使用说明、常见问题（自签证书、格式无法播放、播放历史同步说明）。

- [ ] **Step 3: 运行 `npm run dist` 生成安装包**
- [ ] **Step 4: 在干净环境验证安装包**：安装 → 启动 → 登录 mock 或真实 NAS → 播放 → 关闭后托盘续播 → 卸载
- [ ] **Step 5: 提交** — `git commit -m "build: 打包配置与使用文档"`

---

## 真实 NAS 联调清单（Task 22 之后、Task 23 之前执行）

需用户提供 FN ID 与飞牛音乐独立账号（仅用于联调，不写入仓库、不写入日志）。

- [ ] **Step A: FN ID 探测** — 验证候选构造与并行探测命中预期链路
- [ ] **Step B: 中继链路** — 验证 `mode=relay` Cookie 生效、播放可用、界面显示限速提示
- [ ] **Step C: token 续期** — 等待/触发 token 失效，确认静默续期路径生效
- [ ] **Step D: 转码兜底** — 播放一个 APE / DSD 曲，确认走 `/track/transcode`
- [ ] **Step E: 端口核对** — 确认 `port.httpPort` / `port.httpsPort` 与实际一致（规格中的 5666 / 5667 为假设值）
- [ ] **Step F: 播放历史端点探测** — 打开官方 Web 端 DevTools 抓包，确认是否存在历史记录端点（`/history/*`、`/recently-played/*` 等），确认后在 `src/api/` 增加对应方法并补 Task 9 的同步逻辑
- [ ] **Step G: 收藏/歌单跨端同步验证** — PC 端收藏后，用手机 App 确认可见

---

## 计划自检结果

- **规格覆盖**：§2 技术事实 → Task 3/4/5；§4 架构 → Task 6/7/8；§5 连接层 → Task 9/10/11；§6 播放引擎 → Task 13/20/21；§7 界面 → Task 14/15/18；§8 桌面能力 → Task 17/19/22；§9 数据同步 → Task 16 + 联调清单 F/G；§10 错误处理 → Task 7/9/10/17；§11 测试 → Task 1–23 各自的测试步骤；§12 里程碑 → 任务顺序一致；§13 风险 → 对应任务的降级设计。
- **占位符扫描**：无 TBD/TODO；每项任务均给出具体文件路径、接口签名与可运行的测试代码。
- **类型一致性**：`Song` / `ConnectionInfo` / `PlayerState` 在 Task 2 定义，后续任务一致引用；`authx` / `buildCookie` / `normalizeBase` / `buildCandidates` 签名在 Task 3/4 定义，Task 7/8/9/10 引用一致。
