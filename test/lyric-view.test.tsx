// ---------------------------------------------------------------------------
// Task 15：歌词视图（LyricView）
//
// 覆盖简报 Step 1/3 与控制器追加要求 B / D / I：
// - B：双行的精确行为（两行同时在场、上一行走满停在全满态、下一行同时在走、
//   整页走完才换行、两行字号一致等粗）；
// - D：只渲染当前行附近的若干行（DOM 节点数与歌词总量不成正比）；
// - I：单行高亮当前行、双行同时渲染两行、无歌词不崩、无翻译不渲染空行。
//
// ⚠️ 测试数据一律用**占位**（「甲行」「乙行」…），不含真实 FN ID / 账号 / 密码 / 真实歌曲名 / 真实歌词。
// ⚠️ 样式已迁到 `src/ui/lyrics/lyric-view.css`（jsdom 不加载外部样式表，
//    `getComputedStyle` 也不可靠）→ 断言一律用**类名**做钩子，不碰内联 style。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReactElement } from 'react'

import { LyricView, LYRIC_WINDOW_RADIUS } from '../src/ui/lyrics/LyricView'
import { attachTranslations, parseLrc } from '../src/ui/lyrics/parse'
import { PlayerBar, resolveQuality, LOSSLESS_CODECS } from '../src/components/PlayerBar'
import {
  FullPlayerPage,
  clearCoverColorCache,
  extractCoverColor,
  getCachedCoverColor,
} from '../src/pages/FullPlayerPage'
import { createPlayerStore } from '../src/state/playerStore'
import type { PlayerEngineLike } from '../src/player/engine'
import type { PlayerState, PlayMode, Song } from '../shared/types'
import type { LyricEntry } from '../src/api/types'

// ---------------------------------------------------------------------------
// 测试数据（占位）
// ---------------------------------------------------------------------------

/** 把秒数转成 LRC 的 `mm:ss.00` 时间戳。 */
function stamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `[${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}.00]`
}

/** 两行占位歌词：甲行 10~20s、乙行 20~30s。 */
const LINES = parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙')

/** 三行占位歌词：甲行 10~20s、乙行 20~30s、丙行 30~30.5s。 */
const THREE_LINES = parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙\n[00:30.00]丙行丙')

/** 带翻译的两行占位歌词（用 Task 12 的合并入口挂上翻译）。 */
const LINES_WITH_TRANSLATION = attachTranslations(
  parseLrc('[00:10.00]甲行甲\n[00:20.00]乙行乙'),
  parseLrc('[00:10.00]甲译甲\n[00:20.00]乙译乙'),
)

