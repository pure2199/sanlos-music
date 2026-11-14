// T90-②：五个歌词源接口探针（只验活，不解密内容）
//
// 目的：洛雪的这些实现是几年前的（酷狗/酷我走的还是 http 明文接口）
//       ⇒ 必须先确认「今天还活着吗」，再决定要不要照着写生产代码。
//
// 产出：release/verify/t90-02-lyric-source-probe.json（证据）
//
// 纪律：
// - **不解密任何歌词内容**（QQ qrc / 酷狗 krc / 酷我 / 咪咕 mrc 一律只看形状）；
// - 每一步都记 URL / 状态码 / 延迟 / 顶层字段 / 正文长度 / 短样本；
// - 明文端点（http://）单独标注 —— 我们的出网栈走 Chromium 分区，http 是否可行要实测。
//
// 用法：node release/verify/t90-02-probe-lyric-sources.mjs

import fs from 'node:fs'
import { createHash } from 'node:crypto'

const OUT = 'release/verify/t90-02-lyric-source-probe.json'
const KEYWORD = '一路向北 周杰伦'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function topKeys(value) {
  if (Array.isArray(value)) return [`<array:${value.length}>`]
  if (isPlainObject(value)) return Object.keys(value)
  return [`<${typeof value}>`]
}

function pick(obj, keys) {
  if (!isPlainObject(obj)) return null
  const out = {}
  for (const key of keys) {
    if (!(key in obj)) continue
    const v = obj[key]
    if (typeof v === 'string') out[key] = { type: 'string', length: v.length, sample: v.slice(0, 60) }
    else if (typeof v === 'number') out[key] = { type: 'number', value: v }
    else if (typeof v === 'boolean') out[key] = { type: 'boolean', value: v }
    else if (v === null) out[key] = { type: 'null' }
    else if (Array.isArray(v)) out[key] = { type: 'array', length: v.length }
    else out[key] = { type: 'object', keys: Object.keys(v).slice(0, 20) }
  }
  return out
}

function looksLikeLrc(text) {
  return /\[\d{1,3}:\d{1,2}([.:]\d{1,3})?\]/.test(text)
}

function md5(text) {
  return createHash('md5').update(text).digest('hex')
}

/** 一步请求；永不抛。 */
async function step(name, url, init = {}) {
  const t0 = Date.now()
  const record = { name, url, method: init.method ?? 'GET' }
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const text = await res.text()
    record.status = res.status
    record.ok = res.ok
    record.ms = Date.now() - t0
    record.contentType = res.headers.get('content-type')
    record.bodyBytes = Buffer.byteLength(text, 'utf8')
    record.body = text
    return record
  } catch (cause) {
    record.status = 0
    record.ok = false
    record.ms = Date.now() - t0
    record.error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
    record.body = ''
    return record
  }
}

function parseJson(record) {
  if (!record.body) return null
  try {
    return JSON.parse(record.body)
  } catch {
    return null
  }
}

/** 把一步压成「证据摘要」（不留正文）。 */
function summarize(record, shape) {
  const out = {
    name: record.name,
    method: record.method,
    status: record.status,
    ok: record.ok,
    ms: record.ms,
    contentType: record.contentType ?? null,
    bodyBytes: record.bodyBytes ?? 0,
  }
  if (record.error) out.error = record.error
  if (shape) out.shape = shape
  return out
}

// ---------------------------------------------------------------------------
// ① 网易云
// ---------------------------------------------------------------------------

