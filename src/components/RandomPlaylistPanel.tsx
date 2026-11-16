// 「随机 20 首」面板（T97）——从**你自己的**曲库随机挑一批歌，组一个临时歌单。
//
// ---------------------------------------------------------------------------
// 这个面板干什么
// ---------------------------------------------------------------------------
// - 点「随机 20 首」⇒ 抽样（`src/api/randomPlaylist.ts`）⇒ 列出这一批；
// - 「播放全部」⇒ 走**既有**播放路径（`onPlay(song, index, list)`，整队 = 这一批）
//   ⇒ **不新增播放路径**；
// - 「换一批」⇒ 再随机一次（页码与页内都重新随机 ⇒ 每次都是不同的一批）；
// - 「存为歌单」⇒ **真的在 NAS 上建一个歌单**并把这批歌加进去
//   （建完由调用方刷新列表并选中它）。
//
// ⚠️ **两类失败分开说**：抽样失败 ⇒「随机失败：…」；存回失败 ⇒「存为歌单失败：…」
//    —— **不假装成功**。
//
// ⚠️ **曲库因人而异**：要几首是**运行时**从**当前账号的**曲库抽的
//    ⇒ 库里没那么多就**如实少给**（面板会说明实际抽到几首）。

import { useCallback, useState, type ReactElement } from 'react'

import type { Song } from '../../shared/types'
import { MAX_PLAYLIST_NAME_LENGTH } from '../api/playlist'
import {
  defaultRandomSampleDeps,
  RANDOM_PLAYLIST_SIZE,
  sampleRandomSongs,
  type RandomSampleDeps,
} from '../api/randomPlaylist'
import { SongList } from './SongList'
import './random-playlist-panel.css'

/** 存回歌单（返回新建歌单的标识；测试可注入）。 */
export type SaveRandomPlaylist = (name: string, songIds: string[]) => Promise<string>

/** `RandomPlaylistPanel` 的属性。 */
export interface RandomPlaylistPanelProps {
  /** 抽样依赖（测试注入；缺省走真实曲库）。 */
  deps?: RandomSampleDeps
  /** 存回歌单（测试注入；缺省由调用方提供）。 */
  save?: SaveRandomPlaylist
  /** 播放回调（整队口径：第三个参数 = 这一批全部的歌）。 */
  onPlay?: (song: Song, index: number, list: Song[]) => void
  /** 存回成功后回调（歌单页据此刷新列表并选中新歌单）。 */
  onSaved?: (playlistId: string) => void
  /** 要几首（缺省 {@link RANDOM_PLAYLIST_SIZE}）。 */
  count?: number
}

