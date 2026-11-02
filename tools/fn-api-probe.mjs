#!/usr/bin/env node
/**
 * 飞牛音乐 API 深度探测（联调用）：登录后验证播放链路所需的真实端点行为。
 *
 * 用法:
 *   FN_USER=xxx FN_PASS=xxx node tools/fn-api-probe.mjs --fnid <FNID>
 *
 * 覆盖：曲库结构 / 封面 / 歌词 / 音频流（Range、Content-Type）/ 服务端转码 / 播放历史端点猜测
 * 凭据只从环境变量读取，不落盘、不打印。
 */
import { createHash } from 'node:crypto'

const SIGN_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh'
const MUSIC_SIGN_KEY = '6D5602D4-A342-4799-A0F0-BB795E7167D0'
const FN_SIGN_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c'
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
function authx(method, url, body, key) {
  const n = nonce()
  const t = ts()
  const payload =
    method.toUpperCase() === 'GET'
      ? md5(
          (() => {
            const u = new URL(url, 'http://local')
            const sorted = new URLSearchParams()
            for (const k of [...new Set(u.searchParams.keys())].sort()) {
              for (const v of u.searchParams.getAll(k)) {
                if (v !== 'undefined' && v !== 'null') sorted.append(k, v)
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
  return `nonce=${n}&timestamp=${t}&sign=${md5([SIGN_PREFIX, pathnameOf(url), n, t, payload, key].join('_'))}`
}

const args = process.argv.slice(2)
const getArg = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const fnId = getArg('fnid')
const user = process.env.FN_USER
const pass = process.env.FN_PASS
if (!fnId || !user || !pass) {
  console.error('用法: FN_USER=xxx FN_PASS=xxx node tools/fn-api-probe.mjs --fnid <FNID>')
  process.exit(1)
}

async function main() {
  // 1. 解析链路
  const conBody = JSON.stringify({ fnId })
  const conRes = await fetch(FN_CON_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authx: authx('POST', '/api/v1/fn/con', conBody, FN_SIGN_KEY) },
    body: conBody,
    signal: AbortSignal.timeout(15000),
  })
  const con = await conRes.json()
  const relay = (con.data?.fn?.[0] ?? `${fnId}.fnos.net:443`).replace(/:\d+$/, '')
  const base = `https://${relay}`
  const isRelay = true
  console.log(`链路: ${base} (中继)`)

  // 2. 登录（中继链路下，登录请求同样必须带 mode=relay，否则中继不识别该请求）
  const deviceId = createHash('sha256').update(`${user}:${Date.now()}`).digest('hex').slice(0, 32)
  const loginBody = JSON.stringify({ username: user, password: sha256(pass), deviceId })
  const loginRes = await fetch(`${base}/music/api/v1/user/password-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/music/api/v1/user/password-login', loginBody, MUSIC_SIGN_KEY),
      cookie: isRelay ? 'mode=relay' : '',
    },
    body: loginBody,
    signal: AbortSignal.timeout(15000),
  })
  const loginText = await loginRes.text()
  let login = null
  try {
    login = JSON.parse(loginText)
  } catch {
    console.error(`登录返回非 JSON (HTTP ${loginRes.status}): ${loginText.slice(0, 300)}`)
    process.exit(1)
  }
  if (login.code !== 0) throw new Error(`登录失败 code=${login.code} msg=${login.msg}`)
  const token = login.data.userToken
  console.log(`登录成功 (${login.data.user?.username ?? '?'})`)

  const cookie = isRelay ? `music-token=${token}; mode=relay` : `music-token=${token}`
  const get = async (path) => {
    const url = `${base}${path}`
    const res = await fetch(url, {
      headers: { authx: authx('GET', url, undefined, MUSIC_SIGN_KEY), cookie },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  const post = async (path, body) => {
    const url = `${base}${path}`
    const raw = JSON.stringify(body)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authx: authx('POST', url, raw, MUSIC_SIGN_KEY), cookie },
      body: raw,
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text }
  }

  // 3. 取一首真实歌曲
  const tracks = await get('/music/api/v1/track/list?page=1&size=3')
  const list = tracks.json?.data?.list ?? []
  const song = list[0]
  console.log(`\n=== 曲库结构（第一首） ===`)
  console.log(JSON.stringify(song, null, 2).slice(0, 1200))
  const guid = song?.guid
  const coverId = song?.coverId

  // 4. 分页能力验证
  console.log(`\n=== 分页 ===`)
  for (const p of [1, 100, 1000]) {
    const r = await get(`/music/api/v1/track/list?page=${p}&size=500`)
    const d = r.json?.data
    console.log(`page=${p} size=500 -> 返回 ${d?.list?.length ?? '?'} 条 total=${d?.total ?? '?'} 首项=${d?.list?.[0]?.title ?? '-'}`)
  }
  const big = await get('/music/api/v1/track/list?page=1&size=2000')
  console.log(`size=2000 -> 返回 ${big.json?.data?.list?.length ?? '?'} 条（服务端上限探测）`)

  // 5. 封面
  console.log(`\n=== 封面 ===`)
  if (coverId) {
    for (const size of [160, 600]) {
      const url = `${base}/music/api/v1/static/cover?coverId=${encodeURIComponent(coverId)}&size=${size}`
      const res = await fetch(url, {
        headers: { authx: authx('GET', url, undefined, MUSIC_SIGN_KEY), cookie },
        signal: AbortSignal.timeout(20000),
      })
      const buf = Buffer.from(await res.arrayBuffer())
      console.log(`size=${size} HTTP ${res.status} type=${res.headers.get('content-type')} bytes=${buf.length}`)
    }
  } else {
    console.log('该歌曲无 coverId')
  }

  // 6. 歌词
  console.log(`\n=== 歌词 ===`)
  const ly = await get(`/music/api/v1/lyric/list?trackGUID=${encodeURIComponent(guid)}`)
  const lyList = ly.json?.data?.list ?? []
  console.log(`code=${ly.json?.code} 条目=${lyList.length}`)
  if (lyList[0]?.content) {
    const c = String(lyList[0].content)
    console.log('前 200 字符:', JSON.stringify(c.slice(0, 200)))
    console.log('含逐字标签(<):', c.includes('<') ? '是' : '否（仅行级）')
  }

  // 7. 音频流
  console.log(`\n=== 音频流 ===`)
  const streamUrl = `${base}/music/api/v1/track/stream?guid=${encodeURIComponent(guid)}`
  const st = await fetch(streamUrl, {
    headers: { authx: authx('GET', streamUrl, undefined, MUSIC_SIGN_KEY), cookie, range: 'bytes=0-65535' },
    signal: AbortSignal.timeout(30000),
  })
  const chunk = Buffer.from(await st.arrayBuffer())
  console.log(`HTTP ${st.status} type=${st.headers.get('content-type')} accept-ranges=${st.headers.get('accept-ranges')} content-length=${st.headers.get('content-length')} 实收=${chunk.length} 字节`)
  console.log(`前 4 字节: ${chunk.subarray(0, 4).toString('hex')}（fLaC=FLAC / ID3=MP3 / RIFF=WAV）`)
  const audioSpec = song?.audioSpec
  if (audioSpec) console.log('audioSpec:', JSON.stringify(audioSpec))

  // 8. 播放历史端点猜测
  console.log(`\n=== 播放历史端点探测 ===`)
  const historyCandidates = [
    '/music/api/v1/history/list',
    '/music/api/v1/recently-play/list',
    '/music/api/v1/recent-play/list',
    '/music/api/v1/play-history/list',
    '/music/api/v1/track/history/list',
    '/music/api/v1/user/history/list',
    '/music/api/v1/history-track/list',
    '/music/api/v1/play-record/list',
  ]
  for (const c of historyCandidates) {
    const r = await get(c)
    const code = r.json?.code
    const is404 = r.status === 404
    console.log(`${c.padEnd(40)} HTTP ${r.status} code=${code ?? '-'} ${is404 ? '(不存在)' : r.json?.data ? `命中 data=${JSON.stringify(r.json.data).slice(0, 120)}` : ''}`)
  }

  // 9. 转码接口
  console.log(`\n=== 服务端转码 ===`)
  for (const p of ['/music/api/v1/track/transcode', '/music/api/v1/transcode']) {
    const r = await post(p, { trackGUID: guid })
    console.log(`${p.padEnd(34)} HTTP ${r.status} code=${r.json?.code ?? '-'} msg=${r.json?.msg ?? '-'} data=${JSON.stringify(r.json?.data ?? r.text).slice(0, 200)}`)
    if (r.json?.code === 0 && r.json?.data) {
      const quit = await post('/music/api/v1/track/quit-transcode', { trackGUID: guid })
      console.log(`  quit-transcode -> code=${quit.json?.code}`)
      break
    }
  }

  // 10. 搜索
  console.log(`\n=== 搜索 ===`)
  const q = encodeURIComponent(String(song?.title ?? '').slice(0, 4))
  for (const p of ['/music/api/v1/search/track', '/music/api/v1/search/album', '/music/api/v1/search/artist']) {
    const r = await get(`${p}?q=${q}&page=1&size=5`)
    console.log(`${p.padEnd(34)} code=${r.json?.code} 返回=${r.json?.data?.list?.length ?? '?'} 条`)
  }

  // 11. 风格与歌单详情
  console.log(`\n=== 风格 / 歌单 ===`)
  const genres = await get('/music/api/v1/genre/list?page=1&size=3')
  console.log('风格样本:', JSON.stringify(genres.json?.data?.list?.slice(0, 2)).slice(0, 400))
  const pl = await get('/music/api/v1/playlist/list?page=1&size=3')
  console.log('歌单样本:', JSON.stringify(pl.json?.data?.list?.slice(0, 2)).slice(0, 400))

  // 12. 第二条歌词条目（可能是逐字版）
  console.log(`\n=== 歌词条目明细 ===`)
  lyList.forEach((e, i) => {
    const c = String(e.content ?? '')
    console.log(`条目${i}: keys=${Object.keys(e).join(',')} 长度=${c.length} 含逐字标签=${c.includes('<') ? '是' : '否'}`)
    console.log(`  片段: ${JSON.stringify(c.slice(0, 160))}`)
  })

  // 13. 播放历史分页参数
  console.log(`\n=== 播放历史分页 ===`)
  for (const q of ['', '?page=1&size=5', '?page=2&size=5']) {
    const r = await get(`/music/api/v1/play-history/list${q}`)
    const d = r.json?.data
    console.log(`list${q.padEnd(16)} code=${r.json?.code} 返回=${d?.list?.length ?? '?'} total=${d?.total ?? '-'}`)
  }

  // 14. 找出非 FLAC 曲目并测试转码
  console.log(`\n=== 转码（寻找非 FLAC 曲目） ===`)
  const scan = await get('/music/api/v1/track/list?page=1&size=500')
  const all = scan.json?.data?.list ?? []
  const codecs = [...new Set(all.map((t) => t?.audioSpec?.codec).filter(Boolean))]
  console.log('本页出现的 codec:', codecs.join(', '))
  const nonFlac = all.find((t) => t?.audioSpec?.codec && !['flac', 'mp3', 'wav', 'aac'].includes(String(t.audioSpec.codec).toLowerCase()))
  if (nonFlac) {
    console.log(`选中的非 FLAC 曲目: ${nonFlac.title} (${nonFlac.audioSpec.codec} ${nonFlac.audioSpec.format})`)
    const tr = await post('/music/api/v1/track/transcode', { trackGUID: nonFlac.guid })
    console.log(`transcode -> HTTP ${tr.status} code=${tr.json?.code ?? '-'} msg=${tr.json?.msg ?? '-'} data=${JSON.stringify(tr.json?.data ?? tr.text).slice(0, 300)}`)
    if (tr.json?.code === 0) {
      const quit = await post('/music/api/v1/track/quit-transcode', { trackGUID: nonFlac.guid })
      console.log(`quit-transcode -> code=${quit.json?.code} msg=${quit.json?.msg ?? ''}`)
    }
  } else {
    console.log('本页未出现非 FLAC 曲目，跳过转码实测')
    const tr = await post('/music/api/v1/track/transcode', { trackGUID: guid })
    console.log(`（对 FLAC 调用）transcode -> code=${tr.json?.code} msg=${tr.json?.msg ?? '-'}`)
  }

  // 15. 收藏列表结构
  console.log(`\n=== 收藏列表结构 ===`)
  const fav = await get('/music/api/v1/favorite-track/list?page=1&size=2')
  console.log(JSON.stringify(fav.json?.data?.list?.[0] ?? fav.json?.data).slice(0, 500))
}

main().catch((e) => {
  console.error('探测失败:', e)
  process.exit(1)
})
