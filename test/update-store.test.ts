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
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUpdateController } from '../electron/update'
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
    // ⚠️ **T87.12**：主进程把落盘用的**文件名**一起给渲染层 ⇒
    //    启动安装时回传的是**它**（`update:install` 的参数是裸文件名）。
    name: 'FN-Music-Setup-9.9.9.exe',
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
    // ⚠️ **T87.12**：回传的必须是**裸文件名**（**不是**绝对路径）——
    //    `update:install` 的契约就是「文件名」（`shared/playerBridge.ts`）⇒
    //    传路径会被主进程判「安装包名不合法」（真机事故）。
    //    ⚠️ 原来的断言写的是那个**路径** ⇒ 前提已被真机实测推翻 ⇒ 改写为**更强**的新断言。
    expect(calls).toEqual(['FN-Music-Setup-9.9.9.exe'])
    expect(calls[0]).not.toMatch(/[\\/]/)
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

// ---------------------------------------------------------------------------
// T87.12：渲染层 ↔ 主进程的**契约**（真机事故：「安装包名不合法」）
// ---------------------------------------------------------------------------
//
// ⚠️ **真机事故（T87.12）**：v0.2.4 里点「启动安装」⇒ 红框「安装包名不合法」。
//    根因 = 渲染层把**绝对路径**回传给 `update:install`，而这条 IPC 的参数
//    **从头到尾都是「裸文件名」**（`shared/playerBridge.ts` 的契约就是这么写的）。
//
// ⚠️ **为什么这里要接「真的」主进程控制器**：本文件原来的假桥**只记录参数、
//    从不校验** ⇒ 它把「回传路径」也当成功 ⇒ 真机上必然被主进程拒，却测不出来。
//    ⇒ 这里让假桥**只做转发**：渲染层发什么，就原样交给**真的**控制器去判。
//    （这正是原来漏掉的那道「一端带真实校验」的测试。）
describe('渲染层 ↔ 主进程的契约（T87.12）', () => {
  const BASE = 'https://updates.example.com/d'
  const SIGNER = 'CN=占位签名者'
  const FILE_NAME = 'FN-Music-Setup-1.2.3.exe'
  const payload = Buffer.from('占位安装包内容')
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('检查 → 下载 → 启动安装 ⇒ **安装器真的起来**（不许报「安装包名不合法」）', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'fnm-update-contract-'))
    tempDirs.push(destDir)

    const file = {
      name: FILE_NAME,
      url: FILE_NAME,
      sha512: createHash('sha512').update(payload).digest('hex'),
      size: payload.byteLength,
    }
    const manifest = JSON.stringify({ version: '1.2.3', files: [file] })
    const fetchImpl = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/latest.json')) return new Response(manifest)
      return new Response(payload)
    }) as unknown as typeof fetch

    const opened: string[] = []
    const controller = createUpdateController({
      fetchImpl,
      currentVersion: '1.0.0',
      destDir,
      // ⚠️ 假安装包**没有签名**（与真机 v0.2.5 同形）⇒ 走「允许安装未签名」那条路。
      runAuthenticode: async () => ({ status: 'NotSigned', signer: null }),
      openPath: async (path: string) => {
        opened.push(path)
        return ''
      },
    })

    // ⚠️ 假桥**只做转发**：渲染层发什么，就原样交给**真的**控制器判。
    ;(globalThis as unknown as { fnPlayer?: PlayerBridge }).fnPlayer = {
      checkUpdate: async () => await controller.check(BASE),
      downloadUpdate: async (name: string) => await controller.download(name, SIGNER),
      installUpdate: async (name: string) => await controller.install(name, SIGNER, true),
    } as unknown as PlayerBridge

    useUpdateStore.setState({
      allowUnsigned: true,
      status: 'idle',
      error: null,
      result: null,
      download: null,
    })

    await useUpdateStore.getState().check()
    expect(useUpdateStore.getState().status).toBe('checked')

    await useUpdateStore.getState().downloadUpdate()
    expect(useUpdateStore.getState().status).toBe('downloaded')

    await useUpdateStore.getState().installUpdate()

    // ⚠️ **核心断言**：安装器**真的被启动了**（原来这里必然红在「安装包名不合法」）。
    expect(useUpdateStore.getState().error).toBeNull()
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain(FILE_NAME)
  })
})
