import { expect, test } from '@playwright/test'

import { launchApp, login, type AppFixture } from './helpers/app'

// ---------------------------------------------------------------------------
// Task 13：E2E 冒烟
// ---------------------------------------------------------------------------
//
// 覆盖**只有真实 Electron 才跑得通**的那条链路：
//   登录（主进程 IPC → HTTP → mock NAS）
//     → 曲库（`fnm://` 协议代理 → 主进程 → mock）
//       → 播放（真实 `<audio>` ← `fnm://` 流 → mock 的 WAV）
//
// ⚠️ 这些环节在 Vitest + jsdom 里**一个都不存在**（没有 Electron 主进程、
//    没有自定义协议、没有真实媒体元素）——所以这组用例不是重复单测，
//    而是补上单测**够不到**的那一段。
//
// ⚠️ 全部数据都是 mock 的占位数据，不含真实 FN ID / 账号 / 口令 / 歌曲名。
// ---------------------------------------------------------------------------

test.describe.serial('飞牛音乐桌面端：E2E 冒烟', () => {
  let fixture: AppFixture

  test.beforeAll(async () => {
    fixture = await launchApp()
  })

  test.afterAll(async () => {
    await fixture?.close()
  })

  test('启动 → 渲染出登录页', async () => {
    await expect(fixture.window.getByRole('heading', { name: '连接飞牛音乐' })).toBeVisible()
    // 顶栏的曲库导航也必须在（外壳是一体的）。
    await expect(fixture.window.getByRole('button', { name: '歌曲' })).toBeVisible()
  })

  test('登录 mock NAS → 显示「已连接」', async () => {
    await login(fixture.window, fixture.mock.url)

    // 登录页切到「已连接」态（`role="status"` 的区块）。
    await expect(fixture.window.getByRole('heading', { name: '已连接' })).toBeVisible()

    // ⚠️ **口令绝不进 DOM**：登录成功后口令框被清空。
    await expect(fixture.window.locator('#fnm-password')).toHaveValue('')
  })

  test('曲库「歌曲」页 → 列出 mock 的歌（fnm:// 代理通）', async () => {
    await fixture.window.getByRole('button', { name: '歌曲' }).click()

    const list = fixture.window.getByRole('listbox', { name: '歌曲列表' })
    await expect(list).toBeVisible()

    // mock 的曲库是 8 首 → 至少要渲染出若干行。
    const rows = list.getByRole('option')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(0)
  })

  test('双击一行 → 播放条显示该歌（真实 <audio> + fnm:// 流通）', async () => {
    const list = fixture.window.getByRole('listbox', { name: '歌曲列表' })
    const firstRow = list.getByRole('option').first()
    const title = (await firstRow.locator('.fnm-songlist__title').textContent())?.trim() ?? ''
    expect(title.length).toBeGreaterThan(0)

    // 双击 = 播放（单击只是选中）。
    await firstRow.dblclick()

    // 播放条显示同一首歌名 → 说明「双击 → onPlay → 引擎 → <audio>」整条链路通。
    const playerTitle = fixture.window.locator('.fnm-playerbar__title')
    await expect(playerTitle).toHaveText(title)

    // 播放条**不能**报错误（媒体元素真的解码并起播了）。
    await expect(fixture.window.getByTestId('player-notice')).toHaveCount(0)
  })

  // -------------------------------------------------------------------------
  // T20：拖动进度条定位（这条链路此前**从未被任何集成测试覆盖过**）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **断言的是「客户端契约」，不是「上游支不支持 Range」**：
  //    1. 用户拖动进度条 → UI 预览 → 松手提交 → store.seek → 引擎.seek
  //       → **媒体元素的 currentTime 被真的写成目标位置**。
  //    2. 「媒体能否从该位置继续播」取决于**上游是否支持 Range** 且格式可随机访问
  //       —— 那是**上游能力**，由真机探针 `tools/fn-range-probe.mjs` 回答，
  //       不该在这里断言（mock 的 WAV 从中间字节开始返回时没有文件头，
  //       Chromium 的 WAV 解码器本来就解不了 → 那是**格式**限制，不是客户端缺陷）。
  //
  // ⚠️ **鉴别力**：只看「滑块的值变了」是**假绿**（UI 预览变了不代表媒体真的被定位）。
  //    必须观测**媒体元素的 currentTime 到底被写了什么**。
  //    手法与 `tools/fn-fallback-playback-diag.mjs` 同款：
  //    **劫持 `HTMLMediaElement.prototype` 上的 accessor**——
  //    引擎的 `<audio>` 是 `document.createElement('audio')` 造的、**从不挂进 DOM**，
  //    `document.querySelector('audio')` 永远查不到，只能从原型上观测。
  //
  test('拖动进度条 → 媒体元素真的被定位到目标位置（不是只动滑块）', async () => {
    // 劫持 `currentTime` 的 setter，记录**所有**写入值。
    await fixture.window.evaluate(() => {
      const proto = HTMLMediaElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'currentTime')
      if (!desc?.get || !desc.set) throw new Error('currentTime 不是可劫持的 accessor')
      const writes: number[] = []
      ;(window as unknown as { __fnmSeekWrites?: number[] }).__fnmSeekWrites = writes
      Object.defineProperty(proto, 'currentTime', {
        configurable: true,
        enumerable: desc.enumerable,
        get(this: HTMLMediaElement): number {
          return desc.get!.call(this)
        },
        set(this: HTMLMediaElement, value: number): void {
          writes.push(value)
          desc.set!.call(this, value)
        },
      })
    })

    // 播放（确保媒体元素存在）。
    const list = fixture.window.getByRole('listbox', { name: '歌曲列表' })
    await list.getByRole('option').first().dblclick()

    const slider = fixture.window.getByRole('slider', { name: '播放进度' })
    // 进度条要等媒体元素报出时长才可用（mock 的音频 60 秒）。
    await expect(slider).toBeEnabled()
    await expect
      .poll(async () => Number(await slider.getAttribute('max')), { timeout: 15000 })
      .toBeGreaterThan(1)

    const max = Number(await slider.getAttribute('max'))
    const target = Math.round(max * 0.5 * 10) / 10

    // 拖到中段。
    //
    // ⚠️ **必须用原生 setter**：React 给 `<input>` 的 `value` 装了「变更追踪器」，
    //    直接 `el.value = x` 会被当成「值没变」→ onChange **不触发** → 拖动是假的。
    //    用 `HTMLInputElement.prototype` 上的原生 setter 绕过追踪器，再派发 `input`。
    await slider.evaluate((el, value) => {
      const input = el as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) throw new Error('拿不到 value 的原生 setter')
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, target)

    // 松手 → 提交预览位置（组件的语义是「松手才真正 seek」）。
    await slider.dispatchEvent('mouseup')

    // ⚠️ **核心断言**：媒体元素真的被 seek 了。
    await expect
      .poll(
        async () =>
          fixture.window.evaluate(
            () => (window as unknown as { __fnmSeekWrites?: number[] }).__fnmSeekWrites ?? [],
          ),
        { timeout: 10000 },
      )
      .toContain(target)

    // ⚠️ 鉴别力补充：那个写入值必须**不是 0**（同曲重播会写 0），
    //    否则「只是重播了一下」也能满足上面的断言。
    const writes = await fixture.window.evaluate(
      () => (window as unknown as { __fnmSeekWrites?: number[] }).__fnmSeekWrites ?? [],
    )
    expect(writes.filter((v) => v > 1)).not.toHaveLength(0)
  })
})
