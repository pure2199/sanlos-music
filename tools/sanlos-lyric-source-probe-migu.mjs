// T90-② 补测二：咪咕 resourceinfo（用 songId 才有效）里到底有哪些歌词 URL
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

async function get(url, init = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
    const text = await res.text()
    return { status: res.status, ms: Date.now() - t0, text }
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: '', error: e.message }
  }
}

function looksLikeLrc(t) {
  return /\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(t)
}

const out = { task: 'T90-② 补测二（咪咕）', at: new Date().toISOString() }

// 1) 搜索
const keyword = '孤勇者 陈奕迅'
const time = Date.now().toString()
const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73'
const sign = createHash('md5')
  .update(`${keyword}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`)
  .digest('hex')
const switchParam = encodeURIComponent(
  '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}',
)
const s = await get(
  `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=${switchParam}&pageSize=10&text=${encodeURIComponent(
    keyword,
  )}&pageNo=1&sort=0&sid=USS`,
  {
    headers: {
      uiVersion: 'A_music_3.6.1',
      deviceId,
      timestamp: time,
      sign,
      channel: '0146921',
      'user-agent':
        'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
    },
  },
)
let first = null
try {
  const groups = JSON.parse(s.text)?.songResultData?.resultList ?? []
  for (const g of groups) for (const item of g) if (item?.songId) { first = item; break }
} catch {}
out.search = {
  status: s.status,
  ms: s.ms,
  songId: first?.songId ?? null,
  copyrightId: first?.copyrightId ?? null,
  name: first?.name ?? null,
  lrcUrlInSearch: first?.lrcUrl ?? null,
  mrcurlInSearch: first?.mrcurl ?? null,
  trcUrlInSearch: first?.trcUrl ?? null,
}

// 2) resourceinfo（songId）
const info = await get(
  'https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2',
  {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: `resourceId=${encodeURIComponent(String(first?.songId ?? ''))}`,
  },
)
let resource = null
try {
  resource = JSON.parse(info.text)?.resource?.[0] ?? null
} catch {}
out.resourceinfo = {
  status: info.status,
  ms: info.ms,
  bytes: info.text.length,
  keys: resource ? Object.keys(resource) : null,
  songId: resource?.songId ?? null,
  songName: resource?.songName ?? null,
  length: resource?.length ?? null,
  lrcUrl: resource?.lrcUrl ?? null,
  mrcUrl: resource?.mrcUrl ?? null,
  trcUrl: resource?.trcUrl ?? null,
}

// 3) 三个歌词 URL
out.lyrics = []
for (const [label, url] of [
  ['lrcUrl(行级)', resource?.lrcUrl],
  ['mrcUrl(逐字)', resource?.mrcUrl],
  ['trcUrl(翻译)', resource?.trcUrl],
]) {
  if (!url) {
    out.lyrics.push({ label, skipped: 'URL 缺失' })
    continue
  }
  const l = await get(String(url), {
    headers: { referer: 'https://app.c.nf.migu.cn/', 'user-agent': UA, channel: '0146921' },
  })
  out.lyrics.push({
    label,
    url: String(url).slice(0, 140),
    status: l.status,
    ms: l.ms,
    bytes: l.text.length,
    looksLikePlainLrc: looksLikeLrc(l.text),
    head: l.text.slice(0, 200),
  })
}

fs.writeFileSync('release/verify/t90-02c-probe-migu-detail.json', JSON.stringify(out, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(out, null, 2))