async function probeNetease() {
  const steps = []
  const notes = []
  const searchUrl =
    'https://music.163.com/api/search/get/web?csrf_token=&type=1&offset=0&total=true&limit=10&s=' +
    encodeURIComponent(KEYWORD)
  const s1 = await step('netease.search', searchUrl, {
    headers: { accept: 'application/json', 'user-agent': UA },
  })
  const sJson = parseJson(s1)
  const songs = isPlainObject(sJson) ? sJson?.result?.songs : null
  const first = Array.isArray(songs) ? songs[0] : null
  steps.push(
    summarize(s1, {
      top: topKeys(sJson),
      result: sJson?.result ? topKeys(sJson.result) : null,
      songCount: Array.isArray(songs) ? songs.length : 0,
      firstSong: first
        ? pick(first, ['id', 'name', 'duration', 'album'])
        : null,
    }),
  )
  if (!first || !first.id) {
    notes.push('搜索无候选，后续步骤跳过')
    return { alive: false, steps, notes }
  }
  const id = first.id

  // 我们生产代码在用的旧版公开接口（lv/kv/tv/yv）
  const lyricUrl = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1&yv=-1`
  const s2 = await step('netease.lyric.old(我们生产在用)', lyricUrl, {
    headers: { accept: 'application/json', 'user-agent': UA },
  })
  const lJson = parseJson(s2)
  steps.push(
    summarize(s2, {
      top: topKeys(lJson),
      lrc: lJson?.lrc ? { ...pick(lJson.lrc, ['version']), lyricLen: lJson.lrc.lyric?.length ?? 0, looksLikeLrc: looksLikeLrc(lJson.lrc.lyric ?? '') } : null,
      tlyric: lJson?.tlyric ? { lyricLen: lJson.tlyric.lyric?.length ?? 0, looksLikeLrc: looksLikeLrc(lJson.tlyric.lyric ?? '') } : null,
      romalrc: lJson?.romalrc ? { lyricLen: lJson.romalrc.lyric?.length ?? 0, looksLikeLrc: looksLikeLrc(lJson.romalrc.lyric ?? '') } : null,
      yrc: lJson?.yrc ? { lyricLen: lJson.yrc.lyric?.length ?? 0, looksLikeLrc: looksLikeLrc(lJson.yrc.lyric ?? '') } : null,
      ytlrc: lJson?.ytlrc ? { lyricLen: lJson.ytlrc.lyric?.length ?? 0 } : null,
      yromalrc: lJson?.yromalrc ? { lyricLen: lJson.yromalrc.lyric?.length ?? 0 } : null,
    }),
  )
  notes.push(
    lJson?.romalrc
      ? '**旧接口带 rv=-1 就有 romalrc（行级罗马音）** ⇒ T90-⑧ 不用换 EAPI 也能拿罗马音'
      : '旧接口未带 rv=-1 ⇒ 本次未见 romalrc（T90-⑧ 再单独验）',
  )

  // 洛雪走的是 EAPI（加密 form）—— 本探针不实现加密，只验域名/端点是否可达
  const s3 = await step('netease.eapi(洛雪走这条；本探针未加密，仅验连通)', 'https://interface3.music.163.com/eapi/song/lyric/v1', {
    method: 'POST',
    headers: { 'user-agent': UA, origin: 'https://music.163.com' },
    body: '',
  })
  steps.push(summarize(s3, { bodySample: s3.body.slice(0, 120) }))

  return { alive: Boolean(s2.ok), steps, notes }
}

// ---------------------------------------------------------------------------
// ② QQ
// ---------------------------------------------------------------------------

async function probeQq() {
  const steps = []
  const notes = []
  // ⚠️ 必须带 Referer：T74a 实测「不带 ⇒ retcode=-1310 且歌词长度 0（HTTP 仍 200 ⇒ 静默失败）」
  const searchUrl =
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=' +
    encodeURIComponent(KEYWORD) +
    '&format=json'
  const s1 = await step('qq.search(带 Referer)', searchUrl, {
    headers: { referer: 'https://y.qq.com/', 'user-agent': UA, accept: 'application/json' },
  })
  const sJson = parseJson(s1)
  const list = sJson?.data?.song?.list
  const first = Array.isArray(list) ? list[0] : null
  steps.push(
    summarize(s1, {
      top: topKeys(sJson),
      code: sJson?.code ?? null,
      retcode: sJson?.retcode ?? null,
      songCount: Array.isArray(list) ? list.length : 0,
      firstSong: first ? pick(first, ['songmid', 'songname', 'interval']) : null,
    }),
  )
  if (!first || !first.songmid) {
    notes.push('搜索无候选，后续步骤跳过')
    return { alive: false, steps, notes }
  }
  const songmid = first.songmid

  // 我们生产代码在用的旧端点（行级明文 LRC + 翻译）
  const s2 = await step(
    'qq.lyric.old(我们生产在用；行级明文)',
    `https://c.y.qq.com/lyric/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&format=json&nobase64=1`,
    { headers: { referer: 'https://y.qq.com/', 'user-agent': UA } },
  )
  const lJson = parseJson(s2)
  steps.push(
    summarize(s2, {
      top: topKeys(lJson),
      code: lJson?.code ?? null,
      lyricLen: typeof lJson?.lyric === 'string' ? lJson.lyric.length : 0,
      transLen: typeof lJson?.trans === 'string' ? lJson.trans.length : 0,
      looksLikeLrc: looksLikeLrc(lJson?.lyric ?? ''),
      hasQrcField: 'qrc' in (lJson ?? {}),
    }),
  )
  notes.push('旧端点只给行级（无逐字）⇒ 与 T33 规格一致')

  // songmid → songID（洛雪 musicInfo.js 的做法）
  const infoBody = JSON.stringify({
    comm: { ct: '19', cv: '1859', uin: '0' },
    req: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_type: 0, song_mid: songmid },
    },
  })
  const s3 = await step('qq.songInfo(songmid → songID)', 'https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, referer: 'https://y.qq.com/' },
    body: infoBody,
  })
  const iJson = parseJson(s3)
  const songId = iJson?.req?.data?.track_info?.id
  steps.push(
    summarize(s3, {
      top: topKeys(iJson),
      code: iJson?.code ?? null,
      reqCode: iJson?.req?.code ?? null,
      trackInfo: iJson?.req?.data?.track_info
        ? pick(iJson.req.data.track_info, ['id', 'mid', 'title', 'interval'])
        : null,
    }),
  )
  if (!songId) {
    notes.push('拿不到 songID ⇒ 逐字链断开')
    return { alive: Boolean(s2.ok), steps, notes }
  }

  // 逐字（洛雪 GetPlayLyricInfo）：只验响应形状，**不解密**
  const lyricBody = JSON.stringify({
    comm: { ct: '19', cv: '1859', uin: '0' },
    req: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: {
        format: 'json',
        crypt: 1,
        ct: 19,
        cv: 1873,
        interval: 0,
        lrc_t: 0,
        qrc: 1,
        qrc_t: 0,
        roma: 1,
        roma_t: 0,
        songID: songId,
        trans: 1,
        trans_t: 0,
        type: -1,
      },
    },
  })
  const s4 = await step('qq.lyric.qrc(洛雪走这条；密文，只验形状)', 'https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, referer: 'https://y.qq.com/' },
    body: lyricBody,
  })
  const qJson = parseJson(s4)
  const data = qJson?.req?.data
  steps.push(
    summarize(s4, {
      top: topKeys(qJson),
      code: qJson?.code ?? null,
      reqCode: qJson?.req?.code ?? null,
      data: data ? topKeys(data) : null,
      lyricHexLen: typeof data?.lyric === 'string' ? data.lyric.length : 0,
      transHexLen: typeof data?.trans === 'string' ? data.trans.length : 0,
      romaHexLen: typeof data?.roma === 'string' ? data.roma.length : 0,
      lyricSampleHex: typeof data?.lyric === 'string' ? data.lyric.slice(0, 32) : null,
    }),
  )
  notes.push('lyric/trans/roma 是 **hex 密文**（QRC=3DES+zlib）⇒ 解密在 T90-④ 做')

  return { alive: Boolean(s2.ok), steps, notes }
}

