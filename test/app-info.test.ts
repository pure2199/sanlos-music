// ---------------------------------------------------------------------------
// T41：软件信息 + 外部链接白名单
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么白名单要单测**：官网链接是**唯一**一处「渲染层能让主进程去打开
//    外部地址」的地方 → 白名单一旦破了，渲染层就能让主进程打开任意站点
//    （钓鱼、恶意页面）。规则**全部**钉死，不靠「以后注意」。
//
// ⚠️ **规则是「精确匹配」**：白名单里的域名必须**完全相等**
//    → `sanlos.cn.evil.example` / `evil-sanlos.cn` 都不放行。
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'

import { APP_INFO, EXTERNAL_LINK_ALLOWED_HOSTS, isAllowedExternalUrl } from '../shared/appInfo'

describe('软件信息（T41）', () => {
  it('开发者 / 公司 / 官网 / 备案号**齐全**', () => {
    expect(APP_INFO.name).toBe('Sanlos music')
    expect(APP_INFO.developer).toBe('pure2199')
    expect(APP_INFO.company).toBe('广西闪链时空网络科技有限公司')
    expect(APP_INFO.website).toBe('https://www.sanlos.cn')
    expect(APP_INFO.icp).toBe('桂ICP备202507161号-1')
  })

  it('官网**自己**就在白名单里（白名单跟软件信息不许对不上）', () => {
    expect(isAllowedExternalUrl(APP_INFO.website)).toBe(true)
  })
})

describe('外部链接白名单（T41）', () => {
  it('白名单里的 https 域名放行', () => {
    expect(isAllowedExternalUrl('https://www.sanlos.cn')).toBe(true)
    expect(isAllowedExternalUrl('https://sanlos.cn')).toBe(true)
    expect(isAllowedExternalUrl('https://www.sanlos.cn/about')).toBe(true)
    expect(isAllowedExternalUrl('  https://www.sanlos.cn  ')).toBe(true)
  })

  it('别的域名一律拒绝', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(false)
    expect(isAllowedExternalUrl('https://www.sanlos.cn.evil.example')).toBe(false)
    expect(isAllowedExternalUrl('https://evil-sanlos.cn')).toBe(false)
    expect(isAllowedExternalUrl('https://sanlos.cn.co')).toBe(false)
  })

  it('非 https 一律拒绝（http / file / javascript / data）', () => {
    expect(isAllowedExternalUrl('http://www.sanlos.cn')).toBe(false)
    expect(isAllowedExternalUrl('file:///C:/Windows')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('data:text/html,<h1>x</h1>')).toBe(false)
  })

  it('带账号密码 / 非默认端口 / 残缺 URL 都拒绝', () => {
    expect(isAllowedExternalUrl('https://user:pass@www.sanlos.cn')).toBe(false)
    expect(isAllowedExternalUrl('https://www.sanlos.cn:8443')).toBe(false)
    expect(isAllowedExternalUrl('www.sanlos.cn')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('   ')).toBe(false)
  })

  it('白名单就是那两条，且是**精确匹配**（不做后缀匹配）', () => {
    expect(EXTERNAL_LINK_ALLOWED_HOSTS).toEqual(['sanlos.cn', 'www.sanlos.cn'])
  })
})
