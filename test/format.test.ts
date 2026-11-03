import { describe, it, expect } from 'vitest'
import {
  UNDECODABLE_FORMATS,
  describeMediaError,
  formatUnsupportedMessage,
  isChromiumDecodable,
  streamUrl,
  undecodableFormat,
} from '../src/player/format'

// ---------------------------------------------------------------------------
// Task 13：格式判定与流地址
//
// 覆盖：
// - 简报 Step 1 的原始用例（逐字保留其意图）；
// - 控制器追加要求 A（走 fnm:// 代理）/ D（不可解集合、大小写、ext 为空仍判 codec）
//   / I（streamUrl 新建、guid 编码、不带凭据）。
//
// ⚠️ 全部数据都是**虚构占位**（'a' / 'b' / 'track_x'），不含任何真实 FN ID / 账号 / 密码。
// ---------------------------------------------------------------------------

describe('isChromiumDecodable', () => {
  it('mp3/flac/wav 可解，ape/dsf/dts 不可解', () => {
    expect(isChromiumDecodable('MP3', 'mp3')).toBe(true)
    expect(isChromiumDecodable('FLAC', 'flac')).toBe(true)
    expect(isChromiumDecodable('APE', 'ape')).toBe(false)
    expect(isChromiumDecodable('DSD', 'dsf')).toBe(false)
    expect(isChromiumDecodable('DTS', 'dts')).toBe(false)
  })

  it('不可解集合逐项命中（大小写不敏感）', () => {
    for (const fmt of UNDECODABLE_FORMATS) {
      expect(isChromiumDecodable(fmt.toUpperCase(), '')).toBe(false)
      expect(isChromiumDecodable(fmt, '')).toBe(false)
      expect(isChromiumDecodable('', fmt)).toBe(false)
    }
  })

  it('扩展名为空时仍然按 codec 判定（Song 没有 ext 字段）', () => {
    expect(isChromiumDecodable('APE', '')).toBe(false)
    expect(isChromiumDecodable('ALAC', '')).toBe(false)
    expect(isChromiumDecodable('WMA', '')).toBe(false)
  })

  it('扩展名带点 / 大小写混写也能命中', () => {
    expect(isChromiumDecodable('', '.ApE')).toBe(false)
    expect(isChromiumDecodable('', 'DSF')).toBe(false)
  })

  it('常见可解格式不受牵连', () => {
    expect(isChromiumDecodable('MP3', 'mp3')).toBe(true)
    expect(isChromiumDecodable('AAC', 'm4a')).toBe(true)
    expect(isChromiumDecodable('PCM_S16LE', 'wav')).toBe(true)
    expect(isChromiumDecodable('VORBIS', 'ogg')).toBe(true)
    expect(isChromiumDecodable('OPUS', 'opus')).toBe(true)
  })

  it('复合 codec 名按 token 命中（DTS-HD 之类）', () => {
    expect(isChromiumDecodable('DTS-HD', '')).toBe(false)
    expect(isChromiumDecodable('PCM_S16LE', '')).toBe(true)
  })

  it('空 codec 且空 ext 视为可解（不做无依据的拦截）', () => {
    expect(isChromiumDecodable('', '')).toBe(true)
  })
})

describe('undecodableFormat', () => {
  it('命中时返回大写格式名', () => {
    expect(undecodableFormat('ape', '')).toBe('APE')
    expect(undecodableFormat('', 'dsf')).toBe('DSF')
  })

  it('未命中时返回 null', () => {
    expect(undecodableFormat('FLAC', 'flac')).toBeNull()
    expect(undecodableFormat('', '')).toBeNull()
  })

  it('错误文案可读且不含凭证', () => {
    const message = formatUnsupportedMessage('APE')
    expect(message).toContain('APE')
    expect(message).toContain('无法播放')
    expect(message.toLowerCase()).not.toContain('token')
    expect(message.toLowerCase()).not.toContain('cookie')
    expect(message.toLowerCase()).not.toContain('authx')
  })
})

describe('describeMediaError', () => {
  it('网络类错误与媒体类错误可区分', () => {
    expect(describeMediaError(2).kind).toBe('network')
    expect(describeMediaError(1).kind).toBe('network')
    expect(describeMediaError(3).kind).toBe('media')
    expect(describeMediaError(4).kind).toBe('media')
  })

  it('文案可读且不含凭证', () => {
    for (const code of [1, 2, 3, 4, undefined]) {
      const info = describeMediaError(code)
      expect(info.message.length).toBeGreaterThan(0)
      expect(info.message.toLowerCase()).not.toContain('token')
      expect(info.message.toLowerCase()).not.toContain('authx')
    }
  })
})

describe('streamUrl', () => {
  it('产出 fnm:// 代理地址，且不含 /music/api/v1 前缀', () => {
    expect(streamUrl('track_abc')).toBe('fnm://srv/track/stream?guid=track_abc')
  })

  it('guid 里的特殊字符会被编码', () => {
    expect(streamUrl('a b&c')).toBe('fnm://srv/track/stream?guid=a%20b%26c')
    expect(streamUrl('a/b?c')).toBe('fnm://srv/track/stream?guid=a%2Fb%3Fc')
  })

  it('绝不夹带任何凭据（authx / Cookie / token）', () => {
    const url = streamUrl('track_abc')
    expect(url.toLowerCase()).not.toContain('authx')
    expect(url.toLowerCase()).not.toContain('cookie')
    expect(url.toLowerCase()).not.toContain('token')
  })
})