// ---------------------------------------------------------------------------
// ③ 酷狗
// ---------------------------------------------------------------------------

const KG_HEADERS = {
  'KG-RC': '1',
  'KG-THash': 'expand_search_manager.cpp:852736169:451',
  'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
}

async function probeKugou() {
  const steps = []
  const notes = []
  const s1 = await step(
    'kg.search(mobilecdn，免签名)',
    'http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=' +
      encodeURIComponent(KEYWORD) +
      '&page=1&pagesize=20&showtype=1',
    { headers: { ...KG_HEADERS, referer: 'https://www.kugou.com/' } },
  )
  const sJson = parseJson(s1)
  const info = sJson?.data?.info
  const first = Array.isArray(info) ? info[0] : null
  steps.push(
    summarize(s1, {
      top: topKeys(sJson),
      status: sJson?.status ?? null,
      errorCode: sJson?.error_code ?? null,
      infoCount: Array.isArray(info) ? info.length : 0,
      firstSong: first
        ? pick(first, ['hash', 'songname', 'singername', 'duration', 'album_name'])
        : null,
    }),
  )
  if (!first || !first.hash) {
    notes.push('搜索无候选，后续步骤跳过')
    return { alive: false, steps, notes }
  }
  const hash = first.hash
  const durationMs = Number(first.duration ?? 0)

  // accesskey：T74a 用 krcs.kugou.com，洛雪用 lyrics.kugou.com —— 两个都测
  for (const host of ['http://krcs.kugou.com/search', 'http://lyrics.kugou.com/search']) {
    const url = `${host}?ver=1&man=yes&client=pc&utf8=1&keyword=${encodeURIComponent(
      KEYWORD,
    )}&duration=${durationMs}&hash=${encodeURIComponent(hash)}`
    const s = await step(`kg.accesskey(${host})`, url, { headers: { ...KG_HEADERS } })
    const j = parseJson(s)
    const cand = Array.isArray(j?.candidates) ? j.candidates[0] : null
    steps.push(
      summarize(s, {
        top: topKeys(j),
        candidateCount: Array.isArray(j?.candidates) ? j.candidates.length : 0,
        candidate: cand ? pick(cand, ['id', 'accesskey', 'contenttype', 'krctype', 'duration']) : null,
      }),
    )
    if (!cand?.id) continue

    const dl = await step(
      'kg.download(fmt=krc)',
      `http://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(
        cand.id,
      )}&accesskey=${encodeURIComponent(cand.accesskey ?? '')}&fmt=krc&charset=utf8`,
      { headers: { ...KG_HEADERS } },
    )
    const dJson = parseJson(dl)
    const content = typeof dJson?.content === 'string' ? dJson.content : ''
    let head4 = null
    let looksEncrypted = null
    if (content) {
      try {
        const raw = Buffer.from(content, 'base64')
        head4 = raw.subarray(0, 4).toString('latin1')
        looksEncrypted = head4 === 'krc1'
      } catch {
        looksEncrypted = false
      }
    }
    steps.push(
      summarize(dl, {
        top: topKeys(dJson),
        status: dJson?.status ?? null,
        info: dJson?.info ?? null,
        fmt: dJson?.fmt ?? null,
        contentLen: content.length,
        decodedHead4: head4,
        headIsKrc1: looksEncrypted,
      }),
    )
    notes.push(
      looksEncrypted === true
        ? '**base64 解出来头 4 字节 = `krc1`** ⇒ 与 T74a 的 KRC 格式一致，解密路径可复用'
        : `头不是 krc1（得到 ${head4 ?? '空'}）⇒ 格式已变，T90-⑤ 需重新核实`,
    )
    break
  }

  return { alive: Boolean(s1.ok), steps, notes }
}

