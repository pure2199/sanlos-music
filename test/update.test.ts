// ---------------------------------------------------------------------------
// T23：自动更新（主进程侧）回归测试
// ---------------------------------------------------------------------------
//
// 覆盖的是**安全链条**的每一环，缺一环就是一条「远程代码执行」的路：
//
//   1. 地址合法      → https（回环才允许 http）、不许带凭证 / query
//   2. 清单形状合法  → 版本号 / 文件 / SHA-512 逐项校验
//   3. 文件同源      → 安装包不许被清单指到别处
//   4. 哈希相符      → SHA-512 不符就丢弃
//   5. 签名相符      → 没配预期签名者就不许启动
//   6. 用户点击      → 检查 / 下载 / 启动都是显式调用
//
// ⚠️ 测试数据全是占位数据（假 URL、假哈希、假签名者），
//    **不写真实更新服务器地址 / 真实文件名 / 真实签名者**。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { UpdateFile } from '../shared/update'
import {
  compareVersions,
  downloadUpdate,
  checkForUpdate,
  launchInstaller,
  parseUpdateManifest,
  pickInstaller,
  resolveFileUrl,
  resolveManifestUrl,
  sanitizeFileName,
  validateUpdateBaseUrl,
  verifyAuthenticode,
} from '../electron/update'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 造一份合法的清单 JSON。 */
function makeManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.2.3',
    releasedAt: '2026-11-04T00:00:00.000Z',
    notes: '占位说明',
    files: [
      {
        name: 'FN-Music-Setup-1.2.3.exe',
        url: 'FN-Music-Setup-1.2.3.exe',
        sha512: 'a'.repeat(128),
        size: 1024,
      },
    ],
    ...overrides,
  })
}

/** 造一个只回固定响应的 fetch 替身。 */
function stubFetch(response: Response | (() => never)): typeof fetch {
  return (async () => {
    if (typeof response === 'function') response()
    return response
  }) as unknown as typeof fetch
}

const tempDirs: string[] = []

