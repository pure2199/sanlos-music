// 真机诊断 v2：拖动进度条 → 定位链路到底断在哪一环（T20 排查用）
//
// ---------------------------------------------------------------------------
// ⚡ **最终结论（T20 收口）**
// ---------------------------------------------------------------------------
// **「拖动定位失败」不是产品缺陷 —— 是跑了一份陈旧的 `dist/`。**
//
// 本脚本拿到的证据链：
//   1. 派发 input/change 后，React 的 `pendingSeekRef.current` = 目标值
//      ⇒ **onChange 跑了**（不是「事件没送到」）；
//   2. 派发 mouseup 后，`pendingSeekRef.current` = null、预览值被清空
//      ⇒ **commitSeek 跑了**；
//   3. 渲染进程 **零** pageerror / console:error
//      ⇒ store → 引擎这段**没抛异常**；
//   4. 但媒体的 `currentTime` setter **一次都没被调用**。
//
// ⇒ 「UI 把值交给 store」与「store 把值交给引擎」之间必有一环是空的，
//    而源码那条链路上只有一个动作：`store.getState().seek(pending)`。
//    ⇒ 去产物里一看：`dist/assets/main-*.js` 里压缩后的 `commitSeek`
//      **没有** `getState().seek(...)` —— 那份产物是**旧版本**。
//    ⇒ `npm run build` 之后重跑：媒体 `currentTime` 真的被写成 52.5 并继续播。
//
// ⚠️ **教训**：E2E 是过的，因为 `npm run e2e` 会先 `npm run build`；
//    真机活体验检**直接吃磁盘上那份 `dist/`** —— 于是「E2E 过、真机不过」，
//    而且**全程没有任何报错**。⇒ 现在真机脚本一律先过**构建新鲜度闸门**
//    （`tools/lib/fresh-build.mjs`）：产物比源码旧就硬失败（退出码 3）。
//
// ---------------------------------------------------------------------------
// 这个脚本回答什么
// ---------------------------------------------------------------------------
// v1（`fn-seek-diag.mjs`）已经确认：
//   - 媒体元素**真的在播**（currentTime 被读了几百次并真实推进）；
//   - 媒体**本身支持 seek**（直接 `m.currentTime = 60` 生效并继续播）；
//   - 但走 UI 拖动时，媒体的 `currentTime` setter **一次都没被调用**。
//
// v1 只差最后一步：**是「UI 没把值交给 store」，还是「store 没把值交给媒体」**。
// 光看外部现象分不出来 —— 因为这两种情况在界面上长得一模一样
// （滑块回到媒体位置、位置文案回到 0:0x、媒体没动）。
//
// ⚡ **v2 的关键手法**：直接从 **React fiber** 里读组件的 hook 状态。
//    - `pendingSeekRef` 是个 `useRef` → hook 的 `memoizedState` 是 `{current: X}`；
//    - `dragValue` 是个 `useState` → hook 的 `memoizedState` 就是那个值。
//    于是可以**逐步**回答：
//      派发 input 后  → `pendingSeekRef.current` 是不是目标值？（onChange 到底跑没跑）
//      派发 mouseup 后 → `pendingSeekRef.current` 是不是 null？（commitSeek 到底跑没跑）
//      同时 → 媒体的 `currentTime` setter 有没有被调用？
//    三者一对照，链路断点就是唯一的了。
//
// 另外全程捕获 **渲染进程的 console / pageerror** —— 如果 store 那边抛了异常，
// 这里能直接看到（v1 没抓，所以错过了线索）。
//
// ---------------------------------------------------------------------------
// 安全边界
// ---------------------------------------------------------------------------
// - 凭证只从环境变量读，**不打印、不落盘**；
// - 本脚本只读，**不写**任何数据；只播放，不下载、不改设置。
//
// 用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-seek-diag2.mjs
// ---------------------------------------------------------------------------

import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertFreshBuild } from './lib/fresh-build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')

const FN_SERVER = process.env.FN_SERVER ?? ''
const FN_USER = process.env.FN_USER ?? ''
const FN_PASS = process.env.FN_PASS ?? ''
if (!FN_USER || !FN_PASS) {
  console.error('用法：FN_SERVER=... FN_USER=... FN_PASS=... node tools/fn-seek-diag2.mjs')
  process.exit(2)
}

// ⚠️ **构建新鲜度闸门**：本脚本跑的是磁盘上那份 `dist/` —— 产物比源码旧，
//    就等于在测旧代码（T20 就这么把「拖动定位失败」误判成产品缺陷）。
assertFreshBuild('真机 seek 诊断')

