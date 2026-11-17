import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PrefsStore, registerLyricIpc, type IpcMainEventsLike } from '../electron/ipc'
import { buildSourceChain, type LyricProvider } from '../electron/lyricProvider'
import {
  defaultExternalLyricFetcher,
  loadLyricEntries,
  type ExternalLyricFetcher,
} from '../src/player/lyricSource'
import type { LyricEntry } from '../src/api/types'

// ---------------------------------------------------------------------------
// T107：「指定源」**怎么流到主进程**（渲染层 → IPC → 源链）
// ---------------------------------------------------------------------------
//
// ⚠️ 这里的每一段都是**单测能覆盖**的：
//    渲染层把源**并进查询对象**（桥的方法只收一个参数）→ IPC 过白名单 →
//    主进程按它建链。
//    「真机上歌词真的换掉了」由 E2E 钉住（`e2e/t107-lyric-override.spec.ts`）。
// ---------------------------------------------------------------------------

/** 匹配用的信息。 */
const TARGET = { title: '占位歌名', artist: '占位歌手', album: '占位专辑', duration: 200 }

/** NAS 接口（空歌词）。 */
const EMPTY_API = {
  async list(): Promise<LyricEntry[]> {
    return []
  },
}

describe('loadLyricEntries：把「指定源」透传给外部取词', () => {
  it('**指定了源** ⇒ 外部取词收到那个源', async () => {
    const seen: (string | undefined)[] = []
    const external: ExternalLyricFetcher = async (_target, source) => {
      seen.push(source)
      return { status: 'not-found' }
    }
    await loadLyricEntries('song-1', TARGET, {
      api: EMPTY_API,
      external,
      sourceOverride: 'kugou',
    })
    expect(seen).toEqual(['kugou'])
  })

  it('**没指定** ⇒ 外部取词收到 undefined（既有行为一字不变）', async () => {
    const seen: (string | undefined)[] = []
    const external: ExternalLyricFetcher = async (_target, source) => {
      seen.push(source)
      return { status: 'not-found' }
    }
    await loadLyricEntries('song-1', TARGET, { api: EMPTY_API, external })
    expect(seen).toEqual([undefined])
  })

  it('`sourceOverride = null` ⇒ 等同「没指定」', async () => {
    const seen: (string | undefined)[] = []
    const external: ExternalLyricFetcher = async (_target, source) => {
      seen.push(source)
      return { status: 'not-found' }
    }
    await loadLyricEntries('song-1', TARGET, {
      api: EMPTY_API,
      external,
      sourceOverride: null,
    })
    expect(seen).toEqual([undefined])
  })
})

describe('defaultExternalLyricFetcher：源要**并进查询对象**', () => {
  it('桥的方法**只收一个参数** ⇒ 源必须并进查询（当第二个实参传会被丢掉）', async () => {
    const received: unknown[] = []
    const scope = globalThis as unknown as {
      fnPlayer?: { fetchExternalLyric?: (query: unknown) => Promise<never> }
    }
    const previous = scope.fnPlayer
    scope.fnPlayer = {
      fetchExternalLyric: async (query: unknown) => {
        received.push(query)
        return { status: 'not-found' } as never
      },
    }
    try {
      const fetcher = defaultExternalLyricFetcher()
      expect(fetcher).not.toBeNull()
      await fetcher?.(TARGET, 'migu')
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({ title: '占位歌名', source: 'migu' })
    } finally {
      scope.fnPlayer = previous
    }
  })

  it('没指定源 ⇒ 查询里**不带** `source` 字段（不多传无用的键）', async () => {
    const received: unknown[] = []
    const scope = globalThis as unknown as {
      fnPlayer?: { fetchExternalLyric?: (query: unknown) => Promise<never> }
    }
    const previous = scope.fnPlayer
    scope.fnPlayer = {
      fetchExternalLyric: async (query: unknown) => {
        received.push(query)
        return { status: 'not-found' } as never
      },
    }
    try {
      const fetcher = defaultExternalLyricFetcher()
      await fetcher?.(TARGET)
      expect(received[0]).not.toHaveProperty('source')
    } finally {
      scope.fnPlayer = previous
    }
  })
})

describe('主进程：源链按「指定源」排头', () => {
  it('指定源排**第一**，其余线上源仍兜底', () => {
    const chain = buildSourceChain('kugou', '')
    expect(chain[0]).toBe('kugou')
    expect(chain).toContain('netease')
    expect(chain.length).toBeGreaterThan(1)
  })
})

describe('registerLyricIpc：渲染层指定的源要过白名单', () => {
  /** 假 `ipcMain`。 */
  function fakeIpcMain(): {
    ipcMain: IpcMainEventsLike
    handlers: Map<string, (event: unknown, arg?: unknown) => unknown>
  } {
    const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, arg?: unknown) => unknown) => {
        handlers.set(channel, handler)
      },
      on: () => undefined,
    } as unknown as IpcMainEventsLike
    return { ipcMain, handlers }
  }

  /** 造一份偏好存储（落在临时目录，绝不写进仓库）。 */
  function makePrefs(source: 'off' | 'netease' | 'custom'): PrefsStore {
    const dir = mkdtempSync(join(tmpdir(), 'fnmusic-t107-ipc-'))
    const store = new PrefsStore({ filePath: join(dir, 'prefs.json') })
    store.write({
      lyric:
        source === 'custom'
          ? { source: 'custom', template: 'https://主进程配的/{title}' }
          : { source },
    })
    return store
  }

  /** 造的 provider（记下调用参数）。 */
  function makeProvider(): LyricProvider & { calls: unknown[][] } {
    const calls: unknown[][] = []
    return {
      calls,
      async fetchExternalLyric(source, template, query) {
        calls.push([source, template, query])
        return { status: 'ok', source, original: '[00:01.00]占位', translation: '' }
      },
    }
  }

  it('渲染层指定**合法源** ⇒ 主进程按它取（而不是全局源）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = makePrefs('netease')
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    await handlers.get('lyric:fetch')?.({}, { ...TARGET, source: 'kugou' })

    expect(provider.calls).toHaveLength(1)
    expect((provider.calls[0] as [string])[0]).toBe('kugou')
  })

  it('渲染层指定**陌生源** ⇒ **丢弃** ⇒ 退回全局源（不是出网代理）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = makePrefs('netease')
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    await handlers.get('lyric:fetch')?.({}, { ...TARGET, source: 'https://evil.example/x' })

    expect(provider.calls).toHaveLength(1)
    expect((provider.calls[0] as [string])[0]).toBe('netease')
  })

  it('渲染层指定 `off` ⇒ **忽略**（那是全局档位，不是「换一个源」）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = makePrefs('custom')
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    await handlers.get('lyric:fetch')?.({}, { ...TARGET, source: 'off' })

    expect(provider.calls).toHaveLength(1)
    expect((provider.calls[0] as [string])[0]).toBe('custom')
  })

  it('渲染层传的**地址/模板依旧被忽略**（安全边界没放宽）', async () => {
    const { ipcMain, handlers } = fakeIpcMain()
    const prefs = makePrefs('custom')
    const provider = makeProvider()
    registerLyricIpc({ ipcMain, prefs, provider })

    await handlers.get('lyric:fetch')?.({}, {
      ...TARGET,
      url: 'https://evil.example/steal',
      template: 'https://evil.example/{title}',
    })

    expect(provider.calls).toHaveLength(1)
    const [, template] = provider.calls[0] as [string, string]
    expect(template).toBe('https://主进程配的/{title}')
  })
})
