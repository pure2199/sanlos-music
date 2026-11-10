// ---------------------------------------------------------------------------
// Task 17：系统托盘 / 后台续播 / 偏好 / 播放器 IPC（**主进程侧**）
//
// 覆盖任务简报与控制器追加要求 A–G 中**主进程侧可测**的部分：
// - C：`trayTooltip` 的格式、127 字符上限、**按码点**截断（不切半个代理对）；
// - B：托盘封面字节的来源（**同一个 `HttpStack` 实例**）、按 `coverId` 缓存 + 上界、
//   异步不阻塞托盘创建、取不到时的降级；
// - D：偏好文件（`<userData>/prefs.json`）的读写、**偏好里绝无凭证**；
// - E：IPC 通道的注册与**方向**（`player:state` 是 `on` 推送、`player:command`
//   由主进程转发回渲染进程、`prefs:*` / `theme:set` / `win:*` 是 `handle`）；
// - F：`createTray(deps)` 的依赖可注入（单测不依赖真实 Electron）。
//
// ⚠️ 测试里一律用占位数据（「歌一」「示例歌手」…），
//    **不写真实 FN ID / 账号 / 口令 / 真实歌曲名**。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createCoverFetcher,
  createTray,
  trayTooltip,
  truncateByCodePoint,
  TRAY_COVER_SIZE,
  TRAY_ICON_SIZE,
  TRAY_TOOLTIP_MAX,
  type MenuItemLike,
  type MenuLike,
  type NativeImageFactory,
  type NativeImageLike,
  type TrayLike,
} from '../electron/tray'
import { PrefsStore, registerPlayerIpc, type IpcMainEventsLike } from '../electron/ipc'
import type { HttpStack } from '../electron/http'
import type { SessionManager, SessionState } from '../electron/session'
import type { AppPrefs, PlayerCommand, PlayerStateSnapshot } from '../shared/playerBridge'
import { SPECTRUM_BIN_COUNT } from '../shared/spectrum'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 假图标（记录被设到托盘上的图标）。 */
class FakeImage implements NativeImageLike {
  constructor(readonly label: string) {}
  isEmpty(): boolean {
    return this.label === 'empty'
  }
  resize(): NativeImageLike {
    return new FakeImage(`${this.label}@resized`)
  }
}

/** 假图标工厂。 */
const fakeNativeImage: NativeImageFactory = {
  createEmpty: () => new FakeImage('empty'),
  createFromBuffer: (bytes) => new FakeImage(`bytes:${bytes.byteLength}`),
}

/** 假托盘（记录事件与调用）。 */
interface FakeTray extends TrayLike {
  /**
   * 建托盘时传进去的图标（T75：用来断言「建托盘时用的是**应用图标**」）。
   */
  icon: NativeImageLike | null
  /** 记录 `setToolTip` 的每一次调用。 */
  tooltips: string[]
  /** 记录 `setImage` 的每一次调用。 */
  images: NativeImageLike[]
  /** 事件监听器。 */
  listeners: Map<string, Array<() => void>>
  /** 是否已销毁。 */
  destroyed: boolean
}

function fakeTray(): FakeTray {
  const tray: FakeTray = {
    icon: null,
    tooltips: [],
    images: [],
    listeners: new Map(),
    destroyed: false,
    setToolTip(tooltip: string) {
      tray.tooltips.push(tooltip)
    },
    setImage(image: NativeImageLike) {
      tray.images.push(image)
    },
    on(event: 'click' | 'right-click', listener: () => void) {
      const list = tray.listeners.get(event) ?? []
      list.push(listener)
      tray.listeners.set(event, list)
    },
    destroy() {
      tray.destroyed = true
    },
  }
  return tray
}

/** 假菜单（记录模板与弹出次数）。 */
interface FakeMenu extends MenuLike {
  /** 菜单模板。 */
  template: MenuItemLike[]
  /** 弹出次数。 */
  pops: number
}

function fakeMenuBuilder(): { build: (template: MenuItemLike[]) => FakeMenu; menus: FakeMenu[] } {
  const menus: FakeMenu[] = []
  return {
    menus,
    build(template: MenuItemLike[]): FakeMenu {
      const menu: FakeMenu = {
        template,
        pops: 0,
        popup() {
          menu.pops += 1
        },
      }
      menus.push(menu)
      return menu
    },
  }
}

