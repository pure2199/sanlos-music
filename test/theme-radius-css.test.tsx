// ---------------------------------------------------------------------------
// T51：两套主题的**形状适配** —— 圆角令牌化 + 中继提示挪位
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这一层契约**：T51 之前的 **60 多处圆角是硬编码的**
//    （`border-radius: 6px` / `999px` …）→ 两套主题**长得一模一样**
//    （Windows 11 风一点也不方正）；另有 5 处**胶囊**压根不跟主题走。
//    这些承诺**全在 CSS 里** → jsdom 量不到布局与样式 → 只能钉**声明**。
//
// ⚠️ **契约测试要先剥注释再匹配**（否则匹配到的是注释正文 = 空断言）。
//
// ⚠️ **不许出现硬编码圆角**：圆角一律走 `var(--radius-*)` 令牌 ——
//    否则「两套主题各自成套」这条承诺会在下一次改样式时被悄悄抹平。
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, cleanup } from '@testing-library/react'

import { RelayHint } from '../src/components/RelayHint'
import { useSessionStore } from '../src/state/sessionStore'

/** 读 CSS 并**剥掉注释**（剥完再匹配，否则会匹配到注释正文）。 */
function readCss(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 读**绝对路径**的 CSS 并剥掉注释。 */
function readCssFile(absPath: string): string {
  return readFileSync(absPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 递归列出 `src/` 下所有 css 文件（相对仓库根的路径，用 `/` 分隔）。 */
function listCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listCssFiles(full, out)
    else if (entry.name.endsWith('.css')) out.push(full.split('\\').join('/'))
  }
  return out
}

/** 取某条选择器的**块内声明**。 */
function blockOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

const SRC_DIR = join(__dirname, '..', 'src')

describe('圆角令牌化（T51）', () => {
  const tokensCss = readCss('src', 'styles', 'tokens.css')
  const fluentBlock = blockOf(tokensCss, "[data-theme='fluent']")

  it('src 下的 css **不再有硬编码圆角**（一律走 var(--radius-*) 令牌）', () => {
    const offenders: string[] = []
    for (const file of listCssFiles(SRC_DIR)) {
      const css = readCssFile(file)
      // ⚠️ 剥完注释再扫（注释里可以写示例值）。
      const matches = css.matchAll(/border(?:-[a-z]+)*-radius:\s*([^;]+);/g)
      for (const match of matches) {
        const value = (match[1] ?? '').trim()
        // 只允许 `var(...)`；数字 / 百分号 / 颜色一律算硬编码。
        if (!/^var\(--radius-[a-z-]+(,\s*[^)]+)?\)$/.test(value)) {
          offenders.push(`${file.split('/').slice(-2).join('/')} → ${value}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('圆角令牌**两套主题都齐全**（Apple 风 / Fluent 风各有一套）', () => {
    for (const token of ['--radius-pill', '--radius-panel', '--radius-card', '--radius-control', '--radius-field', '--radius-sharp']) {
      expect(tokensCss).toMatch(new RegExp(`${token}:`))
      expect(fluentBlock).toMatch(new RegExp(`${token}:`))
    }
  })

  it('**两套主题的圆角真的不同**（不是同一套值抄两遍）', () => {
    const read = (block: string, token: string): string =>
      new RegExp(`${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? ''

    // 胶囊：Apple 风圆润（999px）↔ Fluent 风方正（4px）。
    expect(read(tokensCss, '--radius-pill')).toBe('999px')
    expect(read(fluentBlock, '--radius-pill')).toBe('4px')
    // 小控件 / 输入框 / 极小方控件：Apple 风圆一点，Fluent 风方正。
    expect(read(tokensCss, '--radius-control')).toBe('6px')
    expect(read(fluentBlock, '--radius-control')).toBe('4px')
    expect(read(tokensCss, '--radius-field')).toBe('8px')
    expect(read(fluentBlock, '--radius-field')).toBe('4px')
    expect(read(tokensCss, '--radius-sharp')).toBe('4px')
    expect(read(fluentBlock, '--radius-sharp')).toBe('2px')
  })

  it('词岛的胶囊**不跟主题走**（否则 Windows 11 风下词岛变成方块）', () => {
    const islandCss = readCss('src', 'island', 'island-window.css')
    // ⚠️ 词岛本体必须用 `--radius-island`（固定 999px）。
    expect(blockOf(islandCss, '.fnm-island')).toMatch(/border-radius:\s*var\(--radius-island/)
    // ⚠️ **两套主题的值都必须是 999px**：
    //    Fluent 组里若写成 4px → 词岛在 Windows 11 风下**变成方块**
    //    （真机实测：屏幕顶部一个白色大矩形，完全没有「岛」的形状）。
    expect(tokensCss).toMatch(/--radius-island:\s*999px/)
    expect(fluentBlock).toMatch(/--radius-island:\s*999px/)
  })
})

describe('中继带宽提示挪到页面内容区（T51）', () => {
  const badgeCss = readCss('src', 'components', 'connection-badge.css')

  afterEach(() => {
    cleanup()
    useSessionStore.getState().setConnection(null)
  })

  it('徽标里**不再有**带宽提示（提示不再把徽标撑到 320px 宽）', () => {
    expect(badgeCss).not.toMatch(/\.fnm-badge__hint/)
    expect(readCss('src', 'components', 'ConnectionBadge.tsx')).not.toMatch(/fnm-badge__hint/)
  })

  it('提示是主区顶部的一条**独立**提示（一行、12px、灰字）', () => {
    const hint = blockOf(badgeCss, '.fnm-relayhint')
    expect(hint).toMatch(/font-size:\s*12px/)
    expect(hint).toMatch(/color:\s*var\(--text-secondary\)/)
    // ⚠️ **只占一行**：不许折行把主区撑高。
    expect(hint).toMatch(/white-space:\s*nowrap/)
    // ⚠️ 主区是 flex 列容器 → 提示必须**不参与伸缩**。
    expect(hint).toMatch(/flex:\s*0 0 auto/)
  })

  it('**只有中继链路**才显示提示（非中继不显示）', () => {
    useSessionStore.getState().setConnection({
      kind: 'lan',
      url: 'http://192.168.1.2:5666',
      label: '内网直连',
      isRelay: false,
    })
    render(<RelayHint />)
    expect(screen.queryByText(/中继带宽受限/)).toBeNull()
    // ⚠️ 清掉上一棵渲染树（否则下一次 `getByText` 会命中**多个**元素）。
    cleanup()

    useSessionStore.getState().setConnection({
      kind: 'relay',
      url: 'https://x.fnos.net',
      label: '中继',
      isRelay: true,
    })
    render(<RelayHint />)
    expect(screen.getByText(/中继带宽受限/)).toBeTruthy()
  })

  it('主进程给了 `bandwidthHint` 就**用它**，没给才用兜底文案', () => {
    useSessionStore.getState().setConnection({
      kind: 'relay',
      url: 'https://x.fnos.net',
      label: '中继',
      isRelay: true,
      bandwidthHint: '主进程自定义带宽提示',
    })
    render(<RelayHint />)
    expect(screen.getByText('主进程自定义带宽提示')).toBeTruthy()
    expect(screen.queryByText(/中继带宽受限/)).toBeNull()
  })
})