/** 取某个歌词行元素。 */
function lineAt(container: HTMLElement, index: number): HTMLElement {
  const element = container.querySelector(`[data-index="${index}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

/** 去掉「上一行 / 下一行」槽位修饰符后的类名（用来比较两行的样式是否一致）。 */
function withoutSlot(className: string): string {
  return className.replace(/\bfnm-lyricview__line--(previous|next)\b/g, '').trim()
}

/** 仓库根目录（源码断言用）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 歌词视图的源码路径（F15-04 的「key 写在元素上」护栏用）。 */
const LYRIC_VIEW_SOURCE = resolve(REPO_ROOT, 'src/ui/lyrics/LyricView.tsx')

// ---------------------------------------------------------------------------
// F15-04：每一个「数组子节点」都要有**稳定的 key**
// ---------------------------------------------------------------------------

/**
 * 取 DOM 节点对应的 React fiber 的 `key`（`null` = 没有 key）。
 *
 * ⚠️ **为什么不用「捕获 React 告警」当唯一护栏**：
 *    React 18.3 的 key 告警是**按「声明处」去重**的
 *    （`ownerHasKeyUseWarning[声明错误信息]`，见 `react-jsx-dev-runtime` 的
 *    `getDeclarationErrorAddendum` —— 键里含**组件名 + 源码位置**）
 *    → 同一份模块实例里**只报一次** → 排在后面的用例会被「去重成 0 条告警」→ **空过**。
 *    `vi.resetModules()` 也救不了：react / react-dom 是 **externalized** 依赖，
 *    Node 的模块缓存不会被动（实测：resetModules 之后第二次渲染仍然 0 条告警）；
 *    而且去重键含**源码位置**，就算换了模块实例，键也还是同一个。
 *    → fiber 上的 `key` 是**结构性事实**：与告警去重、与用例顺序都**无关**。
 */
function reactKeyOf(element: Element | null): unknown {
  if (!element) return undefined
  const propName = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  if (!propName) return undefined
  const fiber = (element as unknown as Record<string, { key: unknown }>)[propName]
  return fiber?.key
}

/**
 * 探针组件：**故意**渲染一个缺 `key` 的数组。
 *
 * 用途只是**自证「React 的 key 告警机制在本进程里确实在工作」**（否则「没有告警」
 * 也可能是因为告警被整体关掉了）。
 *
 * ⚠️ 它**不能**证明「被测组件的那一格去重表是干净的」：React 18.3 的去重键是
 *    **声明处的错误信息**（组件名 + 源码位置，见 `react-jsx-dev-runtime` 的
 *    `getDeclarationErrorAddendum`）→ 探针与被测组件的键**必然不同**。
 *    → 下面真正**确定性**的护栏是**结构断言**（fiber 上的 key）与**源码断言**。
 */
function MissingKeyProbe(): ReactElement {
  return (
    <div>
      {[<span key="probe-ok">ok</span>, <span>缺 key</span>]}
    </div>
  )
}

describe('LyricView：渲染 key（F15-04）', () => {
  it('单行模式：每一行都有 key（结构性断言，与 React 告警去重无关）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={12} mode="single" />)

    const lines = Array.from(container.querySelectorAll('[data-index]'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // key = 歌词行的**绝对下标**（窗口滚动时行进出数组也不会错位）
      expect(reactKeyOf(line)).toBe(line.getAttribute('data-index'))
    }
  })

  it('带翻译：翻译副行节点也有 key（翻译也是「行」的数组子节点）', () => {
    const { container } = render(
      <LyricView lines={LINES_WITH_TRANSLATION} currentTime={12} mode="single" />,
    )

    const translation = container.querySelector('[data-testid="lyric-translation"]')
    expect(translation).not.toBeNull()
    // ⚠️ **鉴别力**：把翻译节点的 key 去掉 → 这里就是 null → 变红
    expect(reactKeyOf(translation)).not.toBeNull()
  })

  it('onSeek 按钮路径：key 直接写在元素上（不是塞进被展开的 props 对象）', () => {
    const { container } = render(
      <LyricView lines={LINES} currentTime={12} mode="single" onSeek={() => {}} />,
    )

    const button = container.querySelector('[data-index="0"]')
    expect(button?.tagName).toBe('BUTTON')
    expect(reactKeyOf(button)).not.toBeNull()

    // ⚠️ **顺序无关**的护栏：key 必须**直接写在元素上**，不能作为字段放进被 `{...}`
    //    展开的 props 对象（React 18.3 会对后者告警，但那条告警按「类型 + props 形状」
    //    去重 → 与用例顺序耦合 → 不能当唯一护栏）。
    const source = readFileSync(LYRIC_VIEW_SOURCE, 'utf8')
    expect(source).toMatch(/<div[^>]*\bkey=\{/)
    expect(source).toMatch(/<button[^>]*\bkey=\{/)
    expect(source).not.toMatch(/[{,]\s*key\s*:/)
  })

  it('渲染不刷 React 的 key 告警（烟幕断言：确定性护栏是上面的结构断言与源码断言）', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '))
    })
    try {
      // 探针先跑：证明「React 的 key 告警机制在本进程里确实在工作」
      render(<MissingKeyProbe />)
      expect(errors.filter((message) => message.includes('unique "key"')).length).toBeGreaterThan(0)

      errors.length = 0
      render(<LyricView lines={LINES_WITH_TRANSLATION} currentTime={12} mode="single" />)
      expect(errors.filter((message) => message.includes('unique "key"'))).toEqual([])
      expect(errors.filter((message) => message.includes('is being spread into JSX'))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 简报 Step 1 的两条用例
// ---------------------------------------------------------------------------

describe('LyricView：简报 Step 1', () => {
  it('高亮当前行', () => {
    render(<LyricView lines={LINES} currentTime={12} mode="single" />)
    expect(screen.getByText('甲行甲').className).toMatch(/active/)
  })

  it('双行模式同时渲染两行', () => {
    render(<LyricView lines={LINES} currentTime={12} mode="double" />)
    expect(screen.getByText('甲行甲')).toBeTruthy()
    expect(screen.getByText('乙行乙')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 要求 B：双行的精确行为
// ---------------------------------------------------------------------------

describe('LyricView：双行模式', () => {
  it('上一行走满后停在全满态（该行所有词都处于高亮态，不清空）', () => {
    // 三行歌词：甲行 10~20s、乙行 20~30s、丙行 30~30.5s
    // t=25 时甲行早已唱完（走满），乙行正在唱
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={25} mode="double" />)

    const previous = lineAt(container, 0)
    const words = Array.from(previous.querySelectorAll('[data-word]'))
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) {
      expect(word.className).toMatch(/fnm-lyricview__word--sung/)
    }
  })

  it('下一行同时在走（未唱到的词不高亮）', () => {
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={25} mode="double" />)

    const next = lineAt(container, 1)
    const words = Array.from(next.querySelectorAll('[data-word]'))
    expect(words.length).toBeGreaterThan(0)
    // 至少有一个词已经唱到
    expect(words.some((word) => word.className.match(/fnm-lyricview__word--sung/))).toBe(true)
  })

  it('整页走完才一起换行（下一行走满后两行整体换成新的一页）', () => {
    const { container: before } = render(
      <LyricView lines={THREE_LINES} currentTime={29.9} mode="double" />,
    )
    expect(lineAt(before, 0)).toBeTruthy()
    expect(lineAt(before, 1)).toBeTruthy()

    const { container: after } = render(
      <LyricView lines={THREE_LINES} currentTime={30} mode="double" />,
    )
    // 新的「上一行」= 旧的「下一行」
    expect(lineAt(after, 1)).toBeTruthy()
    expect(lineAt(after, 2)).toBeTruthy()
  })

  it('整页换行有**真信号**（跨越点上暴露页序号）：t=29.9 与 t=30 的页序号不同', () => {
    const { container: before } = render(
      <LyricView lines={THREE_LINES} currentTime={29.9} mode="double" />,
    )
    const { container: after } = render(
      <LyricView lines={THREE_LINES} currentTime={30} mode="double" />,
    )

    const pageIndexOf = (container: HTMLElement): string =>
      container.querySelector('[data-testid="lyric-view"]')?.getAttribute('data-page-index') ?? ''

    expect(pageIndexOf(before)).toBe('0')
    expect(pageIndexOf(after)).toBe('1')
    expect(pageIndexOf(before)).not.toBe(pageIndexOf(after))
  })

  it('两行字号一致、等粗（不把上一行降级成更弱的样子）', () => {
    const { container } = render(<LyricView lines={THREE_LINES} currentTime={25} mode="double" />)

    const previous = lineAt(container, 0)
    const next = lineAt(container, 1)
    // 两行除了「槽位」修饰符外，类名完全一致 → 字号 / 字重来自同一条 CSS 规则
    expect(withoutSlot(previous.className)).toBe(withoutSlot(next.className))
    expect(previous.className).not.toMatch(/dim|muted|weak/)
  })

  it('双行模式只渲染两行（不把整份歌词塞进 DOM）', () => {
    const many = parseLrc(
      Array.from({ length: 500 }, (_, i) => `${stamp(i * 2)}占位行${i}`).join('\n'),
    )
    const { container } = render(<LyricView lines={many} currentTime={100} mode="double" />)

    expect(container.querySelectorAll('[data-index]')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 要求 D：单行模式的性能
// ---------------------------------------------------------------------------

describe('LyricView：单行模式', () => {
  it('只渲染当前行附近的若干行（DOM 节点数与歌词总量不成正比）', () => {
    const many = parseLrc(
      Array.from({ length: 1000 }, (_, i) => `${stamp(i * 2)}占位行${i}`).join('\n'),
    )
    const { container } = render(<LyricView lines={many} currentTime={5} mode="single" />)

    const rendered = container.querySelectorAll('[data-index]')
    expect(rendered.length).toBeLessThanOrEqual(LYRIC_WINDOW_RADIUS * 2 + 1)
    expect(rendered.length).toBeLessThan(20)
  })

  it('当前行居中（滚动位置把当前行放到中间）', () => {
    const many = parseLrc(
      Array.from({ length: 100 }, (_, i) => `${stamp(i * 2)}占位行${i}`).join('\n'),
    )
    const { container } = render(<LyricView lines={many} currentTime={35} mode="single" />)

    const viewport = container.querySelector('[data-testid="lyric-view"]') as HTMLElement
    expect(Number(viewport.getAttribute('data-scroll-top'))).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 要求 I：空态 / 翻译
// ---------------------------------------------------------------------------

describe('LyricView：空态与翻译', () => {
  it('无歌词时不崩（显示可读的空态，不是白屏）', () => {
    render(<LyricView lines={[]} currentTime={12} mode="single" />)
    expect(screen.getByText('暂无歌词')).toBeTruthy()
  })

  it('无歌词时双行模式同样不崩', () => {
    render(<LyricView lines={[]} currentTime={12} mode="double" />)
    expect(screen.getByText('暂无歌词')).toBeTruthy()
  })

  it('没有翻译时不渲染空的翻译行（不渲染空的第二行）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={12} mode="double" />)

    expect(container.querySelectorAll('[data-testid="lyric-translation"]')).toHaveLength(0)
    // 两行歌词仍然在场
    expect(screen.getByText('甲行甲')).toBeTruthy()
    expect(screen.getByText('乙行乙')).toBeTruthy()
  })

  it('有翻译时渲染翻译副行', () => {
    const { container } = render(
      <LyricView lines={LINES_WITH_TRANSLATION} currentTime={12} mode="double" />,
    )

    const translations = container.querySelectorAll('[data-testid="lyric-translation"]')
    expect(translations.length).toBe(2)
    expect(translations[0]?.textContent).toBe('甲译甲')
  })
})

// ---------------------------------------------------------------------------
// 点击定位
// ---------------------------------------------------------------------------

describe('LyricView：点击定位', () => {
  it('给了 onSeek 时点击某一行会回调该行的时间', () => {
    const onSeek = vi.fn()
    const { container } = render(
      <LyricView lines={LINES} currentTime={12} mode="single" onSeek={onSeek} />,
    )

    fireEvent.click(lineAt(container, 1))

    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(20)
  })

  it('没给 onSeek 时不渲染可点按钮（点击不抛异常）', () => {
    const { container } = render(<LyricView lines={LINES} currentTime={12} mode="single" />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 播放条（要求 E / G / L / O）
// ---------------------------------------------------------------------------

/** 造一首占位歌曲。 */
function makeSong(index: number, overrides: Partial<Song> = {}): Song {
  return {
    id: `song-${index}`,
    title: `歌${index}`,
    artist: '甲',
    artistId: '',
    album: '示例专辑',
    albumId: '',
    coverId: '',
    duration: 200,
    favorite: false,
    codec: 'FLAC',
    bitrate: 900,
    sampleRate: 44100,
    bitDepth: 16,
    year: 0,
    trackNo: index,
    discNo: 1,
    ...overrides,
  }
}

/** 假引擎（只记录调用，不碰媒体栈）。 */
class FakeEngine implements PlayerEngineLike {
  state: PlayerState = {
    current: null,
    queue: [],
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    error: null,
  }
  played: Song[] = []
  seeks: number[] = []
  volumes: number[] = []
  pauseCalls = 0
  resumeCalls = 0
  private stateListeners: ((state: PlayerState) => void)[] = []
  private endedListeners: ((song: Song | null) => void)[] = []

  play(song: Song): void {
    this.played.push(song)
    this.state = {
      ...this.state,
      current: song,
      isPlaying: true,
      position: 0,
      duration: song.duration,
      error: null,
    }
    this.emit()
  }

  pause(): void {
    this.pauseCalls += 1
    this.state = { ...this.state, isPlaying: false }
    this.emit()
  }

  resume(): void {
    this.resumeCalls += 1
    this.state = { ...this.state, isPlaying: true }
    this.emit()
  }

  seek(sec: number): void {
    this.seeks.push(sec)
    this.state = { ...this.state, position: sec }
    this.emit()
  }

  setVolume(v: number): void {
    this.volumes.push(v)
    this.state = { ...this.state, volume: v }
    this.emit()
  }

  setQueue(items: Song[]): void {
    this.state = { ...this.state, queue: [...items] }
  }

  setMode(mode: PlayMode): void {
    this.state = { ...this.state, mode }
  }

  onStateChange(cb: (state: PlayerState) => void): void {
    this.stateListeners.push(cb)
  }

  onEnded(cb: (song: Song | null) => void): void {
    this.endedListeners.push(cb)
  }

  emit(): void {
    for (const cb of this.stateListeners) cb(this.state)
  }
}

describe('PlayerBar：播放控制（要求 G / L）', () => {
  it('播放 / 暂停按钮反映 isPlaying，点击触发对应 action', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(makeSong(1))
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('暂停'))
    expect(engine.pauseCalls).toBe(1)

    fireEvent.click(screen.getByLabelText('播放'))
    expect(engine.resumeCalls).toBe(1)
  })

  it('下一首走 store 的 next()', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('下一首'))
    expect(store.getState().current?.title).toBe('歌2')
  })

  it('上一首走 playerStore.prev()：进度 > 3 秒 → 回到本曲开头（不是上一首）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    engine.seek(5) // 进度 > 3 秒
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('上一首'))

    // 仍然是本曲（重播 = 回到本曲开头），引擎被要求重播了一次
    expect(store.getState().current?.title).toBe('歌1')
    expect(engine.played).toHaveLength(2)
  })

  it('上一首：进度 ≤ 3 秒时才真的切到上一首', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[1]!, songs)
    engine.seek(1)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('上一首'))

    expect(store.getState().current?.title).toBe('歌1')
  })
})

describe('PlayerBar：进度条与音量（要求 G）', () => {
  it('拖动进度条：拖动中不 seek，松手才 seek（参数正确）', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(makeSong(1))
    render(<PlayerBar store={store} />)

    const slider = screen.getByLabelText('播放进度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '42' } })

    // 拖动中：只显示预览时间，**不**发 seek
    expect(engine.seeks).toHaveLength(0)
    expect(screen.getByTestId('player-position').textContent).toBe('0:42')

    fireEvent.mouseUp(slider)

    expect(engine.seeks).toEqual([42])
  })

  it('松手一律提交预览位置（**含在滑块外松手**）→ 滑块外松手仍然 seek 到该位置', () => {
    // ⚠️ **口径（控制器裁定）**：松手**一律**提交预览位置，**含在滑块外松手**。
    //    这是主流播放器的行为（HTML5 range / YouTube / Spotify 都是「拖到哪松到哪」）；
    //    原始缺陷是「松手后 UI 停在预览值、实际播放位置却没变」→ 本用例钉住的是
    //    「**松手之后 UI 与播放位置一致**」，不是「滑块外松手不跳转」。
    //    ⚠️ **鉴别力**：去掉 window 级的松手监听 → `seeks` 为空 → 变红。
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    store.getState().playTrack(makeSong(1))
    render(<PlayerBar store={store} />)

    const slider = screen.getByLabelText('播放进度') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '42' } })

    // 松手发生在滑块之外（例如用户把鼠标移出滑块再松开）→ 仍然提交 seek
    fireEvent.mouseUp(window)

    expect(engine.seeks).toEqual([42])
    // 预览态复位（不再是「预览中」的样式）
    expect(screen.getByTestId('player-position').className).not.toContain('preview')
  })

  it('音量变化触发 setVolume 且被钳制在 [0,1]', () => {
    const engine = new FakeEngine()
    const store = createPlayerStore(engine)
    render(<PlayerBar store={store} />)

    const slider = screen.getByLabelText('音量') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.4' } })
    expect(engine.volumes).toContain(0.4)
    expect(store.getState().volume).toBe(0.4)

    fireEvent.change(slider, { target: { value: '9' } })
    expect(store.getState().volume).toBeLessThanOrEqual(1)
    expect(store.getState().volume).toBeGreaterThanOrEqual(0)
  })

  it('EQ 入口可点：点开就是均衡器面板（Task 5 起不再是禁用占位）', () => {
    const store = createPlayerStore(new FakeEngine())
    render(<PlayerBar store={store} />)

    const eq = screen.getByRole('button', { name: 'EQ' })
    // ⚠️ 这里原本断言的是「禁用 + 提示即将支持」——那是 Task 21 留下���**占位**行为，
    //    Task 5 把面板真正挂上之后，这条断言的前提已不成立 → 改成断言新行为。
    expect(eq.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('dialog', { name: '均衡器' })).toBeNull()

    fireEvent.click(eq)
    expect(screen.getByRole('dialog', { name: '均衡器' })).toBeTruthy()
    expect(screen.getByLabelText('预置曲线')).toBeTruthy()
  })
})

describe('PlayerBar：音质标识（要求 E）', () => {
  it('FLAC + 44.1kHz/16bit → 无损（非 Hi-Res）', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { codec: 'FLAC', sampleRate: 44100, bitDepth: 16 }))
    render(<PlayerBar store={store} />)

    expect(screen.getByTestId('player-quality').textContent).toBe('无损')
  })

  it('FLAC + 96kHz/24bit → Hi-Res', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { codec: 'FLAC', sampleRate: 96000, bitDepth: 24 }))
    render(<PlayerBar store={store} />)

    expect(screen.getByTestId('player-quality').textContent).toBe('Hi-Res')
  })

  it('MP3 → 无标识', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { codec: 'MP3', sampleRate: 44100, bitDepth: 16 }))
    render(<PlayerBar store={store} />)

    expect(screen.queryByTestId('player-quality')).toBeNull()
  })

  it('判定是纯函数（不依赖 DOM）：无损集合 + Hi-Res 规则', () => {
    expect(resolveQuality(null)).toBeNull()
    expect(resolveQuality(makeSong(1, { codec: 'MP3' }))).toBeNull()
    expect(resolveQuality(makeSong(1, { codec: 'flac' }))).toBe('lossless') // 大小写不敏感
    expect(resolveQuality(makeSong(1, { codec: 'FLAC', sampleRate: 48000 }))).toBe('hires')
    expect(resolveQuality(makeSong(1, { codec: 'FLAC', bitDepth: 24 }))).toBe('hires')
    expect(LOSSLESS_CODECS.has('FLAC')).toBe(true)
    expect(LOSSLESS_CODECS.has('MP3')).toBe(false)
  })
})

describe('PlayerBar：队列面板（要求 G）', () => {
  it('打开队列面板，显示当前队列，可切换曲目', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))

    expect(screen.getByText('歌1 · 甲')).toBeTruthy()
    fireEvent.click(screen.getByText('歌2 · 甲'))
    expect(store.getState().current?.title).toBe('歌2')
  })

  it('可以从队列里移除一首', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[0]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))
    fireEvent.click(screen.getByLabelText('从队列移除 歌1'))

    expect(store.getState().queue.map((song) => song.title)).toEqual(['歌2'])
  })

  it('移除**当前曲**时切到队列里的**下一首**（不是队列第一首）', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2), makeSong(3)]
    store.getState().playTrack(songs[1]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))
    fireEvent.click(screen.getByLabelText('从队列移除 歌2'))

    expect(store.getState().current?.title).toBe('歌3')
    expect(store.getState().queue.map((song) => song.title)).toEqual(['歌1', '歌3'])
  })

  it('移除当前曲（它在队尾）时回到队列第一首（下一首越界 → 回到开头）', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2)]
    store.getState().playTrack(songs[1]!, songs)
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))
    fireEvent.click(screen.getByLabelText('从队列移除 歌2'))

    expect(store.getState().current?.title).toBe('歌1')
  })

  it('队列只剩一首歌时，移除按钮禁用并给出**可读提示**（不静默无反应）', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1), [makeSong(1)])
    render(<PlayerBar store={store} />)

    fireEvent.click(screen.getByLabelText('播放队列'))

    const remove = screen.getByLabelText('从队列移除 歌1')
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(remove.getAttribute('title')).toContain('只有一首歌')
    expect(screen.getByText('队列里只有一首歌，不能移除')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 全屏播放页（要求 C / F）
// ---------------------------------------------------------------------------

/** 造一条占位歌词条目。 */
function makeEntry(content: string, guid: string): LyricEntry {
  return {
    guid,
    source: 'local',
    content,
    createdAt: null,
    updatedAt: null,
    isLRC: true,
    offset: 0,
  }
}

describe('FullPlayerPage：歌词（要求 C / K）', () => {
  it('没有歌词时显示「暂无歌词」（不白屏、不崩）', async () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    expect(await screen.findByText('暂无歌词')).toBeTruthy()
  })

  it('有歌词时用 Task 12 的 parseLyricEntries 解析并渲染（双行模式）', async () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1))
    const api = {
      list: vi.fn(async () => [
        makeEntry('[00:10.00]甲行甲', 'g1'),
        makeEntry('[00:10.00]甲译甲', 'g2'),
      ]),
    }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    expect(await screen.findByText('甲行甲')).toBeTruthy()
    // 翻译挂在同一行下（Task 12 的合并结果）
    expect(screen.getByTestId('lyric-translation').textContent).toBe('甲译甲')
  })

  it('歌词接口失败时给出可读的错误提示（不崩）', async () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1))
    const api = {
      list: vi.fn(async () => {
        throw new Error('服务器响应异常（HTTP 500）')
      }),
    }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('FullPlayerPage：封面取色（要求 F / N）', () => {
  /** 记录被创建过的图片地址。 */
  let imageSources: string[] = []
  /** 记录设置 `src` **那一刻**的 `crossOrigin`（顺序敏感）。 */
  let crossOriginAtSrc: (string | null)[] = []
  let originalImage: typeof Image
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext

  /** 装上图片 / canvas 的替身。 */
  function stubImage(fail: boolean): void {
    class StubImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      crossOrigin: string | null = null
      set src(value: string) {
        imageSources.push(value)
        crossOriginAtSrc.push(this.crossOrigin)
        setTimeout(() => {
          if (fail) this.onerror?.()
          else this.onload?.()
        }, 0)
      }
      get src(): string {
        return ''
      }
    }
    window.Image = StubImage as unknown as typeof Image
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  }

  beforeEach(() => {
    imageSources = []
    crossOriginAtSrc = []
    originalImage = window.Image
    originalGetContext = HTMLCanvasElement.prototype.getContext
    clearCoverColorCache()
  })

  afterEach(() => {
    window.Image = originalImage
    HTMLCanvasElement.prototype.getContext = originalGetContext
    clearCoverColorCache()
  })

  it('取到色时把颜色写进 CSS 变量（背景由 CSS 变量驱动）', async () => {
    stubImage(false)
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { coverId: 'track_abc' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    await waitFor(() => {
      const style =
        document.querySelector('[data-testid="full-player"]')?.getAttribute('style') ?? ''
      expect(style).toContain('--fnm-fullplayer__tint')
    })
    expect(getCachedCoverColor('track_abc')).toBe('#0a141e')
  })

  it('取色结果按 coverId 缓存（换歌不重算）', async () => {
    stubImage(false)
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { coverId: 'track_abc' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)
    await waitFor(() => {
      expect(getCachedCoverColor('track_abc')).not.toBeUndefined()
    })

    // 换一首歌，但封面 id 不变 → 不再取色
    store.getState().playTrack(makeSong(2, { coverId: 'track_abc' }))
    await waitFor(() => {
      expect(store.getState().current?.title).toBe('歌2')
    })
    expect(imageSources).toHaveLength(1)
  })

  it('取不到色时回退到默认背景（不写 tint 变量，CSS 走语义变量）', async () => {
    stubImage(true)
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1, { coverId: 'track_abc' }))
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)

    await waitFor(() => {
      expect(getCachedCoverColor('track_abc')).toBeNull()
    })
    const style =
      document.querySelector('[data-testid="full-player"]')?.getAttribute('style') ?? ''
    expect(style).not.toContain('--fnm-fullplayer__tint')
  })

  it('extractCoverColor：图片加载失败时解析成 null（回退默认背景）', async () => {
    stubImage(true)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBeNull()
  })

  it('extractCoverColor：取到像素时给出代表色', async () => {
    stubImage(false)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBe('#0a141e')
  })

  it('取色时给封面图片设 crossOrigin=anonymous（**在设 src 之前**）→ canvas 不会被污染', async () => {
    // 封面走 `fnm://` 代理，与页面**跨源** → 不设 crossOrigin 时 canvas 会被污染、
    // `getImageData` 抛安全错误 → 取色永远失败。
    stubImage(false)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBe('#0a141e')

    expect(crossOriginAtSrc).toEqual(['anonymous'])
  })

  it('取色失败时仍然**优雅降级**（解析成 null → 回退 CSS 变量兜底背景）', async () => {
    // 图片加载失败（onerror）→ null
    stubImage(true)
    await expect(extractCoverColor('fnm://srv/cover-test')).resolves.toBeNull()
    // 依然带着 crossOrigin（说明失败不是「没设 crossOrigin」导致的）
    expect(crossOriginAtSrc).toEqual(['anonymous'])
  })
})

