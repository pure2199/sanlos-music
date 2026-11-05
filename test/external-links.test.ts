// ---------------------------------------------------------------------------
// T41：用系统浏览器打开外部链接（主进程侧）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么单独测**：`shell.openExternal` 只有 Electron 进程里才有 →
//    真逻辑抽成了**纯函数 + 依赖注入**（`electron/externalLinks.ts`），
//    这里直接喂替身 → 不用起 Electron 就能验「放行 / 拒绝 / 失败不炸」。
//
// ⚠️ **被拒绝时一次都不许调 `open`**（不是「调了但失败」）——
//    白名单是**入口**上的闸门，不是「打开失败就当没这回事」。
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest'

import { openExternalUrl } from '../electron/externalLinks'

describe('用系统浏览器打开外部链接（T41）', () => {
  it('白名单内的 https → 真的调了 open', async () => {
    const open = vi.fn().mockResolvedValue(undefined)

    const ok = await openExternalUrl('https://www.sanlos.cn', { open })

    expect(ok).toBe(true)
    expect(open).toHaveBeenCalledWith('https://www.sanlos.cn')
  })

  it('不在白名单 → 拒绝，**一次都不调** open', async () => {
    const open = vi.fn().mockResolvedValue(undefined)

    const ok = await openExternalUrl('https://example.com', { open })

    expect(ok).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('协议不是 https → 拒绝', async () => {
    const open = vi.fn().mockResolvedValue(undefined)

    await expect(openExternalUrl('http://www.sanlos.cn', { open })).resolves.toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('打开失败（抛错）→ **不把异常抛给调用方**（点个链接不该把应用搞崩）', async () => {
    const open = vi.fn().mockRejectedValue(new Error('no browser'))

    await expect(openExternalUrl('https://www.sanlos.cn', { open })).resolves.toBe(false)
  })

  it('前后空白会被去掉再打开', async () => {
    const open = vi.fn().mockResolvedValue(undefined)

    await openExternalUrl('  https://www.sanlos.cn  ', { open })

    expect(open).toHaveBeenCalledWith('https://www.sanlos.cn')
  })
})
