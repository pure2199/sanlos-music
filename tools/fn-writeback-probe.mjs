#!/usr/bin/env node
/**
 * 真机探针：校准**写回端点**的参数名与真实效果（T25 / T26 的前置）。
 *
 * 用法:
 *   FN_USER=xxx FN_PASS=xxx node tools/fn-writeback-probe.mjs --fnid <FNID>
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个探针
 * ---------------------------------------------------------------------------
 * `src/api/favorite.ts` 与 `src/api/playlist.ts` 里的写回调用
 * （`favorite-track/create` / `favorite-track/delete` /
 *   `playlist/add-track` / `playlist/remove-track`）
 * **参数名是照官方 Web 端猜的**，而且**从来没有在真机上跑过**。
 *
 * ⇒ 客户端里那几个调用**可能是「看着能点、实际 404 / 报错」的假功能**。
 *   本探针就是把这件事查清楚：**哪个参数名真的生效**。
 *
 * ---------------------------------------------------------------------------
 * 探针回答什么
 * ---------------------------------------------------------------------------
 * - **F**：`favorite-track/create` / `favorite-track/delete` 的参数名；
 *   收藏是否**真的生效**（收藏列表里出现 / 消失）。
 * - **M**：`track/list` 的曲目对象里**有没有** `isFavorite` 字段
 *   （决定行内收藏按钮的初始态能不能直接取服务端字段）。
 * - **P**：`playlist/add-track` / `playlist/remove-track` 的参数名；
 *   加歌 / 移歌是否**真的生效**（歌单详情里出现 / 消失）。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 副作用与自清理
 * ---------------------------------------------------------------------------
 * - 会**真的收藏一首歌**（探针目标）→ 结论拿到后**立即取消收藏**；
 * - 会**真的新建一个歌单** → 加一首歌 → 移出 → **删掉歌单**；
 * - 任何一步失败都会在输出里明确告知**需要手工清理的 id**。
 *
 * ⚠️ 凭据只从环境变量读，**不打印、不落盘**。
 * ---------------------------------------------------------------------------
 */

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
  const sign = md5([SIGN_PREFIX, pathnameOf(url), nonceV, tsV, payload, key].join('_'))
  return `nonce=${nonceV}&timestamp=${tsV}&sign=${sign}`
}

const args = process.argv.slice(2)
const getArg = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const fnId = getArg('fnid')
if (!fnId) {
  console.error('用法: node tools/fn-writeback-probe.mjs --fnid <FNID>')
  process.exit(1)
}

