// 真机诊断：拖动进度条时，React 的 onChange 到底有没有触发（T20 排查用）
//
// ---------------------------------------------------------------------------
// ⚠️ **本脚本的结论已被 v2 修正（2026-11-04）**
// ---------------------------------------------------------------------------
// 下面那段「⇒ 结论只剩一条可能：`pendingSeekRef` 是 null ⇒ React 的 `onChange`
// 没触发」**是错的**（当时是从外部现象反推的，推理链断在了中间）。
//
// v2（`fn-seek-diag2.mjs`）从 **React fiber** 里直接读到了 hook 状态，真相是：
//   - `onChange` **跑了**（`pendingSeekRef.current` = 目标值）；
//   - `commitSeek` **也跑了**（松手后 ref 被清空、预览值复位）；
//   - 渲染进程**零报错**；
//   - 但媒体的 `currentTime` setter **一次都没被调用**。
// ⇒ 真因是**跑了一份陈旧的 `dist/`**：那份产物里压缩后的 `commitSeek`
//    **没有** `store.getState().seek(pending)` —— 「松手」只会清预览值，
//    永远不会真的定位。`npm run build` 之后一切正常。
//
// ⚠️ **教训已落地**：真机脚本现在一律先过**构建新鲜度闸门**
//    （`tools/lib/fresh-build.mjs`），产物比源码旧就硬失败。
//    ⇒ 本脚本保留下来：它的四个实验（合成事件 / 真实鼠标拖动 / 直接设
//      `currentTime` / 键盘 End）是**用户路径**层面的取样，仍然有用；
//      但**结论要看 v2**。
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// T20 给真机活体验检加了一步「拖动进度条定位」，结果**真机上失败**：
//
//   媒体元素没有被 seek 到 6s｜媒体 currentTime 采样 1.852→4.361333
//   现场：{"writes":[],"hasAccessor":true,"mediaSrcs":[],
//          "ctReads":{"last":14.452,"count":2263},
//          "sliderCount":1,"sliderValue":"14.5","sliderMax":"175.102042",
//          "sliderDisabled":false,"position":"0:14"}
//
// 逐条读这个现场：
// - `ctReads.count = 2263`、`last = 14.452` → **媒体元素真的在推进**（不是时钟外推）；
// - `sliderDisabled = false`、`sliderMax = 175.1` → 进度条**可用**，时长正常；
// - `writes = []` → **媒体的 `currentTime` setter 从未被调用**；
// - `sliderValue = "14.5"` → 我设进去的 6 **被冲回了当前位置**。
//
// ⇒ 结论只剩一条可能：**`pendingSeekRef` 是 null** ⇒ React 的 `onChange` 没触发
//    ⇒ `commitSeek()` 直接 return，什么都没做。
//
// 而同样的手法在 **E2E（mock）里是通过的** → 机制本身没写错，
//    差异只在**真机环境**。这个脚本就是把那一步**拆开逐步观测**，
//    看清「原生 setter 改值 → 派发 input → React 是否接管」到底断在哪一环。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 凭证只从环境变量读，**不打印、不落盘**；
// - 本脚本只读，**不写**任何数据；
// - 只播放、不下载、不改任何设置。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-seek-diag.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_SERVER = process.env.FN_SERVER ?? ''
const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
if (!FN_USER || !FN_PASS) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-seek-diag.mjs')
  process.exit(2)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-seekdiag-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})
const window = await app.firstWindow()

/** 当前会话的登录地址。 */
const server = FN_SERVER.replace(/\/+$/, '')

