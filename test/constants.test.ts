import { describe, it, expect } from 'vitest'
import {
  SIGN_PREFIX,
  SIGN_KEY,
  FN_SIGN_KEY,
  API_PREFIX,
  MUSIC_PATH,
  FN_CON_API,
  FN_CON_PATH,
  RELAY_COOKIE_MODE,
  RELAY_DOMAIN_SUFFIX,
  MUSIC_TOKEN_COOKIE,
  CODE_OK,
  CODE_TOKEN_EXPIRED,
  EQ_BANDS_10,
  EQ_BANDS_15,
  EQ_PRESETS,
  EQ_Q,
  EQ_GAIN_LIMIT,
} from '../shared/constants'

describe('constants', () => {
  it('签名常量与规格一致', () => {
    expect(SIGN_PREFIX).toBe('NDzZTVxnRKP8Z0jXg1VAMonaG8akvh')
    expect(SIGN_KEY).toBe('6D5602D4-A342-4799-A0F0-BB795E7167D0')
    expect(FN_SIGN_KEY).toBe('zIGtkc3dqZnJpd29qZXJqa2w7c')
  })

  it('EQ 频点表长度正确', () => {
    expect(EQ_BANDS_10).toHaveLength(10)
    expect(EQ_BANDS_15).toHaveLength(15)
    expect(EQ_BANDS_10[0]).toBe(31.5)
    expect(EQ_BANDS_15[15 - 1]).toBe(16000)
  })

  it('EQ 频点表逐点符合标准 ISO 1/1 倍频程', () => {
    expect(EQ_BANDS_10).toEqual([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
    expect(EQ_BANDS_15).toEqual([
      25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
    ])
  })

  it('EQ 滤波器 Q 与增益上限符合规格', () => {
    expect(EQ_Q).toBe(1.41)
    expect(EQ_GAIN_LIMIT).toBe(12)
  })

  it('API 路径常量符合规格', () => {
    expect(API_PREFIX).toBe('/api/v1')
    expect(MUSIC_PATH).toBe('/music')
    expect(FN_CON_API).toBe('https://5ddd.com/api/v1/fn/con')
  })

  it('FN 连接接口签名使用纯路径', () => {
    expect(FN_CON_PATH).toBe('/api/v1/fn/con')
  })

  it('中继链路常量正确（实测修正：域名后缀为 fnos.net）', () => {
    expect(RELAY_COOKIE_MODE).toBe('relay')
    expect(RELAY_DOMAIN_SUFFIX).toBe('.fnos.net')
    expect(MUSIC_TOKEN_COOKIE).toBe('music-token')
  })

  it('业务码常量正确', () => {
    expect(CODE_OK).toBe(0)
    expect(CODE_TOKEN_EXPIRED).toBe(99999)
  })

  it('预置曲线共 10 条且每条增益长度匹配段数', () => {
    expect(Object.keys(EQ_PRESETS)).toEqual([
      'flat',
      'pop',
      'rock',
      'jazz',
      'classical',
      'electronic',
      'acoustic',
      'loudness',
      'vocal',
      'bass-boost',
    ])
    for (const key of Object.keys(EQ_PRESETS)) {
      const preset = EQ_PRESETS[key]
      expect(preset).toBeDefined()
      expect(preset?.label.length).toBeGreaterThan(0)
      expect(preset?.gains).toHaveLength(10)
      expect(preset?.gains15).toHaveLength(15)
    }
  })

  it('预置曲线的 10 段与 15 段增益均在 ±12 dB 内', () => {
    for (const key of Object.keys(EQ_PRESETS)) {
      const preset = EQ_PRESETS[key]
      for (const gain of preset?.gains ?? []) {
        expect(gain).toBeGreaterThanOrEqual(-EQ_GAIN_LIMIT)
        expect(gain).toBeLessThanOrEqual(EQ_GAIN_LIMIT)
      }
      for (const gain of preset?.gains15 ?? []) {
        expect(gain).toBeGreaterThanOrEqual(-EQ_GAIN_LIMIT)
        expect(gain).toBeLessThanOrEqual(EQ_GAIN_LIMIT)
      }
    }
  })
})