const user = process.env.FN_USER
const pass = process.env.FN_PASS
if (!user || !pass) {
  console.error('需要 FN_USER / FN_PASS 环境变量。')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 连通 + 登录（走中继）
// ---------------------------------------------------------------------------

async function fetchConnectionParams() {
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
  return res.json()
}

async function pickRelay(data) {
  const relays = data.fn?.length ? data.fn : [`${fnId}.fnos.net:443`]
  for (const r of relays) {
    const domain = String(r).replace(/:\d+$/, '')
    const address = `https://${domain}`
    try {
      const res = await fetch(`${address}/music/api/v1/health`, {
        headers: { cookie: 'mode=relay' },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status < 400) return address
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

let base = null
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
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON（SPA 兜底） */
  }
  return {
    status: res.status,
    code: json?.code ?? null,
    msg: json?.msg ?? '',
    data: json?.data ?? null,
    json,
    isJson: json !== null,
  }
}

/** 一行摘要（端点 / 参数名 / HTTP / 业务码 / 是否 JSON）。 */
function line(label, r) {
  const kind = r.isJson ? `code=${r.code}` : `非 JSON（SPA 兜底）`
  return `${label.padEnd(46)} HTTP ${r.status} ${kind} ${r.msg ? `msg=${r.msg}` : ''}`
}

/** 取收藏列表里的全部 id（分页循环取全，与客户端一致）。 */
async function favoriteIds() {
  const ids = new Set()
  for (let page = 1; page <= 5; page += 1) {
    const r = await call(`/music/api/v1/favorite-track/list?page=${page}&size=200`)
    const list = r.data?.list ?? []
    for (const item of list) {
      const id = item?.guid ?? item?.id
      if (id) ids.add(id)
    }
    if (list.length === 0) break
  }
  return ids
}

/** 取收藏列表的 total。 */
async function favoriteTotal() {
  const r = await call('/music/api/v1/favorite-track/list?page=1&size=1')
  return r.data?.total ?? -1
}

// ---------------------------------------------------------------------------
// F：favorite-track/create · delete
// ---------------------------------------------------------------------------

/** 候选参数名（按「最可能」排序）。 */
const FAVORITE_KEY_CANDIDATES = ['trackGUID', 'guid', 'trackGuid', 'id', 'trackId', 'GUID']

async function stepF() {
  console.log('\n=== F: favorite-track/create · delete 的参数名 ===')

  const before = await favoriteIds()
  const beforeTotal = await favoriteTotal()
  console.log(`收藏现状：total=${beforeTotal}，已取回 ${before.size} 个 id`)

  // 探针目标：**当前没被收藏**的一首（否则测不出「收藏」这个动作）。
  const tracks = await call('/music/api/v1/track/list?page=1&size=20')
  const target = (tracks.data?.list ?? []).find((item) => {
    const id = item?.guid ?? item?.id
    return id && !before.has(id)
  })
  const targetId = target?.guid ?? target?.id
  if (!targetId) {
    console.log('⚠️ 找不到「未收藏」的探针目标，跳过 F')
    return null
  }
  console.log(`探针目标：${targetId}（${target.title ?? '?'}）`)

  // --- create ---
  let createKey = null
  for (const key of FAVORITE_KEY_CANDIDATES) {
    const r = await call('/music/api/v1/favorite-track/create', 'POST', { [key]: targetId })
    console.log(line(`create  body={${key}:…}`, r))
    const ids = await favoriteIds()
    if (ids.has(targetId)) {
      createKey = key
      console.log(`   ✅ 参数名命中：{${key}: targetId} → 收藏列表里已出现`)
      break
    }
    // 业务码是 0 但列表没变 → 「接受了但没生效」，也要记。
    if (r.code === 0) {
      console.log('   ⚠️ 业务码 0 但收藏列表没变 → 这次调用「接受了但没生效」')
    }
  }
  if (!createKey) {
    console.log('❌ 所有候选参数名都没让收藏生效 → 客户端当前的 `trackGUID` 假设**不成立**')
  } else {
    console.log(`\n结论：favorite-track/create 的参数名 = \`${createKey}\``)

    // --- delete ---
    let deleteKey = null
    for (const key of FAVORITE_KEY_CANDIDATES) {
      const r = await call('/music/api/v1/favorite-track/delete', 'POST', { [key]: targetId })
      console.log(line(`delete  body={${key}:…}`, r))
      const ids = await favoriteIds()
      if (!ids.has(targetId)) {
        deleteKey = key
        console.log(`   ✅ 参数名命中：{${key}: targetId} → 收藏列表里已消失`)
        break
      }
      if (r.code === 0) {
        console.log('   ⚠️ 业务码 0 但收藏列表没变 → 这次调用「接受了但没生效」')
      }
    }
    if (!deleteKey) {
      console.log('❌ 所有候选参数名都没让取消收藏生效 → 需手工取消该收藏')
      console.log(`   ⚠️ 需手工清理的曲目 id：${targetId}`)
    } else {
      console.log(`结论：favorite-track/delete 的参数名 = \`${deleteKey}\``)
    }
  }
  return { targetId, createKey }
}

// ---------------------------------------------------------------------------
// M：track/list 的曲目对象里有没有 isFavorite
// ---------------------------------------------------------------------------

async function stepM() {
  console.log('\n=== M: 曲目对象里有没有 isFavorite 字段 ===')
  const r = await call('/music/api/v1/track/list?page=1&size=3')
  const list = r.data?.list ?? []
  if (list.length === 0) {
    console.log('⚠️ 拿不到曲目样本，跳过 M')
    return
  }
  const sample = list[0]
  const keys = Object.keys(sample)
  console.log(`曲目对象字段（${keys.length} 个）：${keys.join(',')}`)
  console.log(`   有 isFavorite：${keys.includes('isFavorite') ? '✅ 有' : '❌ 没有'}`)
  if (keys.includes('isFavorite')) {
    for (const item of list) {
      console.log(`   ${item.guid ?? item.id} → isFavorite=${JSON.stringify(item.isFavorite)}`)
    }
  }

  // 收藏列表里的曲目呢？
  const fav = await call('/music/api/v1/favorite-track/list?page=1&size=3')
  const favList = fav.data?.list ?? []
  if (favList.length > 0) {
    const favKeys = Object.keys(favList[0])
    console.log(
      `收藏列表曲目里有 isFavorite：${favKeys.includes('isFavorite') ? '✅ 有' : '❌ 没有'}` +
        (favKeys.includes('isFavorite') ? `（值 = ${JSON.stringify(favList[0].isFavorite)}）` : ''),
    )
  }
}

// ---------------------------------------------------------------------------
// P：playlist/add-track · remove-track
// ---------------------------------------------------------------------------

/** 候选的「加歌」请求体（按「最可能」排序）。 */
const ADD_TRACK_CANDIDATES = [
  { label: '{ guid, trackGUIDs:[id] }', body: (guid, id) => ({ guid, trackGUIDs: [id] }) },
  {
    label: '{ playlistGUID, trackGUIDs:[id] }',
    body: (guid, id) => ({ playlistGUID: guid, trackGUIDs: [id] }),
  },
  {
    label: '{ guid, trackGuids:[id] }',
    body: (guid, id) => ({ guid, trackGuids: [id] }),
  },
  { label: '{ guid, trackGUID:id }', body: (guid, id) => ({ guid, trackGUID: id }) },
  {
    label: '{ playlistGUID, trackGUID:id }',
    body: (guid, id) => ({ playlistGUID: guid, trackGUID: id }),
  },
]

/** 候选的「移歌」请求体。 */
const REMOVE_TRACK_CANDIDATES = [
  { label: '{ guid, trackGUIDs:[id] }', body: (guid, id) => ({ guid, trackGUIDs: [id] }) },
  {
    label: '{ playlistGUID, trackGUIDs:[id] }',
    body: (guid, id) => ({ playlistGUID: guid, trackGUIDs: [id] }),
  },
  {
    label: '{ guid, trackGuids:[id] }',
    body: (guid, id) => ({ guid, trackGuids: [id] }),
  },
  { label: '{ guid, trackGUID:id }', body: (guid, id) => ({ guid, trackGUID: id }) },
  {
    label: '{ playlistGUID, trackGUID:id }',
    body: (guid, id) => ({ playlistGUID: guid, trackGUID: id }),
  },
]

/** 歌单详情里的曲目 id 集合。 */
async function playlistSongIds(guid) {
  const ids = new Set()
  for (let page = 1; page <= 5; page += 1) {
    const r = await call(`/music/api/v1/track/playlist-detail/list?playlistGUID=${guid}&page=${page}&size=200`)
    const list = r.data?.list ?? []
    for (const item of list) {
      const id = item?.guid ?? item?.id
      if (id) ids.add(id)
    }
    if (list.length === 0) break
  }
  return ids
}

async function stepP() {
  console.log('\n=== P: playlist/add-track · remove-track 的参数名 ===')

  const name = `__写回探针_${Date.now().toString(36)}__`
  const created = await call('/music/api/v1/playlist/create', 'POST', { name })
  console.log(line('create  body={name}', created))
  const guid = typeof created.data?.guid === 'string' ? created.data.guid : ''
  if (!guid) {
    console.log('❌ 建歌单没回显 guid → P 段跳过')
    return
  }
  console.log(`   探针歌单 guid=${guid}`)

  // 目标曲目：随便取一首。
  const tracks = await call('/music/api/v1/track/list?page=1&size=1')
  const item = tracks.data?.list?.[0]
  const targetId = item?.guid ?? item?.id
  if (!targetId) {
    console.log('⚠️ 拿不到目标曲目，跳过加歌段')
    await call('/music/api/v1/playlist/delete', 'POST', { guid })
    return
  }
  console.log(`探针目标：${targetId}`)

  // --- add-track ---
  let addLabel = null
  for (const candidate of ADD_TRACK_CANDIDATES) {
    const r = await call('/music/api/v1/playlist/add-track', 'POST', candidate.body(guid, targetId))
    console.log(line(`add-track  body=${candidate.label}`, r))
    const ids = await playlistSongIds(guid)
    if (ids.has(targetId)) {
      addLabel = candidate.label
      console.log(`   ✅ 命中：body=${candidate.label} → 歌单详情里已出现`)
      break
    }
    if (r.code === 0) {
      console.log('   ⚠️ 业务码 0 但歌单详情没变 → 「接受了但没生效」')
    }
  }
  if (!addLabel) {
    console.log('❌ 所有候选请求体都没让歌单真的多出这首 → 客户端当前假设**不成立**')
  } else {
    console.log(`\n结论：playlist/add-track 的请求体 = ${addLabel}`)

    // --- remove-track ---
    let removeLabel = null
    for (const candidate of REMOVE_TRACK_CANDIDATES) {
      const r = await call('/music/api/v1/playlist/remove-track', 'POST', candidate.body(guid, targetId))
      console.log(line(`remove-track  body=${candidate.label}`, r))
      const ids = await playlistSongIds(guid)
      if (!ids.has(targetId)) {
        removeLabel = candidate.label
        console.log(`   ✅ 命中：body=${candidate.label} → 歌单详情里已消失`)
        break
      }
      if (r.code === 0) {
        console.log('   ⚠️ 业务码 0 但歌单详情没变 → 「接受了但没生效」')
      }
    }
    if (!removeLabel) {
      console.log('❌ 所有候选请求体都没让歌单真的少掉这首 → 需手工清理')
      console.log(`   ⚠️ 需手工清理：歌单「${name}」guid=${guid} 里的曲目 ${targetId}`)
    } else {
      console.log(`结论：playlist/remove-track 的请求体 = ${removeLabel}`)
    }
  }

  // --- 自清理：删掉探针歌单 ---
  const del = await call('/music/api/v1/playlist/delete', 'POST', { guid })
  console.log(line('\n清理：delete  body={guid}', del))
  if (del.code === 0) {
    console.log('   ✅ 已删除探针歌单，无残留')
  } else {
    console.log(`   ⚠️ 删除失败，需手工清理：歌单「${name}」guid=${guid}`)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const con = await fetchConnectionParams()
  if (con.code !== 0) {
    console.error('FN 连接接口失败:', con.code, con.msg)
    process.exit(1)
  }
  base = await pickRelay(con.data ?? {})
  if (!base) {
    console.error('没有可达的中继链路。')
    process.exit(1)
  }
  console.log('链路:', base)

  const deviceId = createHash('sha256').update(`${user}:${Date.now()}`).digest('hex').slice(0, 32)
  const loginBody = JSON.stringify({ username: user, password: sha256(pass), deviceId })
  const loginRes = await fetch(`${base}/music/api/v1/user/password-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authx: authx('POST', '/music/api/v1/user/password-login', loginBody, MUSIC_SIGN_KEY, nonce(), ts()),
      cookie: 'mode=relay',
    },
    body: loginBody,
    signal: AbortSignal.timeout(15000),
  })
  const login = await loginRes.json().catch(() => null)
  if (login?.code !== 0) {
    console.error('登录失败:', login?.code, login?.msg)
    process.exit(1)
  }
  console.log('登录成功')
  cookie = `music-token=${login.data.userToken}; mode=relay`

  await stepF()
  await stepM()
  await stepP()
}

main().catch((e) => {
  console.error('探测失败:', e)
  process.exit(1)
})