/** 默认歌单名（本地时间，如「随机歌单 11月16日 19:12」）。 */
function defaultPlaylistName(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `随机歌单 ${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** 把失败翻译成可读的中文（**不含凭证**）。 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return raw.replace(/^Error:\s*/, '').trim() || '未知原因'
}

/** 「随机 20 首」面板。 */
export function RandomPlaylistPanel({
  deps = defaultRandomSampleDeps,
  save,
  onPlay,
  onSaved,
  count = RANDOM_PLAYLIST_SIZE,
}: RandomPlaylistPanelProps): ReactElement {
  /** 抽到的这一批。 */
  const [songs, setSongs] = useState<Song[]>([])
  /** 抽样在途。 */
  const [loading, setLoading] = useState(false)
  /** 抽样失败（可读中文）。 */
  const [error, setError] = useState<string | null>(null)
  /** 存回在途。 */
  const [saving, setSaving] = useState(false)
  /** 存回失败（可读中文）。 */
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 存回成功的提示。 */
  const [message, setMessage] = useState<string | null>(null)
  /** 存回用的歌单名。 */
  const [name, setName] = useState('')

  /** 歌单名（去掉首尾空白）——**服务端对长度有硬上限**（实测 32 个字符）。 */
  const trimmedName = name.trim()
  /** 名字太长 ⇒ 服务端会拒（`invalid arguments`）⇒ **本地先拦**，别让用户撞英文报错。 */
  const nameTooLong = trimmedName.length > MAX_PLAYLIST_NAME_LENGTH

  /** 抽一批（`replace` 为 false 时不清空旧结果 ⇒ 换一批时界面不闪空）。 */
  const handleRandom = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    setSaveError(null)
    setMessage(null)
    try {
      const picked = await sampleRandomSongs(deps, { count })
      setSongs(picked)
      // ⚠️ 名字**只在第一次生成时**预填（换一批不该把用户改过的名字冲掉）。
      setName((current) => (current.trim() === '' ? defaultPlaylistName() : current))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
    // ⚠️⚠️ 依赖里**必须有 `songs`**：漏了它 ⇒ 闭包永远拿到**初始的** `songs = []`
    //    ⇒ 任何「拿上一批糊弄」的写法在闭包里都看不出差别 ⇒ **测试会假绿**
    //    （变异自证实测踩到过）。
  }, [count, deps, songs])

  /** 播放这一批（整队 = 这一批 ⇒ 连播不会跳出这一批）。 */
  const handlePlayAll = useCallback((): void => {
    const first = songs[0]
    if (!first) return
    onPlay?.(first, 0, songs)
  }, [onPlay, songs])

  /** 存回 NAS 歌单。 */
  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setSaveError('请填写歌单名称')
      return
    }
    // ⚠️ **服务端实测**：`/playlist/create` 的名字**超过 32 个字符就被拒**
    //    （`code=100002` / `invalid arguments`）⇒ 本地先拦，给中文提示。
    if (trimmed.length > MAX_PLAYLIST_NAME_LENGTH) {
      setSaveError(`歌单名不能超过 ${MAX_PLAYLIST_NAME_LENGTH} 个字符（现在 ${trimmed.length} 个）`)
      return
    }
    if (!save) {
      setSaveError('当前环境不支持保存歌单')
      return
    }
    setSaving(true)
    setSaveError(null)
    setMessage(null)
    try {
      const playlistId = await save(trimmed, songs.map((song) => song.id))
      setMessage(`歌单「${trimmed}」已保存（${songs.length} 首）`)
      onSaved?.(playlistId)
    } catch (err) {
      setSaveError(describeError(err))
    } finally {
      setSaving(false)
    }
  }, [name, onSaved, save, songs])

  return (
    <div className="fnm-random">
      <div className="fnm-random__head">
        <div>
          <h2 className="fnm-random__title">{`随机 ${count} 首`}</h2>
          <p className="fnm-random__hint">
            {songs.length > 0
              ? `从你的曲库随机挑了 ${songs.length} 首`
              : '从你的曲库随机挑几首，能直接播，也能存成歌单'}
          </p>
        </div>
        <div className="fnm-random__actions">
          <button
            type="button"
            className="fnm-random__button fnm-random__button--primary"
            onClick={() => void handleRandom()}
            disabled={loading}
          >
            {loading ? '正在随机…' : songs.length > 0 ? '换一批' : `随机 ${count} 首`}
          </button>
          {songs.length > 0 && (
            <button
              type="button"
              className="fnm-random__button"
              onClick={handlePlayAll}
              disabled={loading}
            >
              播放全部
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="fnm-random__error" role="alert">
          {`随机失败：${error}`}
        </p>
      )}

      {songs.length > 0 && (
        <>
          <div className="fnm-random__save">
            <input
              className="fnm-random__name"
              name="fnm-random-playlist-name"
              type="text"
              placeholder="存成歌单的名字"
              aria-label="随机歌单名称"
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              className="fnm-random__button"
              onClick={() => void handleSave()}
              disabled={saving || trimmedName.length === 0 || nameTooLong}
            >
              {saving ? '正在保存…' : '存为歌单'}
            </button>
          </div>
          {nameTooLong && (
            <p className="fnm-random__error" role="alert">
              {`歌单名不能超过 ${MAX_PLAYLIST_NAME_LENGTH} 个字符（现在 ${trimmedName.length} 个）`}
            </p>
          )}
          {saveError && (
            <p className="fnm-random__error" role="alert">
              {`存为歌单失败：${saveError}`}
            </p>
          )}
          {message && (
            <p className="fnm-random__message" role="status">
              {message}
            </p>
          )}
          <SongList
            songs={songs}
            onPlay={onPlay ?? (() => undefined)}
            total={songs.length}
            loading={loading}
            emptyLabel="没有随机到歌曲"
            ariaLabel="随机歌单列表"
          />
        </>
      )}
    </div>
  )
}
