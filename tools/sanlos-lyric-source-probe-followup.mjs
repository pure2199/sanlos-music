// T90-② 补测：把首轮探针里的三个「说不清」分清楚
//  ① 网易云旧接口：样本歌返回空歌词 ⇒ 是「这歌没词」还是「接口整体不行」？
//  ② QQ 旧端点 404 ⇒ 换第二个 songmid 复测（排除个例）
//  ③ 酷我 mobi.s 响应到底长什么样（`TP=content…`）
//  ④ 咪咕 resourceinfo 参数用错 ⇒ 直接用搜索结果里的歌词 URL
import fs from 'node:fs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const OUT = 'release/verify/t90-02b-probe-followup.json'
const out = { task: 'T90-② 补测', at: new Date().toISOString(), findings: {} }

async function get(url, init = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
    const text = await res.text()
    return { status: res.status, ok: res.ok, ms: Date.now() - t0, text }
  } catch (e) {
    return { status: 0, ok: false, ms: Date.now() - t0, text: '', error: e.message }
  }
}

function looksLikeLrc(t) {
  return /\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(t)
}

// ---------------------------------------------------------------------------
// ① 网易云：多首歌 + 多组参数
// ---------------------------------------------------------------------------
{
  const samples = ['一路向北 周杰伦', '稻香 周杰伦', '孤勇者 陈奕迅', '海阔天空 Beyond']
  const rows = []
  for (const keyword of samples) {
    const s = await get(
      'https://music.163.com/api/search/get/web?csrf_token=&type=1&offset=0&total=true&limit=5&s=' +
        encodeURIComponent(keyword),
      { headers: { accept: 'application/json', 'user-agent': UA } },
    )
    let songs = []
    try {
      songs = JSON.parse(s.text)?.result?.songs ?? []
    } catch {}
    const perSong = []
    for (const song of songs.slice(0, 3)) {
      const l = await get(
        `https://music.163.com/api/song/lyric?id=${encodeURIComponent(song.id)}&lv=1&kv=1&tv=-1&yv=-1&rv=-1`,
        { headers: { accept: 'application/json', 'user-agent': UA } },
      )
      let j = null
      try {
        j = JSON.parse(l.text)
      } catch {}
      perSong.push({
        id: song.id,
        name: song.name,
        status: l.status,
        ms: l.ms,
        keys: j ? Object.keys(j) : null,
        lrcLen: j?.lrc?.lyric?.length ?? null,
        tlyricLen: j?.tlyric?.lyric?.length ?? null,
        romalrcLen: j?.romalrc?.lyric?.length ?? null,
        yrcLen: j?.yrc?.lyric?.length ?? null,
        ytlrcLen: j?.ytlrc?.lyric?.length ?? null,
        yromalrcLen: j?.yromalrc?.lyric?.length ?? null,
      })
    }
    rows.push({ keyword, searchStatus: s.status, searchMs: s.ms, songCount: songs.length, perSong })
  }
  out.findings.netease = rows
}

// ---------------------------------------------------------------------------
// ② QQ 旧端点：换 songmid 复测 + 试几个候选端点
// ---------------------------------------------------------------------------
{
  const mids = ['001xd0HI0X9GNq']
  // 再搜一首拿第二个 songmid
  const s = await get(
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=' +
      encodeURIComponent('孤勇者 陈奕迅') +
      '&format=json',
    { headers: { referer: 'https://y.qq.com/', 'user-agent': UA } },
  )
  try {
    const list = JSON.parse(s.text)?.data?.song?.list ?? []
    if (list[0]?.songmid) mids.push(list[0].songmid)
  } catch {}

  const endpoints = [
    ['c.y.qq.com/lyric/fcg_query_lyric_new.fcg(生产在用)', 'https://c.y.qq.com/lyric/fcg_query_lyric_new.fcg'],
    ['u.y.qq.com/lyric/fcg_query_lyric_new.fcg', 'https://u.y.qq.com/lyric/fcg_query_lyric_new.fcg'],
    ['c.y.qq.com/lyric/fcg_query_lyric_new.fcg(noformat)', 'https://c.y.qq.com/lyric/fcg_query_lyric_new.fcg'],
  ]
  const rows = []
  for (const mid of mids) {
    for (const [label, base] of endpoints) {
      const sep = base.includes('?') ? '&' : '?'
      const url = `${base}${sep}songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&platform=yqq`
      const l = await get(url, { headers: { referer: 'https://y.qq.com/', 'user-agent': UA } })
      let j = null
      try {
        j = JSON.parse(l.text)
      } catch {}
      rows.push({
        mid,
        endpoint: label,
        status: l.status,
        ms: l.ms,
        bytes: l.text.length,
        code: j?.code ?? null,
        lyricLen: typeof j?.lyric === 'string' ? j.lyric.length : null,
        bodyHead: l.text.slice(0, 80),
      })
    }
  }
  out.findings.qqLegacyEndpoints = rows
}

