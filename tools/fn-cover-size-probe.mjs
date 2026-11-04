// 真机联调校准：Step K —— **封面 `size` 参数的取值语义**（T17）。
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// 客户端拼封面的地方**只有一处**（`src/components/coverUrl.ts` 的 `COVER_SIZE_DEFAULT`，
// 当前值 200），联调清单 Step K 要求校准它：
//   - 服务端是否真的按 `size` 返回对应边长的图？
//   - 允许多大 / 多小？非法值会怎样？
//   - 不传 `size` 时给什么尺寸？
//
// 顺带确认「封面主色提取的采样策略」——客户端目前**没有**做主色提取
// （卡片封面是 `<img>` 直接显示，没有背景取色逻辑），
// 所以这一项在本版本**无对应实现**，这里只记录服务端事实。
//
// 覆盖度：每个尺寸都取**同一张**封面（曲库里第一张有封面的专辑），否则尺寸不可比。
//
// 凭证只从环境变量读，不打印、不落盘。
//
// 用法：FN_USER=... FN_PASS=... FN_ID=... node tools/fn-cover-size-probe.mjs
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'

const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'
const FN_SIGN_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c'
const MUSIC_SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'
const FN_CON_API = 'https://5ddd.com/api/v1/fn/con'

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const nonce = () => String(Math.floor(Math.random() * 9e5) + 1e5)
const ts = () => String(Date.now())
const pathnameOf = (u) => {
  try {
    return new URL(u).pathname
  } catch {
    return new URL(u, 'http://local').pathname
  }
}

function authx(method, url, body, key, nonceV, tsV) {
  const payload =
    method.toUpperCase() === 'GET'
      ? md5(
          (() => {
            const u = new URL(url, 'http://local')
            const sorted = new URLSearchParams()
            for (const k of [...new Set(u.searchParams.keys())].sort()) {
              for (const v of u.searchParams.getAll(k)) {
                if (v !== 'undefined' && v !== 'null') sorted.append(v === '' ? k : k, v)
              }
            }
            const enc = sorted.toString().replace(/\+/g, '%20')
            try {
              return decodeURIComponent(enc.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'))
            } catch {
              return enc
            }
          })(),
        )
      : md5(body ?? '')
  const sign = md5([SIGN_PREFIX, pathnameOf(url), nonceV, tsV, payload, key].join('_'))
  return `nonce=${nonceV}&timestamp=${tsV}&sign=${sign}`
}

const fnId = process.env.FN_ID ?? ''
const user = process.env.FN_USER ?? ''
const pass = process.env.FN_PASS ?? ''
if (!fnId || !user || !pass) {
  console.error('需要 FN_ID / FN_USER / FN_PASS 环境变量。')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 连通 + 登录（走中继）
// ---------------------------------------------------------------------------

async function pickRelay() {
  const body = JSON.stringify({ fnId })
  const res = await fetch(FN_CON_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/api/v1/fn/con', body, FN_SIGN_KEY, nonce(), ts()),
    },
    body,
    signal: AbortSignal.timeout(15000),
  })
  const json = await res.json()
  const relays = json?.data?.fn?.length ? json.data.fn : [`${fnId}.fnos.net:443`]
  for (const r of relays) {
    const address = `https://${String(r).replace(/:\d+$/, '')}`
    try {
      const probe = await fetch(`${address}/music/api/v1/health`, {
        headers: { cookie: 'mode=relay' },
        signal: AbortSignal.timeout(10000),
      })
      if (probe.status < 400) return address
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const base = await pickRelay()
if (!base) {
  console.error('找不到可达的中继链路。')
  process.exit(1)
}

/** 带签名与凭证的业务请求（`cookie` 在登录后才有值）。 */
let cookie = ''

async function call(path, method = 'GET', body) {
  const url = `${base}${path}`
  const bodyString = body === undefined ? undefined : JSON.stringify(body)
  const res = await fetch(url, {
    method,
    headers: {
      ...(bodyString ? { 'content-type': 'application/json' } : {}),
      authx: authx(method, url, bodyString, MUSIC_SIGN_KEY, nonce(), ts()),
      cookie,
    },
    body: bodyString,
    signal: AbortSignal.timeout(20000),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** 登录拿 token。 */
async function login() {
  const url = `${base}/music/api/v1/user/password-login`
  const bodyString = JSON.stringify({
    username: user,
    password: sha256(pass),
    deviceId: 'coverprobe001',
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', url, bodyString, MUSIC_SIGN_KEY, nonce(), ts()),
      cookie: 'mode=relay',
    },
    body: bodyString,
    signal: AbortSignal.timeout(20000),
  })
  const json = await res.json().catch(() => null)
  if (json?.code !== 0) throw new Error(`登录失败：code=${json?.code} msg=${json?.msg ?? ''}`)
  return json.data?.userToken ?? ''
}

const token = await login()
cookie = `music-token=${token}; mode=relay`

/** 带 token 取封面原始字节。 */
async function fetchCover(coverId, size) {
  const qs = size === undefined ? `coverId=${encodeURIComponent(coverId)}` : `coverId=${encodeURIComponent(coverId)}&size=${size}`
  const url = `${base}/music/api/v1/static/cover?${qs}`
  const res = await fetch(url, {
    headers: {
      authx: authx('GET', url, undefined, MUSIC_SIGN_KEY, nonce(), ts()),
      cookie,
    },
    signal: AbortSignal.timeout(30000),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, type: res.headers.get('content-type'), bytes: buf, buf }
}

// ---------------------------------------------------------------------------
// 图像尺寸解析（PNG / JPEG / WebP / GIF）
// ---------------------------------------------------------------------------

/** 从图片字节里读出宽高（认不出就返回 null）。 */
function imageSize(buf) {
  // PNG
  if (buf.length > 24 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), fmt: 'png' }
  }
  // GIF
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), fmt: 'gif' }
  }
  // WebP
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16)
    if (kind === 'VP8 ' && buf.length > 30) {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, fmt: 'webp' }
    }
    if (kind === 'VP8L' && buf.length > 25) {
      const b = buf.readUInt32LE(21)
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, fmt: 'webp' }
    }
    if (kind === 'VP8X' && buf.length > 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { w, h, fmt: 'webp' }
    }
  }
  // JPEG：扫 SOF 段
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off += 1
        continue
      }
      const marker = buf[off + 1]
      const len = buf.readUInt16BE(off + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7), fmt: 'jpeg' }
      }
      off += 2 + len
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 找一张有封面的专辑
// ---------------------------------------------------------------------------