try {
  // -- 登录 -----------------------------------------------------------------
  await window.fill('#fnm-address', server)
  await window.fill('#fnm-username', FN_USER)
  await window.fill('#fnm-password', FN_PASS)
  await window.click('button[type="submit"]')
  await window
    .getByRole('heading', { name: '已连接' })
    .waitFor({ timeout: 30000 })
    .catch(() => undefined)

  // -- 播放第一首 ------------------------------------------------------------
  await window.locator('nav[aria-label="曲库导航"] button', { hasText: '歌曲' }).first().click()
  const row = window.locator('[role="option"]').first()
  await row.waitFor({ timeout: 30000 })
  await row.dblclick()
  await window.waitForTimeout(6000)

  // -- 劫持 + 分步观测 --------------------------------------------------------
  await window.evaluate(() => {
    window.__log = []
    window.__seekWrites = []
    window.__ctReads = { last: null, count: 0 }
    window.__media = null
    const proto = HTMLMediaElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'currentTime')
    window.__hasAccessor = Boolean(desc && desc.get && desc.set)
    if (desc && desc.get && desc.set) {
      Object.defineProperty(proto, 'currentTime', {
        configurable: true,
        get() {
          const v = desc.get.call(this)
          window.__ctReads.last = Number(v)
          window.__ctReads.count += 1
          // ⚠️ **顺手抓住媒体元素本身**：引擎的 `<audio>` 从不挂进 DOM，
          //    `document.querySelector('audio')` 永远查不到 —— 只能从原型上拿。
          if (!window.__media) window.__media = this
          return v
        },
        set(value) {
          window.__seekWrites.push(Number(value))
          desc.set.call(this, value)
        },
      })
    }
  })

  const slider = window.locator('input[aria-label="播放进度"]')
  await slider.waitFor({ timeout: 20000 })
  await window.waitForTimeout(1000)

  const snap = async (label) => {
    const s = await window.evaluate(() => {
      const el = document.querySelector('input[aria-label="播放进度"]')
      return {
        sliderValue: el ? el.value : null,
        sliderMax: el ? el.max : null,
        sliderDisabled: el ? el.disabled : null,
        sliderCount: document.querySelectorAll('input[aria-label="播放进度"]').length,
        position: document.querySelector('[data-testid="player-position"]')?.textContent ?? '',
        writes: window.__seekWrites ?? [],
        ctReads: window.__ctReads ?? null,
        // ⚠️ React 的 value 追踪器装在**节点**上：读它就知道 React 记住的上一个值是多少。
        trackerLast: el && el._valueTracker ? el._valueTracker.getValue() : null,
      }
    })
    console.log(`\n[${label}]`)
    console.log(JSON.stringify(s, null, 2))
    return s
  }

  const before = await snap('拖动前')
  const max = Number(before.sliderMax)
  const target = Math.max(2, Math.round(max * 0.3 * 10) / 10)
  console.log(`\n目标位置：${target}s（max=${max}）`)

  // -- 实验 C：**直接**给媒体元素设 currentTime --------------------------------
  //
  // ⚠️ 这一步把「客户端的锅」和「上游 / 缓冲状态的锅」一刀切开：
  //    - 若设完之后媒体**真的跳到**目标位置 → 媒体支持 seek
  //      ⇒ 客户端的 seek 链路有问题（**产品缺陷**）；
  //    - 若设完之后媒体**纹丝不动** → 媒体自己不接受 seek
  //      （还在缓冲 / 该资源不可随机访问）→ **不是客户端的锅**。
  await window.evaluate(() => {
    window.__seekWrites = []
  })
  const beforeDirect = await window.evaluate(() => {
    const m = window.__media
    if (!m) return { error: '没抓到媒体元素' }
    const ranges = []
    for (let i = 0; i < m.buffered.length; i++) {
      ranges.push([m.buffered.start(i), m.buffered.end(i)])
    }
    return {
      readyState: m.readyState,
      networkState: m.networkState,
      duration: m.duration,
      currentTime: m.currentTime,
      paused: m.paused,
      error: m.error ? { code: m.error.code, message: m.error.message } : null,
      buffered: ranges,
      src: String(m.src).slice(0, 80),
    }
  })
  console.log(`\n[实验 C 媒体元素状态] ${JSON.stringify(beforeDirect)}`)

  const directResult = await window.evaluate(async () => {
    const m = window.__media
    if (!m) return { error: '没抓到媒体元素' }
    const target = 60
    m.currentTime = target
    await new Promise((r) => setTimeout(r, 3000))
    return {
      requested: target,
      currentTimeAfter: m.currentTime,
      readyState: m.readyState,
      networkState: m.networkState,
      error: m.error ? { code: m.error.code, message: m.error.message } : null,
      writes: window.__seekWrites ?? [],
    }
  })
  console.log(`[实验 C 直接设 currentTime=60 后] ${JSON.stringify(directResult)}`)

  // -- 实验 A：合成事件（原生 setter + dispatchEvent），mouseup 也用合成 ---------
  // ⚠️ 先清零：实验 C 的写入会污染这里的读数。
  await window.evaluate(() => {
    window.__seekWrites = []
  })
  await slider.evaluate((el, value) => {
    const input = el
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, target)
  await window.waitForTimeout(800)
  const afterInput = await snap('实验 A：合成 input 之后')

  // ⚠️ **同步**派发 mouseup 并**同步**读 writes —— 排除任何时序干扰。
  const syncUp = await slider.evaluate(() => {
    const input = document.querySelector('input[aria-label="播放进度"]')
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    return {
      writes: window.__seekWrites ?? [],
      value: input.value,
      position: document.querySelector('[data-testid="player-position"]')?.textContent ?? '',
    }
  })
  console.log(`\n[实验 A 同步 mouseup 之后] ${JSON.stringify(syncUp)}`)
  await window.waitForTimeout(1200)
  const afterUp = await snap('实验 A：mouseup 后')

  // -- 实验 B：**真实鼠标拖动**（最接近用户）---------------------------------
  await window.evaluate(() => {
    window.__seekWrites = []
  })
  const box = await slider.boundingBox()
  if (box) {
    const y = box.y + box.height / 2
    const x0 = box.x + box.width * 0.1
    const x1 = box.x + box.width * 0.7
    await window.mouse.move(x0, y)
    await window.mouse.down()
    await window.mouse.move(x1, y, { steps: 8 })
    await window.mouse.up()
    await window.waitForTimeout(1500)
  }
  const afterRealDrag = await snap('实验 B：真实鼠标拖动之后')

  // -- 实验 D：**键盘**操作（最干净的真实用户路径）---------------------------
  //
  // ⚠️ 键盘改 range 的值是**浏览器原生行为** → 派发真正的 `input` / `change` 事件
  //    → React 的 onChange 触发 → `onKeyUp` → `commitSeek`。
  //    这条路径完全不依赖「鼠标事件能不能落到滑块上」。
  await window.evaluate(() => {
    window.__seekWrites = []
  })
  await slider.focus()
  await slider.press('End')
  await window.waitForTimeout(2000)
  const afterKeyboard = await snap('实验 D：键盘 End 之后')

  console.log('\n── 判读 ──')
  console.log(`目标位置：${target}s（max=${max}）`)
  console.log(`实验 C（直接给媒体设 currentTime）：${JSON.stringify(directResult)}`)
  console.log(`实验 A（合成事件）media 写入：${JSON.stringify(afterUp.writes)}`)
  console.log(`实验 B（真实鼠标拖动）media 写入：${JSON.stringify(afterRealDrag.writes)}`)
  console.log(`实验 D（键盘 End）media 写入：${JSON.stringify(afterKeyboard.writes)}`)
  console.log(
    `实验 D 后界面位置：${afterKeyboard.position}｜媒体 currentTime：${afterKeyboard.ctReads?.last}`,
  )
  const directWorked =
    typeof directResult.currentTimeAfter === 'number' &&
    Math.abs(directResult.currentTimeAfter - 60) <= 2
  console.log(
    directWorked
      ? '\n✅ **媒体本身支持 seek**（直接设 currentTime 生效）⇒ 若 UI 路径仍失败，断点在客户端链路。' +
          '\n   ⚠️ **先查构建产物是不是新的**（`npm run build`）—— T20 的真因就是一份陈旧 dist' +
          '（压缩后的 commitSeek 里没有 getState().seek）。'
      : '\n⚠️ **媒体本身不接受 seek**（直接设 currentTime 也没跳）⇒ 不是客户端的锅（上游/缓冲/格式限制）。',
  )
} finally {
  await Promise.race([
    app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined),
    new Promise((r) => setTimeout(r, 3000)),
  ])
  await app.close().catch(() => undefined)
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 忽略 */
  }
}
