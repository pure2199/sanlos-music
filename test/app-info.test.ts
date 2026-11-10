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
import { resolveFileUrl, resolveManifestUrl, validateUpdateBaseUrl } from '../electron/update'

describe('软件信息（T41）', () => {
  it('开发者 / 公司 / 官网 / 备案号**齐全**', () => {
    expect(APP_INFO.name).toBe('Sanlos Music')
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

  it('白名单就是那三条，且是**精确匹配**（不做后缀匹配）', () => {
    // ⚠️ T82：加了 `github.com`（项目地址）⇒ **两条变三条**。
    //    「精确匹配、不做后缀匹配」这条鉴别力**一字不变**。
    expect(EXTERNAL_LINK_ALLOWED_HOSTS).toEqual(['sanlos.cn', 'www.sanlos.cn', 'github.com'])
  })
})

// ---------------------------------------------------------------------------
// T82：项目地址 + 自动更新源
// ---------------------------------------------------------------------------

describe('项目地址与更新源（T82）', () => {
  it('项目地址就是 GitHub 仓库，**自己**在白名单里', () => {
    expect(APP_INFO.repository).toBe('https://github.com/pure2199/sanlos-music')
    expect(isAllowedExternalUrl(APP_INFO.repository)).toBe(true)
  })

  it('更新源指向 **latest/download**（永远指向最新那版，发新版不用改代码）', () => {
    expect(APP_INFO.updateBaseUrl).toBe(
      'https://github.com/pure2199/sanlos-music/releases/latest/download',
    )
  })

  it('更新源是**合法的 https 目录地址**（客户端的地址校验放行）', () => {
    expect(validateUpdateBaseUrl(APP_INFO.updateBaseUrl)).not.toBeNull()
  })

  it('更新源的**清单地址** = `<源>/latest.json`（与发布产物同名）', () => {
    expect(resolveManifestUrl(APP_INFO.updateBaseUrl)).toBe(
      'https://github.com/pure2199/sanlos-music/releases/latest/download/latest.json',
    )
  })

  it('清单里的安装包**同源**放行（客户端不许被指到别处）', () => {
    const url = resolveFileUrl(APP_INFO.updateBaseUrl, 'FN-Music-Setup-0.2.1.exe')
    expect(url).toBe(
      'https://github.com/pure2199/sanlos-music/releases/latest/download/FN-Music-Setup-0.2.1.exe',
    )
  })

  it('GitHub 的**其它主机名不放行**（只放行 github.com 本名）', () => {
    expect(isAllowedExternalUrl('https://raw.githubusercontent.com/pure2199/sanlos-music')).toBe(false)
    expect(isAllowedExternalUrl('https://gist.github.com')).toBe(false)
  })

  it('**后缀伪装**一律拒绝（精确匹配）', () => {
    expect(isAllowedExternalUrl('https://github.com.evil.example')).toBe(false)
    expect(isAllowedExternalUrl('https://evil-github.com')).toBe(false)
    expect(isAllowedExternalUrl('https://github.com.co')).toBe(false)
  })
})