// ---------------------------------------------------------------------------
// 全屏播放页：队列移除（与播放条同一套语义）
// ---------------------------------------------------------------------------

describe('FullPlayerPage：队列移除', () => {
  it('移除**当前曲**时切到队列里的**下一首**（不是队列第一首）', () => {
    const store = createPlayerStore(new FakeEngine())
    const songs = [makeSong(1), makeSong(2), makeSong(3)]
    store.getState().playTrack(songs[1]!, songs)
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))
    fireEvent.click(screen.getByLabelText('从队列移除 歌2'))

    expect(store.getState().current?.title).toBe('歌3')
    expect(store.getState().queue.map((song) => song.title)).toEqual(['歌1', '歌3'])
  })

  it('队列只剩一首歌时，移除按钮禁用并给出**可读提示**（不静默无反应）', () => {
    const store = createPlayerStore(new FakeEngine())
    store.getState().playTrack(makeSong(1), [makeSong(1)])
    const api = { list: vi.fn(async () => [] as LyricEntry[]) }

    render(<FullPlayerPage store={store} lyricApi={api} />)
    fireEvent.click(screen.getByRole('button', { name: '队列' }))

    const remove = screen.getByLabelText('从队列移除 歌1')
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(remove.getAttribute('title')).toContain('只有一首歌')
    expect(screen.getByText('队列里只有一首歌，不能移除')).toBeTruthy()
  })
})