/** 假 `HttpStack`（记录请求 URL，按 URL 返回响应）。 */
function fakeHttp(
  responder: (url: string) => Response | Promise<Response>,
): { http: HttpStack; calls: string[] } {
  const calls: string[] = []
  const http: HttpStack = {
    async fetch(input) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      return responder(url)
    },
    bumpTrustEpoch() {},
    partitionName: () => 'fn-nas-v0',
  }
  return { http, calls }
}

/** 假会话（只要 `state`）。 */
function fakeSession(overrides: Partial<SessionState> = {}): Pick<SessionManager, 'state'> {
  return {
    state: {
      base: 'https://nas.local:5666/music',
      mode: 'password',
      token: 'TOKEN-PLACEHOLDER',
      deviceId: 'DEVICE-PLACEHOLDER',
      username: 'demo',
      password: 'pw',
      isRelay: false,
      ...overrides,
    },
  }
}

/** 造一条占位曲目快照。 */
function track(overrides: Partial<NonNullable<PlayerStateSnapshot['current']>> = {}) {
  return {
    id: 'song-1',
    title: '歌一',
    artist: '示例歌手',
    album: '示例专辑',
    coverId: 'track_abc',
    duration: 100,
    ...overrides,
  }
}

/** 造一份占位播放器状态快照。 */
function state(overrides: Partial<PlayerStateSnapshot> = {}): PlayerStateSnapshot {
  return {
    current: track(),
    isPlaying: true,
    position: 0,
    duration: 100,
    volume: 1,
    mode: 'sequence',
    muted: false,
    ...overrides,
  }
}

/** 临时目录（每个用例一个，用完删）。 */
const tempDirs: string[] = []

function tempFile(name = 'prefs.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnmusic-tray-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// trayTooltip（追加要求 C）
// ---------------------------------------------------------------------------

describe('trayTooltip', () => {
  it('超过 127 字符按字符截断', () => {
    const s = trayTooltip({ title: 'x'.repeat(300), artist: 'y', playing: true })
    expect(s.length).toBeLessThanOrEqual(127)
  })

  it('暂停时标注状态', () => {
    expect(trayTooltip({ title: 'T', artist: 'A', playing: false })).toContain('已暂停')
  })

  it('包含歌名与歌手', () => {
    const s = trayTooltip({ title: '歌一', artist: '示例歌手', playing: true })
    expect(s).toContain('歌一')
    expect(s).toContain('示例歌手')
  })

  it('播放中不标注「已暂停」', () => {
    expect(trayTooltip({ title: '歌一', artist: '示例歌手', playing: true })).not.toContain('已暂停')
  })

  it('截断后仍然保留歌手（优先砍歌名）', () => {
    const s = trayTooltip({ title: 'x'.repeat(300), artist: '示例歌手', playing: true })
    expect(s.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX)
    expect(s).toContain('示例歌手')
  })

  it('没有曲目时显示应用名', () => {
    expect(trayTooltip({ title: '', artist: '', playing: false })).toBe('Sanlos Music')
  })

  it('emoji 不会被截成半个代理对', () => {
    // '🎵' 是一个代理对（2 个 UTF-16 码元）；按码元切会切出乱码。
    const s = trayTooltip({ title: '🎵'.repeat(200), artist: '示例歌手', playing: true })
    expect(s.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX)
    // 任何一个代理对都必须是**完整**的（高代理 + 低代理）。
    for (let i = 0; i < s.length; i += 1) {
      const code = s.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = s.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
        i += 1
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true)
      }
    }
  })

  it('组合字符（重音）按码点切，不会切出半个码点', () => {
    const s = trayTooltip({ title: 'é'.repeat(200), artist: '示例歌手', playing: true })
    expect(s.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX)
    // 组合字符 'e' + U+0301 的第二部分不能单独出现。
    expect(s.includes('́')).toBe(false)
  })
})