/** 造一个临时目录（测试结束会删）。 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnm-update-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 地址校验
// ---------------------------------------------------------------------------

describe('更新服务器地址校验（T23）', () => {
  it('https 地址合法', () => {
    expect(validateUpdateBaseUrl('https://updates.example.com/fnmusic')).not.toBeNull()
  })

  it('http 只允许回环主机（公网 http 一律拒绝）', () => {
    expect(validateUpdateBaseUrl('http://127.0.0.1:8080/dist')).not.toBeNull()
    expect(validateUpdateBaseUrl('http://localhost:8080/dist')).not.toBeNull()
    expect(validateUpdateBaseUrl('http://updates.example.com/dist')).toBeNull()
  })

  it('带凭证的地址一律拒绝（URL 里绝不能有凭证）', () => {
    expect(validateUpdateBaseUrl('https://user:pass@updates.example.com/dist')).toBeNull()
  })

  it('带 query / hash 的地址拒绝', () => {
    expect(validateUpdateBaseUrl('https://updates.example.com/dist?token=abc')).toBeNull()
    expect(validateUpdateBaseUrl('https://updates.example.com/dist#x')).toBeNull()
  })

  it('空地址 / 非 URL 一律拒绝', () => {
    expect(validateUpdateBaseUrl('')).toBeNull()
    expect(validateUpdateBaseUrl('   ')).toBeNull()
    expect(validateUpdateBaseUrl('not a url')).toBeNull()
  })

  it('清单地址 = <base>/latest.json', () => {
    expect(resolveManifestUrl('https://updates.example.com/fnmusic')).toBe(
      'https://updates.example.com/fnmusic/latest.json',
    )
    // 末尾多余的斜杠不能拼出「//latest.json」
    expect(resolveManifestUrl('https://updates.example.com/fnmusic/')).toBe(
      'https://updates.example.com/fnmusic/latest.json',
    )
  })
})

// ---------------------------------------------------------------------------
// 文件地址（同源）
// ---------------------------------------------------------------------------

describe('安装包地址必须同源（T23）', () => {
  it('同源相对路径放行', () => {
    expect(resolveFileUrl('https://updates.example.com/d', 'FN-Music-Setup-1.2.3.exe')).toBe(
      'https://updates.example.com/d/FN-Music-Setup-1.2.3.exe',
    )
  })

  it('跨源地址一律拒绝（清单不许把安装包指到别处）', () => {
    expect(resolveFileUrl('https://updates.example.com/d', 'https://evil.example.net/a.exe')).toBeNull()
    expect(resolveFileUrl('https://updates.example.com/d', '//evil.example.net/a.exe')).toBeNull()
  })

  it('同源但换了端口也算跨源', () => {
    expect(resolveFileUrl('https://updates.example.com/d', 'https://updates.example.com:8443/a.exe')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 文件名清洗
// ---------------------------------------------------------------------------

describe('清单里的文件名必须清洗（T23）', () => {
  it('正常文件名放行', () => {
    expect(sanitizeFileName('FN-Music-Setup-1.2.3.exe')).toBe('FN-Music-Setup-1.2.3.exe')
  })

  it('路径穿越一律拒绝', () => {
    expect(sanitizeFileName('../../evil.exe')).toBeNull()
    expect(sanitizeFileName('sub/dir/evil.exe')).toBeNull()
    expect(sanitizeFileName('..')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 版本比对
// ---------------------------------------------------------------------------

describe('版本比对（T23）', () => {
  it('按数字段比较（1.10.0 > 1.9.0）', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })

  it('相等（含 v 前缀）判为 0', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('预发布版本比正式版本更旧（semver 规则）', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.3-beta')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 清单解析
// ---------------------------------------------------------------------------

describe('更新清单解析（T23）', () => {
  it('合法清单解析成功', () => {
    const manifest = parseUpdateManifest(makeManifest())
    expect(manifest?.version).toBe('1.2.3')
    expect(manifest?.files).toHaveLength(1)
    expect(manifest?.notes).toBe('占位说明')
  })

  it('不是 JSON / 不是对象 → 拒绝', () => {
    expect(parseUpdateManifest('not json')).toBeNull()
    expect(parseUpdateManifest('[]')).toBeNull()
    expect(parseUpdateManifest('null')).toBeNull()
  })

  it('缺版本号 / 空文件列表 → 拒绝', () => {
    expect(parseUpdateManifest(JSON.stringify({ files: [] }))).toBeNull()
    expect(parseUpdateManifest(JSON.stringify({ version: '1.0.0' }))).toBeNull()
    expect(parseUpdateManifest(JSON.stringify({ version: '1.0.0', files: [] }))).toBeNull()
  })

  it('SHA-512 形状不对 → 整个清单作废', () => {
    const bad = makeManifest({
      files: [{ name: 'a.exe', url: 'a.exe', sha512: 'too-short', size: 1 }],
    })
    expect(parseUpdateManifest(bad)).toBeNull()
  })

  it('size 不是正整数 → 拒绝', () => {
    const bad = makeManifest({
      files: [{ name: 'a.exe', url: 'a.exe', sha512: 'a'.repeat(128), size: 0 }],
    })
    expect(parseUpdateManifest(bad)).toBeNull()
  })

  it('挑安装包 = 第一个 .exe', () => {
    const manifest = parseUpdateManifest(
      makeManifest({
        files: [
          { name: 'a.zip', url: 'a.zip', sha512: 'a'.repeat(128), size: 1 },
          { name: 'b.exe', url: 'b.exe', sha512: 'b'.repeat(128), size: 2 },
        ],
      }),
    )
    expect(pickInstaller(manifest!)?.name).toBe('b.exe')
  })
})

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

describe('检查更新（T23）', () => {
  const base = 'https://updates.example.com/d'

  it('没配地址 → not-configured（不是错误）', async () => {
    const result = await checkForUpdate({ baseUrl: '', currentVersion: '1.0.0', fetchImpl: stubFetch(new Response('{}')) })
    expect(result.status).toBe('not-configured')
  })

  it('地址不合法 → error', async () => {
    const result = await checkForUpdate({
      baseUrl: 'http://evil.example.com/d',
      currentVersion: '1.0.0',
      fetchImpl: stubFetch(new Response('{}')),
    })
    expect(result.status).toBe('error')
  })

  it('清单版本不新 → up-to-date', async () => {
    const result = await checkForUpdate({
      baseUrl: base,
      currentVersion: '1.2.3',
      fetchImpl: stubFetch(new Response(makeManifest({ version: '1.2.3' }))),
    })
    expect(result.status).toBe('up-to-date')
  })

  it('清单版本更新 → available（附清单与安装包）', async () => {
    const result = await checkForUpdate({
      baseUrl: base,
      currentVersion: '1.0.0',
      fetchImpl: stubFetch(new Response(makeManifest({ version: '1.2.3' }))),
    })
    expect(result.status).toBe('available')
    if (result.status !== 'available') throw new Error('不是 available')
    expect(result.manifest.version).toBe('1.2.3')
    expect(result.file.name).toBe('FN-Music-Setup-1.2.3.exe')
  })

  it('清单坏掉 → error（不猜、不放行）', async () => {
    const result = await checkForUpdate({
      baseUrl: base,
      currentVersion: '1.0.0',
      fetchImpl: stubFetch(new Response('garbage')),
    })
    expect(result.status).toBe('error')
  })

  it('服务器返回 404 → error', async () => {
    const result = await checkForUpdate({
      baseUrl: base,
      currentVersion: '1.0.0',
      fetchImpl: stubFetch(new Response('not found', { status: 404 })),
    })
    expect(result.status).toBe('error')
  })

  it('网络异常 → error（文案可读）', async () => {
    const result = await checkForUpdate({
      baseUrl: base,
      currentVersion: '1.0.0',
      fetchImpl: stubFetch(() => {
        throw new Error('连不上')
      }),
    })
    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('不是 error')
    expect(result.message).toContain('连不上')
  })
})

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

describe('下载安装包（T23）', () => {
  const base = 'https://updates.example.com/d'
  const payload = Buffer.from('占位安装包内容')

  /** 造一条合法的清单文件项（哈希对上真实内容）。 */
  function makeFile(): UpdateFile {
    return {
      name: 'FN-Music-Setup-1.2.3.exe',
      url: 'FN-Music-Setup-1.2.3.exe',
      sha512: createHash('sha512').update(payload).digest('hex'),
      size: payload.byteLength,
    }
  }

  it('下载成功 → 文件落盘、哈希相符', async () => {
    const destDir = makeTempDir()
    const result = await downloadUpdate({
      baseUrl: base,
      file: makeFile(),
      destDir,
      fetchImpl: stubFetch(new Response(payload)),
      runAuthenticode: async () => ({ status: 'Valid', signer: 'CN=占位签名者' }),
      expectedSigner: 'CN=占位签名者',
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('不是 ok')
    expect(result.sha512Ok).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    expect(readFileSync(result.path).toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('哈希不符 → 报错并丢弃下载内容（不留半成品）', async () => {
    const destDir = makeTempDir()
    const file = makeFile()
    const result = await downloadUpdate({
      baseUrl: base,
      file: { ...file, sha512: 'b'.repeat(128) },
      destDir,
      fetchImpl: stubFetch(new Response(payload)),
      runAuthenticode: async () => ({ status: 'Valid', signer: 'CN=占位签名者' }),
      expectedSigner: 'CN=占位签名者',
    })
    expect(result.status).toBe('error')
    // 目录里不能留下任何 exe / part
    expect(existsSync(join(destDir, file.name))).toBe(false)
    expect(existsSync(join(destDir, `${file.name}.part`))).toBe(false)
  })

  it('跨源安装包 → 拒绝（连下载都不发起）', async () => {
    const destDir = makeTempDir()
    const result = await downloadUpdate({
      baseUrl: base,
      file: { ...makeFile(), url: 'https://evil.example.net/a.exe' },
      destDir,
      fetchImpl: stubFetch(new Response(payload)),
      runAuthenticode: async () => ({ status: 'Valid', signer: 'CN=占位签名者' }),
      expectedSigner: 'CN=占位签名者',
    })
    expect(result.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// Authenticode 校验
// ---------------------------------------------------------------------------

describe('Authenticode 签名校验（T23）', () => {
  it('没配预期签名者 → 不通过（不许启动安装器）', async () => {
    const result = await verifyAuthenticode('C:/占位/a.exe', undefined, async () => ({
      status: 'Valid',
      signer: 'CN=占位签名者',
    }))
    expect(result.ok).toBe(false)
    // ⚠️ **必须钉住这条具体的理由**：只断言 `ok === false` 是不够的——
    //    「签名者与预期不符」也会让 `ok` 为 false（变异自证踩到过）。
    expect(result.status).toBe('NotChecked')
    expect(result.reason).toContain('未配置')
  })

  it('没有签名 → 不通过', async () => {
    const result = await verifyAuthenticode('C:/占位/a.exe', 'CN=占位签名者', async () => ({
      status: 'NotSigned',
      signer: null,
    }))
    expect(result.ok).toBe(false)
  })

  it('签名者与预期一致 → 通过', async () => {
    const result = await verifyAuthenticode('C:/占位/a.exe', 'CN=占位签名者', async () => ({
      status: 'Valid',
      signer: 'CN=占位签名者',
    }))
    expect(result.ok).toBe(true)
    expect(result.signer).toBe('CN=占位签名者')
  })

  it('签名者与预期不符 → 不通过', async () => {
    const result = await verifyAuthenticode('C:/占位/a.exe', 'CN=预期的人', async () => ({
      status: 'Valid',
      signer: 'CN=别的人',
    }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不符')
  })
})

// ---------------------------------------------------------------------------
// 启动安装器
// ---------------------------------------------------------------------------

describe('启动安装器（T23）', () => {
  it('签名不通过 → 拒绝启动（openPath 一次都不许被调）', async () => {
    let opened = 0
    const result = await launchInstaller({
      filePath: 'C:/占位/a.exe',
      expectedSigner: 'CN=预期的人',
      runAuthenticode: async () => ({ status: 'Valid', signer: 'CN=别的人' }),
      openPath: async () => {
        opened += 1
        return ''
      },
    })
    expect(result.status).toBe('error')
    expect(opened).toBe(0)
  })

  it('签名通过 → 启动安装器', async () => {
    let opened = 0
    const result = await launchInstaller({
      filePath: 'C:/占位/a.exe',
      expectedSigner: 'CN=预期的人',
      runAuthenticode: async () => ({ status: 'Valid', signer: 'CN=预期的人' }),
      openPath: async () => {
        opened += 1
        return ''
      },
    })
    expect(result.status).toBe('ok')
    expect(opened).toBe(1)
  })

  it('启动器报错 → 如实报错', async () => {
    const result = await launchInstaller({
      filePath: 'C:/占位/a.exe',
      expectedSigner: 'CN=预期的人',
      runAuthenticode: async () => ({ status: 'Valid', signer: 'CN=预期的人' }),
      openPath: async () => '找不到文件',
    })
    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('不是 error')
    expect(result.message).toContain('找不到文件')
  })
})

// ---------------------------------------------------------------------------
// T82：允许安装**未签名**包（默认关；SHA-512 仍是硬闸）
// ---------------------------------------------------------------------------
//
// ⚠️ 本项目暂未办理代码签名证书 ⇒ 安装包**没有签名** ⇒ 默认被签名闸挡住。
//    T82 加了一条**显式、默认关**的授权：「允许安装未签名的更新包」。
//    ⇒ 这里钉住它的**边界**：只放宽「发布者身份」这一条，
//    **SHA-512 不符 / 无从核对 / 签名者不符** 一律拒绝。
// ---------------------------------------------------------------------------

describe('未签名安装包（T82）', () => {
  /** 造一个真的临时安装包（`sha512File` 要读盘）。 */
  function makeInstaller(content: string): { path: string; sha512: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fnm-update-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'FN-Music-Setup-9.9.9.exe')
    writeFileSync(path, content)
    return { path, sha512: createHash('sha512').update(content).digest('hex') }
  }

  /** 假装这个包**没有签名**。 */
  const notSigned = async (): Promise<{ status: string; signer: string | null }> => ({
    status: 'NotSigned',
    signer: null,
  })

  it('默认（没开授权）→ 未签名包**仍然拒绝启动**（原行为一字不变）', async () => {
    const file = makeInstaller('unsigned-payload')
    let opened = 0
    const result = await launchInstaller({
      filePath: file.path,
      expectedSigner: 'CN=预期的人',
      runAuthenticode: notSigned,
      openPath: async () => {
        opened += 1
        return ''
      },
    })
    expect(result.status).toBe('error')
    expect(opened).toBe(0)
    if (result.status !== 'error') throw new Error('不是 error')
    expect(result.message).toContain('拒绝启动')
  })

  it('开了授权 + **哈希相符** → 允许启动（未签名）', async () => {
    const file = makeInstaller('unsigned-payload')
    let opened = 0
    const result = await launchInstaller({
      filePath: file.path,
      expectedSigner: 'CN=预期的人',
      allowUnsigned: true,
      expectedSha512: file.sha512,
      runAuthenticode: notSigned,
      openPath: async () => {
        opened += 1
        return ''
      },
    })
    expect(result.status).toBe('ok')
    expect(opened).toBe(1)
  })

  it('开了授权但**哈希不符** → 仍然拒绝（哈希是硬闸，放权也救不了）', async () => {
    const file = makeInstaller('unsigned-payload')
    let opened = 0
    const result = await launchInstaller({
      filePath: file.path,
      expectedSigner: 'CN=预期的人',
      allowUnsigned: true,
      // ⚠️ 故意给一个**错的**哈希（多写一个字符）。
      expectedSha512: `${file.sha512.slice(0, -1)}0`,
      runAuthenticode: notSigned,
      openPath: async () => {
        opened += 1
        return ''
      },
    })
    expect(result.status).toBe('error')
    expect(opened).toBe(0)
    if (result.status !== 'error') throw new Error('不是 error')
    expect(result.message).toContain('SHA-512')
  })

  it('开了授权但**没给清单哈希** → 拒绝（无从核对）', async () => {
    const file = makeInstaller('unsigned-payload')
    let opened = 0
    const result = await launchInstaller({
      filePath: file.path,
      expectedSigner: 'CN=预期的人',
      allowUnsigned: true,
      runAuthenticode: notSigned,
      openPath: async () => {
        opened += 1
        return ''
      },
    })
    expect(result.status).toBe('error')
    expect(opened).toBe(0)
    if (result.status !== 'error') throw new Error('不是 error')
    expect(result.message).toContain('SHA-512')
  })

  it('包**有签名但签名者不符** → 授权**也救不了**（不走未签名那条路）', async () => {
    const file = makeInstaller('signed-payload')
    let opened = 0
    const result = await launchInstaller({
      filePath: file.path,
      expectedSigner: 'CN=预期的人',
      allowUnsigned: true,
      expectedSha512: file.sha512,
      runAuthenticode: async () => ({ status: 'Valid', signer: 'CN=别的人' }),
      openPath: async () => {
        opened += 1
        return ''
      },
    })
    expect(result.status).toBe('error')
    expect(opened).toBe(0)
    if (result.status !== 'error') throw new Error('不是 error')
    expect(result.message).toContain('不符')
  })
})