const userDataDir = mkdtempSync(join(tmpdir(), 'fnmusic-seekdiag2-'))
const app = await electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
  env: { ...process.env },
})
const window = await app.firstWindow()

/** 渲染进程的 console / 未捕获异常（**证据**，不能丢）。 */
const logs = []
window.on('console', (msg) => {
  logs.push(`[console:${msg.type()}] ${msg.text()}`)
})
window.on('pageerror', (err) => {
  logs.push(`[pageerror] ${err && err.message ? err.message : String(err)}`)
})

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
  await window.waitForTimeout(8000)

  // -- 注入观测器 ------------------------------------------------------------
  await window.evaluate(() => {
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
          if (!window.__media) window.__media = this
          return v
        },
        set(value) {
          // ⚠️ **先记账再调用原生 setter** —— 原生 setter 抛异常时这笔账也算数。
          window.__seekWrites.push(Number(value))
          desc.set.call(this, value)
        },
      })
    }
  })

  const slider = window.locator('input[aria-label="播放进度"]')
  await slider.waitFor({ timeout: 20000 })
  await window.waitForTimeout(1000)

  /**
   * 读现场：DOM 观测 + **React fiber 里的 hook 状态**。
   *
   * @param label 这一步的名字。
   */
  const readState = async (label) => {
    const s = await window.evaluate((label) => {
      const el = document.querySelector('input[aria-label="播放进度"]')
      if (!el) return { label, error: '找不到滑块' }
      const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
      /**
       * 往上收集**所有**函数组件 fiber（构建产物里名字被压缩了，不能靠 `PlayerBar` 匹配）。
       * 每一层记下它的 ref 钩子 —— `pendingSeekRef` 就是「值为数字或 null 的 ref」。
       */
      const layers = []
      let cur = fiberKey ? el[fiberKey] : null
      let depth = 0
      while (cur && depth < 6) {
        if (typeof cur.type === 'function') {
          const refs = []
          let h = cur.memoizedState
          let i = 0
          while (h) {
            const ms = h.memoizedState
            if (ms && typeof ms === 'object' && 'current' in ms) {
              const c = ms.current
              refs.push({
                i,
                current: typeof c === 'number' ? c : c === null ? 'null' : typeof c,
              })
            }
            h = h.next
            i += 1
          }
          layers.push({
            depth,
            name: cur.type.name || '(匿名)',
            refs,
            hasAlternate: Boolean(cur.alternate),
          })
        }
        cur = cur.return
        depth += 1
      }
      return {
        label,
        elConnected: el.isConnected,
        elValue: el.value,
        position: document.querySelector('[data-testid="player-position"]')?.textContent ?? '',
        tracker: el._valueTracker ? el._valueTracker.getValue() : null,
        writes: window.__seekWrites ?? [],
        ctReads: window.__ctReads ?? null,
        mediaCaught: Boolean(window.__media),
        layers,
      }
    }, label)
    console.log(`\n[${label}] ${JSON.stringify(s)}`)
    return s
  }

  const before = await readState('0 拖动前')
  const sliderMax = await window.evaluate(
    () => document.querySelector('input[aria-label="播放进度"]')?.max ?? '0',
  )
  const target = Math.max(2, Math.round(Number(sliderMax) * 0.3 * 10) / 10)
  console.log(`\n目标位置：${target}s（sliderMax=${sliderMax}）`)

  /**
   * 给滑块节点打标记：用来判断**组件是不是被重新挂载**（换了新 DOM 节点）。
   *
   * @param tag 标记文本。
   */
  const mark = async (tag) =>
    window.evaluate((tag) => {
      const el = document.querySelector('input[aria-label="播放进度"]')
      if (el) el.__probeMark = tag
    }, tag)

  /** 读回滑块节点上的标记（标记没了 = 节点被换掉 = 组件重新挂载）。 */
  const readMark = () =>
    window.evaluate(() => {
      const el = document.querySelector('input[aria-label="播放进度"]')
      if (!el) return '(没滑块)'
      return el.__probeMark ?? '(没了 → 节点被换掉)'
    })

  await mark('A')

  // -- 第 1 步：派发 input / change（模拟「用户把滑块拖到某处」）----------------
  await window.evaluate(() => {
    window.__seekWrites = []
  })
  await slider.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, String(value))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, target)
  await window.waitForTimeout(600)
  const afterInput = await readState('1 派发 input/change 之后')
  const markAfterInput = await readMark()

  // -- 第 2 步：派发 mouseup（模拟「用户松手」）------------------------------
  await slider.evaluate(() => {
    const el = document.querySelector('input[aria-label="播放进度"]')
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  })
  await window.waitForTimeout(1500)
  const afterUp = await readState('2 派发 mouseup 之后')
  const markAfterUp = await readMark()

  // -- 第 3 步：**绕过事件系统**，直接调用 fiber 上的 React handler ------------
  //
  // ⚡ 这一步把「事件没送到 handler」与「handler 跑了但没送到媒体」彻底分开：
  //    `fiber.memoizedProps.onMouseUp` 就是组件里那个 `commitSeek` 本尊。
  await window.evaluate(() => {
    window.__seekWrites = []
  })
  const direct = await window.evaluate((value) => {
    const el = document.querySelector('input[aria-label="播放进度"]')
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    const fiber = fiberKey ? el[fiberKey] : null
    const props = fiber ? fiber.memoizedProps : null
    const out = {
      hasOnChange: Boolean(props && typeof props.onChange === 'function'),
      hasOnMouseUp: Boolean(props && typeof props.onMouseUp === 'function'),
      onChangeThrew: null,
      onMouseUpThrew: null,
    }
    try {
      if (props && typeof props.onChange === 'function') {
        props.onChange({ target: { value: String(value) } })
      }
    } catch (e) {
      out.onChangeThrew = String((e && e.message) || e)
    }
    try {
      if (props && typeof props.onMouseUp === 'function') {
        props.onMouseUp({})
      }
    } catch (e) {
      out.onMouseUpThrew = String((e && e.message) || e)
    }
    return out
  }, target)
  await window.waitForTimeout(1500)
  const afterDirect = await readState('3 直接调用 React handler 之后')

  // -- 判读 ------------------------------------------------------------------
  console.log('\n── 判读 ──')
  console.log(`节点标记：input 后 ${markAfterInput} → mouseup 后 ${markAfterUp}`)
  console.log(`input 后 媒体写入 = ${JSON.stringify(afterInput.writes)}`)
  console.log(`mouseup 后 媒体写入 = ${JSON.stringify(afterUp.writes)}`)
  console.log(`直接调用 handler 后 媒体写入 = ${JSON.stringify(afterDirect.writes)}`)
  console.log(`直接调用结果 = ${JSON.stringify(direct)}`)
  console.log(
    `界面位置：input 后 ${afterInput.position} → mouseup 后 ${afterUp.position} → 直接调用后 ${afterDirect.position}`,
  )
  const byType = {}
  for (const line of logs) {
    const t = (line.match(/^\[(console:[a-z]+|pageerror)\]/) || [, '?'])[1]
    byType[t] = (byType[t] || 0) + 1
  }
  const errs = logs.filter(
    (line) => line.startsWith('[pageerror]') || line.startsWith('[console:error]'),
  )
  console.log(`渲染进程日志分类 = ${JSON.stringify(byType)}`)
  console.log(`错误级日志（${errs.length} 条）：`)
  for (const line of errs.slice(0, 20)) console.log(`  ${line}`)

  if (markAfterUp === '(没了 → 节点被换掉)') {
    console.log('\n⚠️ 滑块 DOM 节点被换掉了 ⇒ 组件**重新挂载**过 ⇒ 组件状态（dragValue / pendingSeekRef）被重置。')
  }
  if (direct.onMouseUpThrew) {
    console.log(`\n⚠️ 直接调用 onMouseUp 抛了异常：${direct.onMouseUpThrew}`)
  }
  // ⚠️ **顺序要紧**：先看「走真实事件」的结果 —— 它成功的话，
  //    「直接调用 handler」也成功只是**顺带**的结果，不能据此说事件系统坏了。
  if (afterUp.writes.length > 0) {
    console.log('\n✅ 走真实事件就能写到媒体 ⇒ 链路是通的（UI → store → 引擎 → 媒体）。')
  } else if (afterDirect.writes.length > 0) {
    console.log('\n⚠️ 只有直接调用 handler 才写得到媒体 ⇒ 事件系统没把 mouseup 送到 handler。')
  } else {
    console.log('\n⚠️ 连直接调用 handler 都写不到媒体 ⇒ 断点在 store → 引擎 → 媒体这一段。')
  }
  console.log(
    '⚠️ 若上一行报「断点在 store → 引擎」：先确认产物是不是新的（`npm run build`）——' +
      'T20 的真因就是跑了一份**陈旧 dist**（压缩后的 commitSeek 里没有 getState().seek）。',
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
