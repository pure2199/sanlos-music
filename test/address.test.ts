// ---------------------------------------------------------------------------
// T18-1 回归：服务器地址的端口补全规则
//
// ---------------------------------------------------------------------------
// 真机实测缺陷
// ---------------------------------------------------------------------------
// 手动地址模式填中继域名 `https://<fnid>.fnos.net`（**不写端口**）时，
// 客户端会把它补成 `https://<fnid>.fnos.net:5667` → 中继只监听标准 HTTPS 端口（443），
// **不监听** fnOS 音乐服务的 5666 / 5667 → 登录必然失败：
//   「无法连接音乐服务（网络不可达或服务未响应）」
//
// 而 FN ID 探测路径是通的（候选地址原样使用）——两条路行为不一致。
//
// 本文件钉住补端口的**五条规则**：
//   1. 只有用户输入的地址补端口（探测候选原样使用）；
//   2. 显式端口原样保留；
//   3. 中继域名不补端口，且协议归一到 HTTPS；
//   4. userinfo 与端口无关，剥除规则不受影响；
//   5. **T43**：**只有 IP 字面量**才补默认端口；**域名**走标准端口（80 / 443）
//      ——真机实测：自建反向代理只听 443，补 5666 / 5667 必然连不上。
//
// ⚠️ 测试里用 `example-fn-id` / `nas.local` / `fnos.example-ink.test` 这类
//    **占位域名**，不写真实 FN ID，也不写真实用户域名。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { withDefaultPort, stripUserInfo } from '../src/lib/address'
import { DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT } from '../shared/constants'

describe('withDefaultPort（T18-1）', () => {
  it('中继域名不补默认端口（否则连不上 443 之外的中继）', () => {
    // 关键回归：以前这里会变成 `https://example-fn-id.fnos.net:5667`。
    expect(withDefaultPort('https://example-fn-id.fnos.net')).toBe('https://example-fn-id.fnos.net')
  })

  it('中继域名即使写成 http 也归一到 https（中继只提供 HTTPS）', () => {
    expect(withDefaultPort('http://example-fn-id.fnos.net')).toBe('https://example-fn-id.fnos.net')
  })

  it('中继域名带 userinfo 时同样不补端口，且 userinfo 仍可被剥除', () => {
    expect(withDefaultPort('https://user:pw@example-fn-id.fnos.net')).toBe(
      'https://user:pw@example-fn-id.fnos.net',
    )
    expect(stripUserInfo(withDefaultPort('https://user:pw@example-fn-id.fnos.net'))).toBe(
      'https://example-fn-id.fnos.net',
    )
  })

  it('中继域名显式写了端口就原样保留', () => {
    expect(withDefaultPort('https://example-fn-id.fnos.net:443')).toBe(
      'https://example-fn-id.fnos.net:443',
    )
    expect(withDefaultPort('https://example-fn-id.fnos.net:8443')).toBe(
      'https://example-fn-id.fnos.net:8443',
    )
  })

  it('**IP 地址**仍按协议补默认端口（直连 NAS 的既有行为不变）', () => {
    expect(withDefaultPort('192.168.1.2')).toBe(`http://192.168.1.2:${DEFAULT_HTTP_PORT}`)
    expect(withDefaultPort('http://192.168.1.2')).toBe(`http://192.168.1.2:${DEFAULT_HTTP_PORT}`)
    expect(withDefaultPort('https://192.168.1.2')).toBe(`https://192.168.1.2:${DEFAULT_HTTPS_PORT}`)
  })

  it('**域名地址**不补端口（走标准端口；反代 / 公网入口只听 443）', () => {
    // ⚠️ T43 真机实测：自建反向代理（openresty + 泛域名证书）**只监听 443**，
    //    **不监听** 5666 / 5667 → 补默认端口必然 ECONNREFUSED。
    expect(withDefaultPort('fnos.example-ink.test')).toBe('http://fnos.example-ink.test')
    expect(withDefaultPort('http://fnos.example-ink.test')).toBe('http://fnos.example-ink.test')
    expect(withDefaultPort('https://fnos.example-ink.test')).toBe('https://fnos.example-ink.test')
  })

  it('IPv6 字面量也算 IP → 仍按协议补默认端口', () => {
    expect(withDefaultPort('[::1]')).toBe(`http://[::1]:${DEFAULT_HTTP_PORT}`)
    expect(withDefaultPort('https://[fd00::1]')).toBe(`https://[fd00::1]:${DEFAULT_HTTPS_PORT}`)
  })

  it('域名带 userinfo 时不补端口，userinfo 仍可被剥除', () => {
    expect(withDefaultPort('https://user:pw@fnos.example-ink.test')).toBe(
      'https://user:pw@fnos.example-ink.test',
    )
    expect(stripUserInfo(withDefaultPort('https://user:pw@fnos.example-ink.test'))).toBe(
      'https://fnos.example-ink.test',
    )
  })

  it('显式端口原样保留（端口一个字符都不改）', () => {
    expect(withDefaultPort('http://nas.local:1234')).toBe('http://nas.local:1234')
    expect(withDefaultPort('http://nas.local:80')).toBe('http://nas.local:80')
    expect(withDefaultPort('https://nas.local:443')).toBe('https://nas.local:443')
  })

  it('路径与查询串在补端口时保持不变', () => {
    expect(withDefaultPort('http://192.168.1.2/nas')).toBe(
      `http://192.168.1.2:${DEFAULT_HTTP_PORT}/nas`,
    )
    expect(withDefaultPort('http://192.168.1.2/nas?a=1')).toBe(
      `http://192.168.1.2:${DEFAULT_HTTP_PORT}/nas?a=1`,
    )
    // ⚠️ T43：域名不补端口时，路径与查询串同样原样保留。
    expect(withDefaultPort('http://nas.local/nas?a=1')).toBe('http://nas.local/nas?a=1')
  })

  it('非 http/https 协议原样返回', () => {
    expect(withDefaultPort('ftp://nas.local')).toBe('ftp://nas.local')
    expect(withDefaultPort('ws://nas.local')).toBe('ws://nas.local')
  })

  it('空串原样返回', () => {
    expect(withDefaultPort('')).toBe('')
    expect(withDefaultPort('   ')).toBe('')
  })
})