const albums = await call('/music/api/v1/album/list?page=1&size=20')
const list = albums.json?.data?.list ?? []
const withCover = list.find((a) => typeof a.coverId === 'string' && a.coverId.includes('_'))
if (!withCover) {
  console.error('这一页没有带封面的专辑，换个账号或稍后再试。')
  process.exit(1)
}
const coverId = withCover.coverId
console.log(`\n─── Step K：封面 size 参数 ───\n`)
console.log(`样本封面：${coverId}`)

const sizes = [undefined, 32, 64, 100, 128, 150, 200, 240, 256, 300, 320, 400, 480, 512, 640, 800, 1024, 0, -1, 99999]
console.log('\n尺寸参数        HTTP  类型          字节     实际宽×高')
console.log('─'.repeat(62))
for (const size of sizes) {
  const r = await fetchCover(coverId, size)
  const dim = imageSize(r.buf)
  const label = size === undefined ? '(不传)' : String(size)
  console.log(
    `${label.padEnd(14)}  ${String(r.status).padEnd(5)} ${(r.type ?? '-').padEnd(15)} ${String(r.bytes.length).padEnd(8)} ${dim ? `${dim.w}×${dim.h} (${dim.fmt})` : '(非图片 / 解析不出)'}`,
  )
}

// 覆盖率：拿一张**小图**和一张**大图**比字节数，确认 size 真的影响体积。
const small = await fetchCover(coverId, 200)
const large = await fetchCover(coverId, 640)
console.log(
  `\n体积对比：size=200 → ${small.bytes.length} 字节；size=640 → ${large.bytes.length} 字节；` +
    `服务端${large.bytes.length > small.bytes.length ? '**确实按 size 缩放**' : '**似乎忽略 size**'}`,
)

console.log(
  '\n关于「封面主色取色」：本版本客户端**没有**主色提取实现（卡片直接用 <img> 显示封面），' +
    '故 Step K 的取色子项无对应代码可校准。',
)