// ---------------------------------------------------------------------------
// ④ 酷我
// ---------------------------------------------------------------------------

async function probeKuwo() {
  const steps = []
  const notes = []
  const s1 = await step(
    'kw.search(search.kuwo.cn)',
    'http://search.kuwo.cn/r.s?client=kt&all=' +
      encodeURIComponent(KEYWORD) +
      '&pn=0&rn=10&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1',
    { headers: { 'user-agent': UA, referer: 'https://www.kuwo.cn/' } },
  )
  const sJson = parseJson(s1)
  const abs = sJson?.abslist
  const first = Array.isArray(abs) ? abs[0] : null
  steps.push(
    summarize(s1, {
      top: topKeys(sJson),
      total: sJson?.TOTAL ?? null,
      listCount: Array.isArray(abs) ? abs.length : 0,
      firstSong: first
        ? pick(first, ['MUSICRID', 'SONGNAME', 'ARTIST', 'ALBUM', 'DURATION'])
        : null,
    }),
  )
  const rid = first?.MUSICRID ? String(first.MUSICRID).replace('MUSIC_', '') : null
  if (!rid) {
    notes.push('搜索无候选，后续步骤跳过')
    return { alive: false, steps, notes }
  }

  // ⚠️ http 明文端点
  const s2 = await step(
    'kw.lyric(mobi.s，**http 明文**，lrcx=1)',
    `http://mlyric.kuwo.cn/mobi.s?f=web&type=lyric&lrcx=1&rid=${encodeURIComponent(rid)}&encode=utf8`,
    { headers: { 'user-agent': UA, referer: 'https://www.kuwo.cn/' } },
  )
  const body = s2.body ?? ''
  const isBase64ish = body.length > 0 && /^[A-Za-z0-9+/=]+$/.test(body.trim())
  steps.push(
    summarize(s2, {
      looksLikePlainLrc: looksLikeLrc(body),
      looksBase64ish: isBase64ish,
      firstLineSample: body.split(/\r?\n/)[0]?.slice(0, 60) ?? null,
    }),
  )
  notes.push(
    isBase64ish
      ? '响应像 base64 ⇒ 与洛雪 `decodeLyric`（XOR+base64）一致 ⇒ 解密在 T90-⑥ 做'
      : '响应不是 base64 ⇒ 形状与洛雪实现不一致，T90-⑥ 需重新核实',
  )

  return { alive: Boolean(s1.ok), steps, notes }
}