describe('truncateByCodePoint', () => {
  it('不截断时原样返回', () => {
    expect(truncateByCodePoint('abc', 10)).toBe('abc')
  })

  it('超长时截断并补省略号，且不超预算', () => {
    const out = truncateByCodePoint('abcdef', 4)
    expect(out.length).toBeLessThanOrEqual(4)
    expect(out.endsWith('…')).toBe(true)
  })

  it('按码点切：代理对要么完整要么不出现', () => {
    const out = truncateByCodePoint('🎵🎵🎵', 3)
    expect(out.length).toBeLessThanOrEqual(3)
    expect(out).toBe('🎵…')
  })

  it('预算为 0 时返回空串', () => {
    expect(truncateByCodePoint('abc', 0)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 托盘（追加要求 B / D / F）
// ---------------------------------------------------------------------------

describe('createTray', () => {
  it('立刻建好托盘，不等封面（不阻塞）', () => {
    const tray = fakeTray()
    const cover = { fetch: vi.fn(() => new Promise<Uint8Array | null>(() => {})), size: () => 0, clear: () => {} }
    const controller = createTray({
      createTray: () => tray,
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
      getState: () => state(),
    })
    expect(controller.tray).toBe(tray)
    // 封面请求已经发出，但托盘**已经建好了**（同步返回，没有等封面 promise）。
    expect(cover.fetch).toHaveBeenCalledTimes(1)
  })

  it('tooltip 随播放器状态更新', () => {
    const tray = fakeTray()
    const controller = createTray({
      createTray: () => tray,
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
    })
    controller.update(state({ current: track({ title: '歌一', artist: '示例歌手' }), isPlaying: true }))
    expect(tray.tooltips.at(-1)).toContain('歌一')
    expect(tray.tooltips.at(-1)).toContain('示例歌手')
  })

  it('右键弹菜单、左键显示窗口', () => {
    const tray = fakeTray()
    const { build, menus } = fakeMenuBuilder()
    const showWindow = vi.fn()
    createTray({
      createTray: () => tray,
      nativeImage: fakeNativeImage,
      buildMenu: build,
      showWindow,
    })
    tray.listeners.get('right-click')?.forEach((fn) => fn())
    expect(menus[0]?.pops).toBe(1)
    tray.listeners.get('click')?.forEach((fn) => fn())
    expect(showWindow).toHaveBeenCalledTimes(1)
  })

  it('菜单项：播放/暂停、上一首、下一首、显示窗口、退出', () => {
    const tray = fakeTray()
    const { build, menus } = fakeMenuBuilder()
    const sendCommand = vi.fn()
    const showWindow = vi.fn()
    const quit = vi.fn()
    createTray({
      createTray: () => tray,
      nativeImage: fakeNativeImage,
      buildMenu: build,
      sendCommand,
      showWindow,
      quit,
    })

    const labels = (menus[0]?.template ?? []).map((item) => item.label)
    expect(labels).toContain('播放 / 暂停')
    expect(labels).toContain('上一首')
    expect(labels).toContain('下一首')
    expect(labels).toContain('显示窗口')
    expect(labels).toContain('退出')

    const click = (label: string): void => {
      const item = (menus[0]?.template ?? []).find((entry) => entry.label === label)
      item?.click?.()
    }

    click('播放 / 暂停')
    expect(sendCommand).toHaveBeenCalledWith({ type: 'toggle' })
    click('上一首')
    expect(sendCommand).toHaveBeenCalledWith({ type: 'prev' })
    click('下一首')
    expect(sendCommand).toHaveBeenCalledWith({ type: 'next' })
    click('显示窗口')
    expect(showWindow).toHaveBeenCalledTimes(1)
    click('退出')
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('封面到了之后才 setImage', async () => {
    const tray = fakeTray()
    let resolveCover: (bytes: Uint8Array) => void = () => {}
    const cover = {
      fetch: vi.fn(() => new Promise<Uint8Array | null>((resolve) => { resolveCover = resolve })),
      size: () => 0,
      clear: () => {},
    }
    const controller = createTray({
      createTray: (icon) => {
        tray.icon = icon
        return tray
      },
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
      // ⚠️ T75：注入**应用图标** —— 没在播放时托盘显示它（**不是空白**）。
      appIcon: new FakeImage('app-icon'),
    })
    controller.update(state())
    // 封面还没到 → 托盘当前显示的是**应用图标**（**非空**）。
    // ⚠️ 这条断言的前提（T75 前是「默认 = 空图」）被用户指令**显式推翻**
    //    ⇒ 改写为新行为断言（**不删**）。
    expect(tray.icon?.isEmpty()).toBe(false)
    expect(String((tray.icon as unknown as { label: string }).label)).toBe('app-icon')
    // 封面还没到 ⇒ **一次 setImage 都还没发生**（封面才是第二个图标）。
    expect(tray.images).toHaveLength(0)

    resolveCover(new Uint8Array([1, 2, 3]))
    await vi.waitFor(() => {
      expect(tray.images.some((image) => !image.isEmpty())).toBe(true)
    })
    // 封面到了 ⇒ 设上去的是**封面**，不是应用图标。
    const last = tray.images[tray.images.length - 1]
    expect(String((last as unknown as { label: string }).label)).toContain('bytes:')
  })

  it('取不到封面时降级为**应用图标**（不崩，也不是空白）', async () => {
    const tray = fakeTray()
    const cover = {
      fetch: vi.fn(async () => null),
      size: () => 0,
      clear: () => {},
    }
    const controller = createTray({
      createTray: (icon) => {
        tray.icon = icon
        return tray
      },
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
      // ⚠️ T75：注入**应用图标** —— 封面取失败时托盘显示它（**不是空白**）。
      appIcon: new FakeImage('app-icon'),
    })
    controller.update(state())
    await vi.waitFor(() => {
      expect(cover.fetch).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(tray.images.length).toBeGreaterThan(0)
    })
    // ⚠️ 这条断言的前提（T75 前是「降级成空图」）被用户指令**显式推翻**
    //    ⇒ 改写为新行为断言（**不删**，且**更强**：原来那条是空数组上的恒真断言）。
    expect(tray.images.every((image) => !image.isEmpty())).toBe(true)
    expect(
      tray.images.map((image) => String((image as unknown as { label: string }).label)),
    ).toEqual(['app-icon'])
  })

  it('图标被缩到托盘尺寸', async () => {
    const tray = fakeTray()
    const cover = {
      fetch: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
      size: () => 0,
      clear: () => {},
    }
    const controller = createTray({
      createTray: () => tray,
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
    })
    controller.update(state())
    await vi.waitFor(() => {
      expect(tray.images.some((image) => !image.isEmpty())).toBe(true)
    })
    const resized = tray.images.find((image) => !image.isEmpty())
    expect(String((resized as unknown as { label: string }).label)).toContain(`@resized`)
    expect(TRAY_ICON_SIZE).toBe(16)
  })
})

// ---------------------------------------------------------------------------
// 封面缓存（追加要求 B）
// ---------------------------------------------------------------------------

describe('createCoverFetcher', () => {
  it('走注入的 HttpStack（不用全局 fetch），URL 形状正确', async () => {
    const { http, calls } = fakeHttp(() => new Response(new Uint8Array([1, 2, 3])))
    const fetcher = createCoverFetcher({ http, session: fakeSession() })
    const bytes = await fetcher.fetch('track_abc')
    expect(bytes).not.toBeNull()
    expect(bytes?.byteLength).toBe(3)
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('/api/v1/static/cover')
    expect(calls[0]).toContain('coverId=track_abc')
    expect(calls[0]).toContain(`size=${TRAY_COVER_SIZE}`)
  })

  it('同一个 coverId 不重复下载（按 coverId 缓存）', async () => {
    const { http, calls } = fakeHttp(() => new Response(new Uint8Array([1])))
    const fetcher = createCoverFetcher({ http, session: fakeSession() })
    await fetcher.fetch('track_abc')
    await fetcher.fetch('track_abc')
    expect(calls.length).toBe(1)
    expect(fetcher.size()).toBe(1)
  })

  it('缓存有上界（超限淘汰最久未用的）', async () => {
    const { http, calls } = fakeHttp(() => new Response(new Uint8Array([1])))
    const fetcher = createCoverFetcher({ http, session: fakeSession(), maxEntries: 2 })
    await fetcher.fetch('c1')
    await fetcher.fetch('c2')
    await fetcher.fetch('c3')
    expect(fetcher.size()).toBe(2)
    // c1 被淘汰了 → 再取要重新下载。
    await fetcher.fetch('c1')
    expect(calls.length).toBe(4)
  })

  it('请求失败返回 null（不抛异常）', async () => {
    const { http } = fakeHttp(() => {
      throw new Error('网络不可达')
    })
    const fetcher = createCoverFetcher({ http, session: fakeSession() })
    await expect(fetcher.fetch('track_abc')).resolves.toBeNull()
  })

  it('HTTP 4xx/5xx 返回 null', async () => {
    const { http } = fakeHttp(() => new Response('nope', { status: 404 }))
    const fetcher = createCoverFetcher({ http, session: fakeSession() })
    await expect(fetcher.fetch('track_abc')).resolves.toBeNull()
  })

  it('没有会话时不发请求', async () => {
    const { http, calls } = fakeHttp(() => new Response(new Uint8Array([1])))
    const fetcher = createCoverFetcher({
      http,
      session: fakeSession({ base: '', token: '' }),
    })
    await expect(fetcher.fetch('track_abc')).resolves.toBeNull()
    expect(calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 偏好文件（追加要求 D）
// ---------------------------------------------------------------------------

describe('PrefsStore', () => {
  it('文件不存在时返回空偏好', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    expect(prefs.read()).toEqual({})
  })

  it('写入后能读回（主题 / 关闭窗口行为 / 窗口位置）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ theme: 'fluent', closeBehavior: 'quit', windowBounds: { width: 1000, height: 700 } })
    expect(prefs.read()).toEqual({
      theme: 'fluent',
      closeBehavior: 'quit',
      windowBounds: { width: 1000, height: 700 },
    })
  })

  it('写入是合并语义（没写的键保持原值）', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ theme: 'fluent' })
    prefs.write({ closeBehavior: 'hide' })
    expect(prefs.read().theme).toBe('fluent')
    expect(prefs.read().closeBehavior).toBe('hide')
  })

  it('偏好文件里绝无凭证（未知键一律丢弃）', () => {
    const filePath = tempFile()
    const prefs = new PrefsStore({ filePath })
    prefs.write({
      token: 'SECRET-TOKEN',
      password: 'SECRET-PW',
      deviceId: 'SECRET-DEVICE',
    } as unknown as Partial<AppPrefs>)
    const text = readFileSync(filePath, 'utf8')
    expect(text).not.toContain('SECRET-TOKEN')
    expect(text).not.toContain('SECRET-PW')
    expect(text).not.toContain('SECRET-DEVICE')
    expect(text).not.toContain('token')
    expect(text).not.toContain('password')
    expect(text).not.toContain('deviceId')
  })

  it('非法的主题名 / 行为被忽略', () => {
    const prefs = new PrefsStore({ filePath: tempFile() })
    prefs.write({ theme: 'neon' } as unknown as Partial<AppPrefs>)
    prefs.write({ closeBehavior: 'explode' } as unknown as Partial<AppPrefs>)
    expect(prefs.read()).toEqual({})
  })

  it('文件损坏时读回空偏好（不抛异常）', () => {
    const filePath = tempFile()
    const prefs = new PrefsStore({ filePath })
    prefs.write({ theme: 'apple' })
    // 模拟损坏。
    writeFileSync(filePath, '{ 这不是 JSON', 'utf8')
    expect(prefs.read()).toEqual({})
  })

  it('写入是原子的（不留 .tmp 半成品）', () => {
    const filePath = tempFile()
    const prefs = new PrefsStore({ filePath })
    prefs.write({ theme: 'apple' })
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    expect(existsSync(filePath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 播放器 / 窗口 / 偏好 IPC（追加要求 E）
// ---------------------------------------------------------------------------

describe('registerPlayerIpc', () => {
  /** 假 `ipcMain` 的处理器签名（第二个参数可选，方便直接调用）。 */
  type Handler = (event: unknown, arg?: unknown) => unknown

  /** 假 `ipcMain`：`handle` 收调用器，`on` 收推送监听器。 */
  function fakeIpcMain(): {
    ipcMain: IpcMainEventsLike
    handlers: Map<string, Handler>
    listeners: Map<string, (event: unknown, arg: unknown) => void>
  } {
    const handlers = new Map<string, Handler>()
    const listeners = new Map<string, (event: unknown, arg: unknown) => void>()
    const ipcMain: IpcMainEventsLike = {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      on(channel, listener) {
        listeners.set(channel, listener)
      },
    }
    return { ipcMain, handlers, listeners }
  }

  it('注册了全部通道（含 Task 10 的悬浮歌词通道、Task 11 的下载通道、Task 12 的 FFmpeg 通道、Task 41 的外部链接通道、Task 45 的词岛样式通道与 Task 47 的频谱通道）', () => {
    // ⚠️ T10（桌面悬浮歌词）新增了两个通道，T11（本地下载）又新增了四个，
    //    T12（FFmpeg 兜底解码）再新增两个：
    //    - `lyric:set-visible`（调用式）：开关悬浮窗；
    //    - `lyric:state`（推送式）：主进程只转发歌词消息；
    //    - `download:list` / `download:start` / `download:cancel` / `download:clear`
    //      （调用式）：本地下载的索引、启动、取消、清空。
    //    - `ffmpeg:status` / `ffmpeg:fallback`（调用式）：探测 FFmpeg、请求兜底转码。
    //    → 原来的「全部八个通道」前提被这三个任务推翻，这里改写为**新的完整集合**。
    //
    // ⚠️ T41（软件信息）又新增一个：
    //    - `app:open-external`（调用式）：用系统默认浏览器打开白名单里的官网。
    //      （渲染层**不能**自己开网页 → 主窗口没配 `setWindowOpenHandler`，
    //        链接会把应用窗口整个导航走。）
    //    → 前提再次被推翻，这里**继续**改写为新的完整集合（不是放宽断言）。
    //
    // ⚠️ T45（灵动态词岛）又新增一个：
    //    - `lyric:set-mode`（调用式）：切换桌面歌词的样式
    //      （`classic` 经典悬浮窗 / `island` 灵动词岛）。
    //    → 前提再次被推翻，这里**继续**改写为新的完整集合（不是放宽断言）。
    //
    // ⚠️ T47（频谱波形）又新增一个：
    //    - `lyric:spectrum`（推送式）：主窗口渲染进程推频谱 → 主进程只转发给词岛窗。
    //    → 前提再次被推翻，这里**继续**改写为新的完整集合（不是放宽断言）。
    //
    // ⚠️ T82（外壳收尾）又新增一个：
    //    - `app:version`（调用式）：把**当前版本号**给渲染层
    //      （渲染层是 sandbox，读不到 `package.json` ⇒ 版本号只能主进程给）。
    //    → 前提再次被推翻，这里**继续**改写为新的完整集合（不是放宽断言）。
    const { ipcMain, handlers, listeners } = fakeIpcMain()
    registerPlayerIpc({ ipcMain, prefs: new PrefsStore({ filePath: tempFile() }) })
    expect([...handlers.keys()].sort()).toEqual([
      'app:open-external',
      'app:version',
      'download:cancel',
      'download:clear',
      'download:list',
      'download:start',
      'ffmpeg:fallback',
      'ffmpeg:status',
      'lyric:set-mode',
      'lyric:set-visible',
      'prefs:get',
      'prefs:set',
      'theme:set',
      'win:close',
      'win:minimize',
      'win:toggle-maximize',
    ])
    expect([...listeners.keys()].sort()).toEqual([
      'lyric:spectrum',
      'lyric:state',
      'player:command',
      'player:state',
    ])
  })

  it('app:open-external：白名单里的官网 → 交给系统浏览器打开', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      openExternal,
    })

    const handler = handlers.get('app:open-external')
    expect(handler).toBeTruthy()
    await expect(handler?.({}, 'https://www.sanlos.cn')).resolves.toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://www.sanlos.cn')
  })

  it('app:open-external：不在白名单的地址 → **拒绝**（一次都不调）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      openExternal,
    })

    const handler = handlers.get('app:open-external')
    await expect(handler?.({}, 'https://example.com')).resolves.toBe(false)
    await expect(handler?.({}, 'http://www.sanlos.cn')).resolves.toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('download:list 是调用：返回索引 + 任务 + 下载目录', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const entries = {
      'song-1': {
        songId: 'song-1',
        file: 'C:\\Music\\a.flac',
        bytes: 100,
        ext: 'flac',
        downloadedAt: '2026-01-01T00:00:00.000Z',
      },
    }
    const downloads = {
      list: () => ({ entries, tasks: [] }),
      start: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(async () => undefined),
      getDir: () => 'C:\\Music\\飞牛音乐',
    }
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      downloads,
    })

    const result = await handlers.get('download:list')?.(undefined)
    expect(result).toEqual({ entries, tasks: [], dir: 'C:\\Music\\飞牛音乐' })
  })

  it('download:start 是调用：形状对的请求交给下载控制器；songId 为空则**不下载**', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const start = vi.fn()
    const downloads = {
      list: () => ({ entries: {}, tasks: [] }),
      start,
      cancel: vi.fn(),
      clear: vi.fn(async () => undefined),
      getDir: () => 'C:\\Music',
    }
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      downloads,
    })

    await handlers.get('download:start')?.(undefined, {
      songId: 'song-1',
      title: '示例歌名',
      artist: '示例歌手',
      ext: 'flac',
    })
    expect(start).toHaveBeenCalledWith({
      songId: 'song-1',
      title: '示例歌名',
      artist: '示例歌手',
      ext: 'flac',
    })

    // songId 为空 / 形状不对 → **不下载**。
    start.mockClear()
    await handlers.get('download:start')?.(undefined, { songId: '', title: 'x' })
    await handlers.get('download:start')?.(undefined, null)
    expect(start).not.toHaveBeenCalled()
  })

  it('download:cancel / download:clear 是调用：交给下载控制器', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const cancel = vi.fn()
    const clear = vi.fn(async () => undefined)
    const downloads = {
      list: () => ({ entries: {}, tasks: [] }),
      start: vi.fn(),
      cancel,
      clear,
      getDir: () => 'C:\\Music',
    }
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      downloads,
    })

    await handlers.get('download:cancel')?.(undefined, { songId: 'song-1' })
    expect(cancel).toHaveBeenCalledWith('song-1')

    await handlers.get('download:clear')?.(undefined)
    expect(clear).toHaveBeenCalled()
  })

  it('lyric:state 是推送：主进程**只转发**，形状不对的消息被丢弃', () => {
    const { ipcMain, listeners } = fakeIpcMain()
    const onLyricState = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      onLyricState,
    })

    listeners.get('lyric:state')?.(undefined, { kind: 'progress', position: 3, isPlaying: true })
    expect(onLyricState).toHaveBeenCalledWith({ kind: 'progress', position: 3, isPlaying: true })

    // 形状不对 → **丢弃**（不转发给悬浮窗）
    onLyricState.mockClear()
    listeners.get('lyric:state')?.(undefined, { kind: 'bogus' })
    listeners.get('lyric:state')?.(undefined, null)
    expect(onLyricState).not.toHaveBeenCalled()
  })

  it('lyric:spectrum 是推送：主进程**只转发**，形状不对的数据被丢弃', () => {
    const { ipcMain, listeners } = fakeIpcMain()
    const onSpectrum = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      onSpectrum,
    })

    const bins = new Array<number>(SPECTRUM_BIN_COUNT).fill(0).map((_, index) => index * 15)
    listeners.get('lyric:spectrum')?.(undefined, bins)
    expect(onSpectrum).toHaveBeenCalledWith(bins)

    // 形状不对 → **丢弃**（不转发给词岛窗；主进程**不修补**数据）
    onSpectrum.mockClear()
    listeners.get('lyric:spectrum')?.(undefined, [1, 2, 3])
    listeners.get('lyric:spectrum')?.(undefined, null)
    listeners.get('lyric:spectrum')?.(undefined, new Array<number>(SPECTRUM_BIN_COUNT).fill(999))
    expect(onSpectrum).not.toHaveBeenCalled()
  })

  it('lyric:set-visible 是调用：交给主进程去创建 / 隐藏窗口', () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const setLyricVisible = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      setLyricVisible,
    })

    handlers.get('lyric:set-visible')?.(undefined, true)
    expect(setLyricVisible).toHaveBeenCalledWith(true)

    setLyricVisible.mockClear()
    handlers.get('lyric:set-visible')?.(undefined, 'yes')
    // 只有 `true` 算「开」，其余一律按「关」处理
    expect(setLyricVisible).toHaveBeenCalledWith(false)
  })

  it('lyric:set-mode 是调用：把桌面歌词样式交给主进程去切换窗口（T45）', () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const setLyricMode = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      setLyricMode,
    })

    handlers.get('lyric:set-mode')?.(undefined, 'island')
    expect(setLyricMode).toHaveBeenCalledWith('island')

    setLyricMode.mockClear()
    handlers.get('lyric:set-mode')?.(undefined, 'classic')
    expect(setLyricMode).toHaveBeenCalledWith('classic')

    setLyricMode.mockClear()
    // 形状不对 → **一律按 'classic' 处理**（不抛、不当成 island）
    handlers.get('lyric:set-mode')?.(undefined, 'nope')
    handlers.get('lyric:set-mode')?.(undefined, undefined)
    handlers.get('lyric:set-mode')?.(undefined, 42)
    expect(setLyricMode).toHaveBeenCalledTimes(3)
    expect(setLyricMode).toHaveBeenLastCalledWith('classic')
  })

  it('player:state 是推送：渲染进程推来 → 主进程消费（更新托盘）', () => {
    const { ipcMain, listeners } = fakeIpcMain()
    const onPlayerState = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      onPlayerState,
    })
    listeners.get('player:state')?.(undefined, state())
    expect(onPlayerState).toHaveBeenCalledTimes(1)
    const snapshot = onPlayerState.mock.calls[0]?.[0] as PlayerStateSnapshot
    expect(snapshot.current?.title).toBe('歌一')
    expect(snapshot.isPlaying).toBe(true)
  })

  it('player:state 的载荷会被净化（非法字段不进来）', () => {
    const { ipcMain, listeners } = fakeIpcMain()
    const onPlayerState = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      onPlayerState,
    })
    listeners.get('player:state')?.(undefined, { current: 'not-an-object', isPlaying: 'yes', mode: 'weird' })
    const snapshot = onPlayerState.mock.calls[0]?.[0] as PlayerStateSnapshot
    expect(snapshot.current).toBeNull()
    expect(snapshot.isPlaying).toBe(false)
    expect(snapshot.mode).toBe('sequence')
  })

  it('player:command 由主进程转发回渲染进程（唯一的命令路由）', () => {
    const { ipcMain, listeners } = fakeIpcMain()
    const send = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      getTarget: () => ({ send }),
    })
    listeners.get('player:command')?.(undefined, { type: 'toggle' })
    expect(send).toHaveBeenCalledWith('player:command', { type: 'toggle' })
  })

  it('非法的命令被丢弃（不转发）', () => {
    const { ipcMain, listeners } = fakeIpcMain()
    const send = vi.fn()
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      getTarget: () => ({ send }),
    })
    listeners.get('player:command')?.(undefined, { type: 'rm-rf' })
    listeners.get('player:command')?.(undefined, null)
    expect(send).not.toHaveBeenCalled()
  })

  it('prefs:get / prefs:set / theme:set 走 prefs.json', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = new PrefsStore({ filePath: tempFile() })
    registerPlayerIpc({ ipcMain, prefs })

    const setTheme = handlers.get('theme:set')
    await setTheme?.(undefined, 'fluent')
    expect(prefs.read().theme).toBe('fluent')

    const get = handlers.get('prefs:get')
    const result = (await get?.(undefined)) as AppPrefs
    expect(result.theme).toBe('fluent')

    const set = handlers.get('prefs:set')
    await set?.(undefined, { closeBehavior: 'quit' })
    expect(prefs.read().closeBehavior).toBe('quit')
  })

  it('theme:set 遇到非法主题名抛可读错误', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    registerPlayerIpc({ ipcMain, prefs: new PrefsStore({ filePath: tempFile() }) })
    const setTheme = handlers.get('theme:set')
    await expect(setTheme?.(undefined, 'neon')).rejects.toThrow(/主题名无效/)
  })

  it('win:* 控制窗口', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const win = {
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false),
      hide: vi.fn(),
      close: vi.fn(),
      isDestroyed: () => false,
    }
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      getWindow: () => win,
    })

    await handlers.get('win:minimize')?.(undefined)
    expect(win.minimize).toHaveBeenCalledTimes(1)

    await handlers.get('win:toggle-maximize')?.(undefined)
    expect(win.maximize).toHaveBeenCalledTimes(1)

    win.isMaximized.mockReturnValue(true)
    await handlers.get('win:toggle-maximize')?.(undefined)
    expect(win.unmaximize).toHaveBeenCalledTimes(1)
  })

  it('win:close 走 requestClose（默认只是隐藏，播放继续）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const requestClose = vi.fn()
    const win = {
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      isMaximized: vi.fn(() => false),
      hide: vi.fn(),
      close: vi.fn(),
      isDestroyed: () => false,
    }
    registerPlayerIpc({
      ipcMain,
      prefs: new PrefsStore({ filePath: tempFile() }),
      getWindow: () => win,
      requestClose,
    })
    await handlers.get('win:close')?.(undefined)
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(win.hide).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 命令类型（编译期契约）
// ---------------------------------------------------------------------------

describe('PlayerCommand', () => {
  it('覆盖播放 / 暂停 / 上一首 / 下一首 / 定位', () => {
    const commands: PlayerCommand[] = [
      { type: 'play' },
      { type: 'pause' },
      { type: 'toggle' },
      { type: 'next' },
      { type: 'prev' },
      { type: 'seek', seconds: 12 },
    ]
    expect(commands.map((c) => c.type)).toEqual([
      'play',
      'pause',
      'toggle',
      'next',
      'prev',
      'seek',
    ])
  })
})
