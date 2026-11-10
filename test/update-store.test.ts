// ---------------------------------------------------------------------------
// T85：渲染层「能不能启动安装器」的判定（`updateStore`）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么要有这个文件**：T85 的事故 = 「主进程判一套、渲染层判另一套」。
//    渲染层那道「提前说清楚」的拦截**比主进程严** ⇒
//    「允许安装未签名的更新包」被**彻底堵死**（用户勾了也没用，且**没有任何报错**）。
//
//    ⇒ 这里把渲染层的判定**逐行**钉死，并且要求它与主进程**同一口径**
//    （两边都调 `evaluateSignatureGate`，`shared/update.ts`）。
//
// ⚠️ 测试数据一律用占位值，不写真实文件名 / 真实签名者 / 真实路径。
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PlayerBridge } from '../shared/playerBridge'
import type { UpdateDownloadResult, UpdateSignatureResult } from '../shared/update'
import { useUpdateStore } from '../src/state/updateStore'

/** 造一份签名结果。 */
function signature(over: Partial<UpdateSignatureResult> = {}): UpdateSignatureResult {
  return {
    ok: false,
    status: 'NotSigned',
    signer: null,
    reason: '安装包没有 Authenticode 签名',
    ...over,
  }
}

/** 造一份「下载好了」的安装包结果。 */
function downloaded(sig: UpdateSignatureResult): UpdateDownloadResult {
  return {
    status: 'ok',
    path: 'C:\\Temp\\FN-Music-Setup-9.9.9.exe',
    bytes: 1024,
    sha512Ok: true,
    signature: sig,
  }
}

/** 假桥（只记 `installUpdate` 的调用）。 */
function fakeBridge(install: () => Promise<{ status: 'ok'; path: string }>): {
  bridge: PlayerBridge
  calls: string[]
} {
  const calls: string[] = []
  const bridge = {
    installUpdate: async (name: string) => {
      calls.push(name)
      return await install()
    },
  } as unknown as PlayerBridge
  return { bridge, calls }
}

/** 把 store 摆到某个状态。 */
function seed(state: {
  download: UpdateDownloadResult | null
  allowUnsigned: boolean
  expectedSigner?: string
}): void {
  useUpdateStore.setState({
    download: state.download,
    allowUnsigned: state.allowUnsigned,
    expectedSigner: state.expectedSigner ?? '',
    status: 'idle',
    error: null,
  })
}

describe('渲染层启动安装的判定（T85）', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = undefined
  })

  afterEach(() => {
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = undefined
  })

  it('未签名包 + **已授权** + 没配预期签名者 → **真的去启动**（T85 的核心）', async () => {
    const { bridge, calls } = fakeBridge(async () => ({
      status: 'ok',
      path: 'C:\\Temp\\FN-Music-Setup-9.9.9.exe',
    }))
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
    seed({ download: downloaded(signature()), allowUnsigned: true })

    await useUpdateStore.getState().installUpdate()

    // ⚠️ **必须真的调到主进程** —— 旧实现在这里因「没配预期签名者」提前 return 了。
    expect(calls).toEqual(['C:\\Temp\\FN-Music-Setup-9.9.9.exe'])
    expect(useUpdateStore.getState().status).toBe('idle')
    expect(useUpdateStore.getState().error).toBeNull()
  })

  it('未签名包 + **没授权** → 提前拒绝（说清差什么），且**不**调主进程', async () => {
    const { bridge, calls } = fakeBridge(async () => ({
      status: 'ok',
      path: 'C:\\Temp\\FN-Music-Setup-9.9.9.exe',
    }))
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
    seed({ download: downloaded(signature()), allowUnsigned: false })

    await useUpdateStore.getState().installUpdate()

    expect(calls).toEqual([])
    expect(useUpdateStore.getState().status).toBe('error')
    expect(useUpdateStore.getState().error).toContain('允许安装未签名的更新包')
  })

  it('签名校验通过 → 调主进程（老路径不变）', async () => {
    const { bridge, calls } = fakeBridge(async () => ({
      status: 'ok',
      path: 'C:\\Temp\\FN-Music-Setup-9.9.9.exe',
    }))
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
    seed({
      download: downloaded(signature({ ok: true, status: 'Valid', signer: 'CN=预期的人', reason: null })),
      allowUnsigned: false,
    })

    await useUpdateStore.getState().installUpdate()

    expect(calls).toHaveLength(1)
    expect(useUpdateStore.getState().status).toBe('idle')
  })

  it('包**有**签名但没配预期签名者 → 提前拒绝（授权**救不了**）', async () => {
    const { bridge, calls } = fakeBridge(async () => ({
      status: 'ok',
      path: 'C:\\Temp\\FN-Music-Setup-9.9.9.exe',
    }))
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
    seed({
      download: downloaded(
        signature({
          status: 'Valid',
          signer: 'CN=别人',
          reason: '安装包有代码签名，但未配置「预期的代码签名者」',
        }),
      ),
      allowUnsigned: true,
    })

    await useUpdateStore.getState().installUpdate()

    expect(calls).toEqual([])
    expect(useUpdateStore.getState().status).toBe('error')
    expect(useUpdateStore.getState().error).toContain('未配置')
  })

  it('还没下载 → 拒绝（不调主进程）', async () => {
    const { bridge, calls } = fakeBridge(async () => ({
      status: 'ok',
      path: 'C:\\Temp\\FN-Music-Setup-9.9.9.exe',
    }))
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = bridge
    seed({ download: null, allowUnsigned: true })

    await useUpdateStore.getState().installUpdate()

    expect(calls).toEqual([])
    expect(useUpdateStore.getState().status).toBe('error')
    expect(useUpdateStore.getState().error).toContain('还没有已下载的安装包')
  })
})