// ---------------------------------------------------------------------------
// ③ 酷我：看响应体原形
// ---------------------------------------------------------------------------
{
  const s = await get(
    'http://search.kuwo.cn/r.s?client=kt&all=' +
      encodeURIComponent('一路向北 周杰伦') +
      '&pn=0&rn=5&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1',
    { headers: { 'user-agent': UA, referer: 'https://www.kuwo.cn/' } },
  )
  let rid = null
  try {
    const first = JSON.parse(s.text)?.abslist?.[0]
    rid = first?.MUSICRID ? String(first.MUSICRID).replace('MUSIC_', '') : null
  } catch {}
  const rows = []
  for (const lrcx of [1, 0]) {
    if (!rid) break
    const l = await get(
      `http://mlyric.kuwo.cn/mobi.s?f=web&type=lyric&lrcx=${lrcx}&rid=${encodeURIComponent(rid)}&encode=utf8`,
      { headers: { 'user-agent': UA, referer: 'https://www.kuwo.cn/' } },
    )
    rows.push({
      lrcx,
      status: l.status,
      ms: l.ms,
      bytes: l.text.length,
      looksLikePlainLrc: looksLikeLrc(l.text),
      head: l.text.slice(0, 200),
      tail: l.text.slice(-120),
    })
  }
  out.findings.kuwoRaw = { rid, rows }
}

// ---------------------------------------------------------------------------
// ④ 咪咕：直接用搜索结果里的歌词 URL（不经 resourceinfo）
// ---------------------------------------------------------------------------
{
  const { createHash } = await import('node:crypto')
  const md5 = (t) => createHash('md5').update(t).digest('hex')
  const keyword = '一路向北 周杰伦'
  const time = Date.now().toString()
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73'
  const sign = md5(
    `${keyword}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`,
  )
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
  const candidate = first
    ? {
        songId: first.songId,
        copyrightId: first.copyrightId,
        name: first.name,
        singerList: first.singerList?.slice?.(0, 3)?.map?.((x) => x.name) ?? null,
        duration: first.duration,
        lrcUrl: first.lrcUrl ?? null,
        mrcurl: first.mrcurl ?? null,
        trcUrl: first.trcUrl ?? null,
        allKeys: Object.keys(first),
      }
    : null

  const lyrics = []
  for (const [label, url] of [
    ['mrcurl(逐字)', first?.mrcurl],
    ['lrcUrl(行级)', first?.lrcUrl],
    ['trcUrl(翻译)', first?.trcUrl],
  ]) {
    if (!url) {
      lyrics.push({ label, skipped: 'URL 缺失' })
      continue
    }
    const l = await get(url, {
      headers: { referer: 'https://app.c.nf.migu.cn/', 'user-agent': UA, channel: '0146921' },
    })
    lyrics.push({
      label,
      url: String(url).slice(0, 120),
      status: l.status,
      ms: l.ms,
      bytes: l.text.length,
      looksLikePlainLrc: looksLikeLrc(l.text),
      head: l.text.slice(0, 160),
    })
  }

  // resourceinfo：分别用 songId 与 copyrightId 各试一次
  const infoRows = []
  for (const [label, id] of [
    ['songId', candidate?.songId],
    ['copyrightId', candidate?.copyrightId],
  ]) {
    if (!id) {
      infoRows.push({ label, skipped: 'ID 缺失' })
      continue
    }
    const l = await get(
      'https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `resourceId=${encodeURIComponent(String(id))}`,
      },
    )
    let j = null
    try {
      j = JSON.parse(l.text)
    } catch {}
    infoRows.push({
      label,
      idValue: String(id).slice(0, 40),
      status: l.status,
      ms: l.ms,
      bytes: l.text.length,
      code: j?.code ?? null,
      resourceCount: Array.isArray(j?.resource) ? j.resource.length : null,
      resourceKeys: Array.isArray(j?.resource) && j.resource[0] ? Object.keys(j.resource[0]).slice(0, 25) : null,
      raw: l.text.slice(0, 200),
    })
  }

  out.findings.migu = { candidate, lyrics, infoRows }
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(out, null, 2).slice(0, 12000))
console.log(`\n证据已写入 ${OUT}`)
