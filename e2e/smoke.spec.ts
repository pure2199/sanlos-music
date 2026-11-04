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

  // -------------------------------------------------------------------------
  // T22：虚拟网格 / 虚拟列表不能被内容撑破
  // -------------------------------------------------------------------------
  //
  // ⚠️ **缺陷**：主区 `.app-shell__main` 原先没有 `min-height: 0`——
  //    flex item 的自动最小尺寸默认是 `min-height: auto` = 内容的 min-content 高度，
  //    而虚拟网格的**画布高度 = 行数 × 行高** → 主区被内容顶到 4 万多像素
  //    → 网格**没有负余量可压缩** → 「可视区」= 全部内容
  //    → **虚拟裁剪失效**（真机实测：一次性挂载 **1,050 张卡片** → 1,050 个封面请求
  //      把公共中继打到 502），同时「内容填不满可视区就自动续一页」永远成立
  //    → **无限翻页**。
  //
  // ⚠️ **为什么在测试里伪造画布高度**：mock 只有 3 张专辑 / 8 首歌
  //    （且 `test/mock-server.test.ts` 钉死了这些数量，**不能**为了让缺陷显形
  //    而扩 mock 数据）→ 撑不出真机那个量级。
  //    于是用 `!important` 把画布高度压到 40,000px，**复现同一个失效条件**：
  //    「内容远超高时，容器必须自己滚动，而不是被内容顶高」。
  //
  // ⚠️ **鉴别力**：断言的是**几何关系**（`clientHeight < scrollHeight`），
  //    不是「画了多少个节点」——mock 只有 3 张专辑，节点数恒等于 3，断言不了。
  //
  test('曲库网格 / 歌曲列表被内容撑高时，容器自己滚动（虚拟裁剪真实生效）', async () => {
    // 伪造「内容远超高」。（`!important` 盖得过 React 的内联高度。）
    await fixture.window.addStyleTag({
      content: `
        .fnm-cardgrid__canvas { height: 40000px !important; }
        .fnm-songlist__canvas { height: 40000px !important; }
      `,
    })

    /** 量一个滚动容器的几何关系 + 主区高度。 */
    const measure = async (selector: string) =>
      fixture.window.evaluate((sel) => {
        const element = document.querySelector(sel) as HTMLElement | null
        const main = document.querySelector('.app-shell__main') as HTMLElement | null
        if (!element) throw new Error(`找不到 ${sel}`)
        if (!main) throw new Error('找不到主区')
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          mainClientHeight: main.clientHeight,
          windowHeight: window.innerHeight,
        }
      }, selector)

    // --- 专辑页（真机上就是这一页挂载了 1,050 张卡片） ---
    await fixture.window.getByRole('button', { name: '专辑' }).click()
    // ⚠️ 必须等**画布**出现：条目为空时网格渲染的是空态提示，没有画布。
    await expect(fixture.window.locator('.fnm-cardgrid__canvas')).toBeVisible()

    const grid = await measure('.fnm-cardgrid')
    // ⚠️ **核心断言 1**：网格**自己内部滚动**（可视区 < 内容高度）
    //    ——被内容顶高时这两个数会**相等**，虚拟裁剪就等于没裁剪。
    expect(grid.clientHeight).toBeLessThan(grid.scrollHeight)
    // ⚠️ **核心断言 2**：主区高度不超过窗口高度（否则内容会溢出到播放条上）。
    expect(grid.mainClientHeight).toBeLessThanOrEqual(grid.windowHeight)

    // --- 歌曲页（另一个虚拟列表：行内 28px 缩略图同样是封面请求） ---
    await fixture.window.getByRole('button', { name: '歌曲' }).click()
    await expect(fixture.window.locator('.fnm-songlist__canvas')).toBeVisible()

    const list = await measure('.fnm-songlist__viewport')
    expect(list.clientHeight).toBeLessThan(list.scrollHeight)
    expect(list.mainClientHeight).toBeLessThanOrEqual(list.windowHeight)
  })

  // -------------------------------------------------------------------------
  // T24：播放模式（随机播放）按钮
  // -------------------------------------------------------------------------
  //
  // ⚠️ 四种模式的**语义**早就实现完整（`src/player/queue.ts` + 单测都有），
  //    但**播放条上压根没有能点到它的按钮** —— 能力对用户等于不存在。
  //    这条 E2E 钉的就是「**真的切得到**」：
  //    点按钮 → store 的 mode 变 → 按钮文案与 `data-mode` 同步。
  //
  test('播放模式：点按钮在「顺序 → 随机 → 单曲循环 → 列表循环」之间轮转', async () => {
    const button = fixture.window.getByTestId('play-mode-button')
    await expect(button).toBeVisible()
    await expect(button).toHaveText('顺序播放')
    await expect(button).toHaveAttribute('data-mode', 'sequence')

    await button.click()
    await expect(button).toHaveText('随机播放')
    await expect(button).toHaveAttribute('data-mode', 'shuffle')

    await button.click()
    await expect(button).toHaveText('单曲循环')
    await expect(button).toHaveAttribute('data-mode', 'loop-one')

    await button.click()
    await expect(button).toHaveText('列表循环')
    await expect(button).toHaveAttribute('data-mode', 'loop-list')

    // 一圈之后回到起点。
    await button.click()
    await expect(button).toHaveText('顺序播放')
    await expect(button).toHaveAttribute('data-mode', 'sequence')
  })

  // -------------------------------------------------------------------------
  // T25：行内收藏（曲库各页 → 收藏写回 → 收藏页）
  // -------------------------------------------------------------------------
  //
  // ⚠️ 这条链路此前**只有搜索页**能用（曲库 / 收藏 / 详情页都没有收藏入口）。
  //    这里钉的是**整条真实链路**：
  //    渲染层行内按钮 → store（单一真相源）→ IPC → NAS mock 的
  //    `favorite-track/create` → 收藏列表真的多出一首。
  //
  test('行内收藏：歌曲页收藏一首 → 收藏页里出现它', async () => {
    await fixture.window.getByRole('button', { name: '歌曲' }).click()

    const list = fixture.window.getByRole('listbox', { name: '歌曲列表' })
    // ⚠️ **取第二行**：mock 的第一首 fixture 里 `isFavorite: true`
    //    （fixture 刻意覆盖了 true/false 两种样本）→ 它的按钮本来就是「已收藏」。
    //    这里要测的是「**收藏**」这个动作 → 得挑一首**没被收藏**的。
    const row = list.getByRole('option').nth(1)
    const title = (await row.locator('.fnm-songlist__title').textContent())?.trim() ?? ''
    expect(title.length).toBeGreaterThan(0)

    const favoriteButton = row.getByTestId('fnm-favorite-toggle')
    await expect(favoriteButton).toHaveAttribute('aria-pressed', 'false')

    await favoriteButton.click()
    // 乐观更新：界面**立刻**反映（不等请求回来）。
    await expect(favoriteButton).toHaveAttribute('aria-pressed', 'true')

    // 收藏页：这一首**真的**出现在收藏列表里（mock 的收藏集合确实变了）。
    // ⚠️ 必须**限定在导航里**找「收藏」：行内收藏按钮的无障碍名也叫「收藏」
    //    （`getByRole('button', { name: '收藏' })` 会命中 9 个 → strict mode 报错）。
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '收藏' })
      .click()
    const favorites = fixture.window.getByRole('listbox', { name: '收藏列表' })
    await expect(favorites.getByRole('option').filter({ hasText: title }).first()).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // T26：歌单页新建歌单
  // -------------------------------------------------------------------------
  //
  // ⚠️ 此前「新建歌单」只做在**搜索页**的写回区里 → 「歌单」页上一个建单入口都没有，
  //    而 mock 的账号**一个歌单都没有** → 用户打开歌单页只会看到「暂无歌单」。
  //
  test('歌单页：新建一个歌单 → 立刻出现在歌单列表里', async () => {
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '歌单' })
      .click()

    await fixture.window.getByPlaceholder('新歌单名称').fill('E2E 新建歌单')
    await fixture.window.getByRole('button', { name: '新建歌单' }).click()

    // 新歌单**真的**出现在歌单列表里（mock 的歌单集合变了）。
    // ⚠️ 必须**限定在歌单列表里**找：成功提示里也含这个名字（`getByText` 会命中 2 个）。
    // ⚠️ 歌单网格的 role 是 `list`（**不是** `listbox` —— 那是歌曲列表用的）。
    await expect(
      fixture.window.getByRole('list', { name: '歌单列表' }).getByText('E2E 新建歌单'),
    ).toBeVisible()
    await expect(fixture.window.getByRole('status').filter({ hasText: '已创建' })).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // T27：批量下载
  // -------------------------------------------------------------------------
  //
  // ⚠️ 此前只能**逐首**点行内的「下载」按钮；而 `SongList` 早就有多选接缝
  //    （Ctrl / Shift 点选）→ 用户选好一整批，却只能一首一首点。
  //
  // ⚠️ 这一条会**真的下载**（mock 的假音频）→ 下载目录已被 `helpers/app.ts`
  //    预置到**临时目录**（绝不能往用户真实的「我的音乐」里写）。
  //
  test('批量下载：Ctrl 多选两首 → 工具条出现 → 点「下载所选」排队两首', async () => {
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '歌曲' })
      .click()

    const list = fixture.window.getByRole('listbox', { name: '歌曲列表' })
    const rows = list.getByRole('option')
    await expect(rows.first()).toBeVisible()

    // Ctrl + 单击 = 切换该行的选中态（多选）。
    await rows.nth(0).click({ modifiers: ['ControlOrMeta'] })
    await rows.nth(1).click({ modifiers: ['ControlOrMeta'] })

    // 工具条出现，并如实写明选了几首。
    await expect(fixture.window.getByText('已选 2 首')).toBeVisible()

    // 点「下载所选」→ 两首都排进队列（主进程串行下载，不并发）。
    await fixture.window.getByRole('button', { name: '下载所选 2 首' }).click()
    await expect(fixture.window.getByRole('status').filter({ hasText: '已排队下载 2 首' })).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // T28：从曲库页把选中的歌加进歌单
  // -------------------------------------------------------------------------
  //
  // ⚠️ 此前「加歌进歌单」**只在搜索页**有入口 —— 在曲库里选好一整批歌，却无处可加。
  //    写回端点 T25 已真机校准（`playlist/add-track` → `{ guid, trackGUIDs }`）。
  //
  // ⚠️ 这条用例断言的是**真的写回去了**：加完之后去歌单页看详情，
  //    那两首**真的在歌单里**（不是只看一句成功提示）。
  //
  test('曲库页：多选两首 → 加入歌单 → 歌单详情里真的多了这两首', async () => {
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '歌曲' })
      .click()

    // ⚠️ **先切走再切回**：上一条用例在同一页选过两首，而页面**不会重挂载**
    //    → 选中态还留着 → 这里的 Ctrl 单击会把它**切掉**。
    //    切走再切回 = 页面重新挂载 → 选中态归零（这本身就是该有的行为）。
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '专辑' })
      .click()
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '歌曲' })
      .click()

    const list = fixture.window.getByRole('listbox', { name: '歌曲列表' })
    const rows = list.getByRole('option')
    await expect(rows.first()).toBeVisible()

    const firstTitle = (await rows.nth(0).locator('.fnm-songlist__title').textContent())?.trim() ?? ''
    const secondTitle = (await rows.nth(1).locator('.fnm-songlist__title').textContent())?.trim() ?? ''

    // Ctrl + 单击 = 多选。
    await rows.nth(0).click({ modifiers: ['ControlOrMeta'] })
    await rows.nth(1).click({ modifiers: ['ControlOrMeta'] })
    await expect(fixture.window.getByText('已选 2 首')).toBeVisible()

    // 「加入歌单」→ 浮层面板展开 → 选歌单 → 加入。
    await fixture.window.getByTestId('fnm-add-to-playlist-button').click()
    const panel = fixture.window.getByRole('group', { name: '加入歌单' })
    await expect(panel).toBeVisible()
    await panel.getByRole('combobox').selectOption({ label: 'E2E 新建歌单' })
    await panel.getByRole('button', { name: '加入' }).click()
    await expect(
      fixture.window.getByRole('status').filter({ hasText: '已把 2 首加入歌单' }),
    ).toBeVisible()

    // 真的加进去了：到歌单页看详情。
    await fixture.window
      .getByRole('navigation', { name: '曲库导航' })
      .getByRole('button', { name: '歌单' })
      .click()
    await fixture.window.getByRole('list', { name: '歌单列表' }).getByText('E2E 新建歌单').click()
    const detail = fixture.window.getByRole('listbox', { name: '歌单歌曲列表' })
    await expect(detail.getByText(firstTitle)).toBeVisible()
    await expect(detail.getByText(secondTitle)).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // T23：自动更新接线（检查 → 下载 → 签名闸）
  // -------------------------------------------------------------------------
  //
  // ⚠️ **这条链路此前完全没有被任何测试覆盖过**（本项目原来压根没有自动更新）。
  //    它一次跑通了四段：
  //      渲染层发 IPC → 主进程拉清单（走 Chromium 分区栈）→ 比版本
  //      → 下载 + SHA-512 校验 → Authenticode 闸门
  //
  // ⚠️ **断言的是「安全闸」**：mock 的假安装包**没有签名**
  //    → 「启动安装」必须**禁用**（不许装未签名的包）。
  //
  test('自动更新：检查到新版本 → 下载校验通过 → 签名不过就不许安装', async () => {
    // 打开设置面板。
    await fixture.window.getByRole('button', { name: '设置' }).click()

    // 填更新服务器地址（mock 的回环地址：http 只允许回环）与预期签名者。
    await fixture.window
      .locator('input[name="fnm-update-base-url"]')
      .fill(`${fixture.mock.url}/update`)
    await fixture.window
      .locator('input[name="fnm-update-signer"]')
      .fill('CN=Mock 占位签名者')
    // ⚠️ `name` 默认是**子串**匹配 → 「保存」会同时命中「保存目录」→ 必须 exact。
    await fixture.window.getByRole('button', { name: '保存', exact: true }).click()

    // 检查更新 → mock 的清单版本是 9.9.9（比应用版本新）。
    await fixture.window.getByRole('button', { name: '检查更新' }).click()
    await expect(fixture.window.getByTestId('update-available')).toContainText('9.9.9')

    // 下载 → SHA-512 与清单一致 → 落盘 → 签名校验**不通过**（假包没签名）。
    await fixture.window.getByRole('button', { name: '下载更新' }).click()
    await expect(fixture.window.getByTestId('update-downloaded')).toContainText('签名校验未通过')

    // ⚠️ **核心断言**：签名没过 → 不许启动安装器（自动更新 = 远程代码执行）。
    await expect(fixture.window.getByRole('button', { name: '启动安装' })).toBeDisabled()
  })
})