// ---------------------------------------------------------------------------
// ⑤ 咪咕
// ---------------------------------------------------------------------------

async function probeMigu() {
  const steps = []
  const notes = []
  const time = Date.now().toString()
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73'
  const sign = md5(
    `${KEYWORD}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`,
  )
  const switchParam = encodeURIComponent(
    '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}',
  )
  const s1 = await step(
    'mg.search(jadeite，带 MD5 签名)',
    `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=${switchParam}&pageSize=10&text=${encodeURIComponent(
      KEYWORD,
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
  const sJson = parseJson(s1)
  const resultList = sJson?.songResultData?.resultList
  let first = null
  if (Array.isArray(resultList)) {
    outer: for (const group of resultList) {
      if (!Array.isArray(group)) continue
      for (const item of group) {
        if (item?.songId) {
          first = item
          break outer
        }
      }
    }
  }
  steps.push(
    summarize(s1, {
      top: topKeys(sJson),
      code: sJson?.code ?? null,
      info: sJson?.info ?? null,
      totalCount: sJson?.songResultData?.totalCount ?? null,
      firstSong: first
        ? {
            songId: { type: typeof first.songId, value: first.songId },
            copyrightId: { type: typeof first.copyrightId, value: first.copyrightId },
            name: { type: typeof first.name, value: first.name },
            lrcUrl: first.lrcUrl ? { type: 'string', length: String(first.lrcUrl).length } : null,
            mrcurl: first.mrcurl ? { type: 'string', length: String(first.mrcurl).length } : null,
            trcUrl: first.trcUrl ? { type: 'string', length: String(first.trcUrl).length } : null,
          }
        : null,
    }),
  )
  const copyrightId = first?.copyrightId
  if (!copyrightId) {
    notes.push('搜索无候选，后续步骤跳过')
    return { alive: false, steps, notes }
  }

  // resourceinfo（拿 mrcUrl / lrcUrl / trcUrl）
  const s2 = await step(
    'mg.resourceinfo(copyrightId → 歌词 URL)',
    'https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
      },
      body: `resourceId=${encodeURIComponent(copyrightId)}`,
    },
  )
  const rJson = parseJson(s2)
  const resource = Array.isArray(rJson?.resource) ? rJson.resource[0] : null
  steps.push(
    summarize(s2, {
      top: topKeys(rJson),
      resourceCount: Array.isArray(rJson?.resource) ? rJson.resource.length : 0,
      resource: resource
        ? {
            songId: { type: typeof resource.songId, value: resource.songId },
            songName: { type: typeof resource.songName, value: resource.songName },
            lrcUrl: resource.lrcUrl ? { type: 'string', length: String(resource.lrcUrl).length } : null,
            mrcUrl: resource.mrcUrl ? { type: 'string', length: String(resource.mrcUrl).length } : null,
            trcUrl: resource.trcUrl ? { type: 'string', length: String(resource.trcUrl).length } : null,
          }
        : null,
    }),
  )

  // 三个歌词 URL 各打一次（只看形状）
  for (const [label, url] of [
    ['mrc(逐字，密文)', resource?.mrcUrl],
    ['lrc(行级，明文)', resource?.lrcUrl],
    ['trc(翻译，明文)', resource?.trcUrl],
  ]) {
    if (!url) {
      steps.push({ name: `mg.lyric.${label}`, skipped: 'URL 缺失' })
      continue
    }
    const s = await step(`mg.lyric.${label}`, url, {
      headers: {
        referer: 'https://app.c.nf.migu.cn/',
        'user-agent': UA,
        channel: '0146921',
      },
    })
    const body = s.body ?? ''
    steps.push(
      summarize(s, {
        looksLikePlainLrc: looksLikeLrc(body),
        firstLineSample: body.split(/\r?\n/)[0]?.slice(0, 60) ?? null,
      }),
    )
  }

  return { alive: Boolean(s1.ok), steps, notes }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const startedAt = new Date().toISOString()
const report = {
  task: 'T90-②',
  startedAt,
  keyword: KEYWORD,
  note: '只验活 / 看字段形状 / 记延迟；**不解密任何歌词内容**',
  sources: {},
}

report.sources.netease = await probeNetease()
report.sources.qq = await probeQq()
report.sources.kugou = await probeKugou()
report.sources.kuwo = await probeKuwo()
report.sources.migu = await probeMigu()

report.summary = Object.fromEntries(
  Object.entries(report.sources).map(([name, value]) => [
    name,
    {
      alive: value.alive,
      failedSteps: value.steps.filter((s) => s.ok === false).map((s) => s.name),
      notes: value.notes,
    },
  ]),
)

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8')

console.log('=== T90-② 探针结果 ===')
for (const [name, value] of Object.entries(report.sources)) {
  console.log(`\n[${name}] alive=${value.alive}`)
  for (const s of value.steps) {
    if (s.skipped) {
      console.log(`   - ${s.name}: 跳过（${s.skipped}）`)
      continue
    }
    const shape = s.shape ? JSON.stringify(s.shape).slice(0, 220) : ''
    console.log(`   - ${s.name}: status=${s.status} ms=${s.ms} bytes=${s.bodyBytes} ${shape}`)
    if (s.error) console.log(`       error: ${s.error}`)
  }
  for (const n of value.notes) console.log(`   · ${n}`)
}
console.log(`\n证据已写入 ${OUT}`)
