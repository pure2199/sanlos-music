// ---------------------------------------------------------------------------
// T75：应用图标 —— 托盘「**没在播放**」时显示**应用图标**（不再是空白）
// ---------------------------------------------------------------------------
//
// ⚠️ **为什么这是独立的用例文件**：
//    用户反馈「任务栏图标没播放时是空的，没播放时图标应该有」。
//    根因：项目**没有应用图标资源** ⇒ 托盘的「默认图标」被实现成
//    `nativeImage.createEmpty()`（0×0 空图）⇒ 通知区里**什么都没有**。
//    ⇒ T75 给托盘注入**应用图标**：没有封面 / 封面取失败 ⇒ 显示它。
//
// ⚠️ 本文件同时钉住「**没注入应用图标时行为一字不变**」——
//    保证既有单测的老用法（不注入）仍然是空图降级，不被悄悄改掉。
//
// ⚠️ 测试数据全是占位数据，不写真实歌曲名 / FN ID。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import path, { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { appIconCandidates, resolveAppIconPath } from '../electron/appIcon'
import { createTray, type NativeImageFactory, type NativeImageLike, type TrayLike } from '../electron/tray'
import type { PlayerStateSnapshot } from '../shared/playerBridge'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 假图标（带标签 ⇒ 能断言「设上去的是哪一个」）。 */
class FakeImage implements NativeImageLike {
  constructor(readonly label: string) {}
  isEmpty(): boolean {
    return this.label === 'empty'
  }
  resize(): NativeImageLike {
    return new FakeImage(`${this.label}@resized`)
  }
}

/** 假图标工厂。 */
const fakeNativeImage: NativeImageFactory = {
  createEmpty: () => new FakeImage('empty'),
  createFromBuffer: (bytes) => new FakeImage(`bytes:${bytes.byteLength}`),
}

/** 假托盘：记录**构造时的图标**与**每一次 setImage**。 */
interface FakeTray extends TrayLike {
  /** 建托盘时传进去的图标。 */
  icon: NativeImageLike | null
  /** `setImage` 的每一次调用。 */
  images: NativeImageLike[]
}

function fakeTray(): FakeTray {
  const tray: FakeTray = {
    icon: null,
    images: [],
    setToolTip() {
      // 不关心提示文字。
    },
    setImage(image) {
      tray.images.push(image)
    },
    on() {
      // 不关心事件。
    },
    destroy() {
      // 不关心销毁。
    },
  }
  return tray
}

/** 取某个图标的标签。 */
function labelOf(image: NativeImageLike | null | undefined): string {
  if (!image) return '(null)'
  return (image as unknown as { label: string }).label
}

/** 取最后一个被设上去的图标（没有就抛错 ⇒ 断言失败看得见）。 */
function lastImage(images: NativeImageLike[]): NativeImageLike {
  const last = images[images.length - 1]
  if (!last) throw new Error('一次 setImage 都没有发生')
  return last
}

/** 一份「正在播放、有封面」的占位状态。 */
function playingState(): PlayerStateSnapshot {
  return {
    current: {
      id: 'song-1',
      title: '歌一',
      artist: '示例歌手',
      album: '示例专辑',
      coverId: 'track_abc',
      duration: 100,
    },
    isPlaying: true,
    position: 0,
    duration: 100,
    volume: 1,
    mode: 'sequence',
    muted: false,
  }
}

/** 一份「**没在播放**、没有当前曲目」的占位状态。 */
function idleState(): PlayerStateSnapshot {
  return {
    current: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    volume: 1,
    mode: 'sequence',
    muted: false,
  }
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

describe('T75：应用图标的路径解析', () => {
  it('候选顺序 = 模块目录优先，其次 appRoot/build', () => {
    const candidates = appIconCandidates({
      moduleDir: 'C:/app/dist-electron',
      appRoot: 'C:/repo',
    })
    // ⚠️ 用 `path.join` 构造期望值（Windows 下分隔符是反斜杠 ⇒ 写死斜杠会假红）。
    expect(candidates).toEqual([
      path.join('C:/app/dist-electron', 'icon.png'),
      path.join('C:/repo/build', 'icon.png'),
    ])
  })

  it('第一个存在的就是它', () => {
    const wanted = path.join('/r/build', 'icon.png')
    const found = resolveAppIconPath(
      { moduleDir: '/m', appRoot: '/r' },
      (candidate) => candidate === wanted,
    )
    expect(found).toBe(wanted)
  })

  it('模块目录里那份优先于 appRoot/build 那份', () => {
    const found = resolveAppIconPath({ moduleDir: '/m', appRoot: '/r' }, () => true)
    expect(found).toBe(path.join('/m', 'icon.png'))
  })

  it('一个都没有 ⇒ null（调用方按「没有图标」处理，不报错）', () => {
    expect(resolveAppIconPath({ moduleDir: '/m', appRoot: '/r' }, () => false)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 打包契约（**静态钉死**：没有它们，改坏了没人拦得住）
// ---------------------------------------------------------------------------

/**
 * 仓库根目录（**不依赖 `process.cwd()`**）。
 *
 * ⚠️ 用 `process.cwd()` 锚定时，cwd ≠ 仓库根（例如从别的目录跑 vitest），
 *    读到的就是别的目录 ⇒ 断言**空转通过**。
 *    这里从**本测试文件自身的位置**推导仓库根（与 cwd 无关）。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('T75：打包必须用应用图标', () => {
  it('`electron-builder.yml` 的 `win:` 块里必须有 `icon:`（不是 Electron 默认图标）', () => {
    const raw = readFileSync(resolve(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    // ⚠️ **先把整行注释去掉** —— 否则「注释里写着 icon:」也会让断言通过（空断言）。
    const lines = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
    const start = lines.findIndex((line) => line.trim() === 'win:')
    expect(start).toBeGreaterThan(-1)
    // `win:` 块 = 往后到下一个**顶格**键为止。
    const block: string[] = []
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line === undefined) break
      if (/^\S/.test(line)) break
      block.push(line)
    }
    const iconLine = block.find((line) => /^\s+icon:\s*\S+/.test(line))
    expect(iconLine).toBeTruthy()
  })

  it('图标资源**必须进版本库**（`build/icon.png` 与 `build/tray.png` 都在）', () => {
    for (const file of ['build/icon.png', 'build/tray.png']) {
      const abs = resolve(REPO_ROOT, file)
      expect(existsSync(abs)).toBe(true)
      expect(statSync(abs).size).toBeGreaterThan(0)
    }
  })

  it('`scripts/build-electron.cjs` 必须把图标复制进 `dist-electron/`（随包进 asar）', () => {
    const raw = readFileSync(resolve(REPO_ROOT, 'scripts/build-electron.cjs'), 'utf8')
    expect(raw).toContain("'icon.png'")
    expect(raw).toContain("'build'")
    expect(raw).toContain('copyFileSync')
  })
})

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

describe('T75：托盘在没有封面时显示**应用图标**', () => {
  it('建托盘时用的就是应用图标（不是空图）', () => {
    const tray = fakeTray()
    const controller = createTray({
      createTray: (icon) => {
        tray.icon = icon
        return tray
      },
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      appIcon: new FakeImage('app-icon'),
    })
    expect(labelOf(tray.icon)).toBe('app-icon')
    expect(tray.icon?.isEmpty()).toBe(false)
    controller.destroy()
  })

  it('**从播放切到停止** ⇒ 设的是应用图标，**不是空白**', async () => {
    const tray = fakeTray()
    const cover = {
      fetch: vi.fn(async () => new Uint8Array([1, 2, 3])),
      size: () => 0,
      clear: () => {},
    }
    const controller = createTray({
      createTray: (icon) => {
        tray.icon = icon
        return tray
      },
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
      appIcon: new FakeImage('app-icon'),
    })
    // 先播一首歌 ⇒ 托盘显示封面。
    controller.update(playingState())
    await vi.waitFor(() => {
      expect(tray.images.length).toBeGreaterThan(0)
    })
    expect(labelOf(tray.images[tray.images.length - 1])).toContain('bytes:')

    // 停下（没有当前曲目 ⇒ 没有封面）⇒ **换回应用图标**。
    controller.update(idleState())
    expect(tray.images.length).toBeGreaterThan(1)
    const last = lastImage(tray.images)
    expect(labelOf(last)).toBe('app-icon')
    expect(last.isEmpty()).toBe(false)
    controller.destroy()
  })

  it('封面**取失败** ⇒ 回落应用图标，**不是空白**', async () => {
    const tray = fakeTray()
    const cover = {
      fetch: vi.fn(async () => null),
      size: () => 0,
      clear: () => {},
    }
    const controller = createTray({
      createTray: (icon) => {
        tray.icon = icon
        return tray
      },
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
      appIcon: new FakeImage('app-icon'),
    })
    controller.update(playingState())

    await vi.waitFor(() => {
      expect(tray.images.length).toBeGreaterThan(0)
    })
    expect(tray.images.every((image) => !image.isEmpty())).toBe(true)
    expect(tray.images.map(labelOf)).toEqual(['app-icon'])
    controller.destroy()
  })

  it('**播放中**仍然显示专辑封面（用户拍板的行为不变）', async () => {
    const tray = fakeTray()
    const cover = {
      fetch: vi.fn(async () => new Uint8Array([1, 2, 3])),
      size: () => 0,
      clear: () => {},
    }
    const controller = createTray({
      createTray: (icon) => {
        tray.icon = icon
        return tray
      },
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
      appIcon: new FakeImage('app-icon'),
    })
    controller.update(playingState())

    await vi.waitFor(() => {
      expect(tray.images.length).toBeGreaterThan(0)
    })
    // 最后一次设上去的是**封面**，不是应用图标。
    expect(labelOf(tray.images[tray.images.length - 1])).toContain('bytes:')
    expect(tray.images.map(labelOf)).not.toContain('app-icon')
    controller.destroy()
  })

  it('**没有注入**应用图标 ⇒ 仍然是空图（老行为一字不变）', async () => {
    const tray = fakeTray()
    const cover = {
      fetch: vi.fn(async () => new Uint8Array([1, 2, 3])),
      size: () => 0,
      clear: () => {},
    }
    const controller = createTray({
      createTray: (icon) => {
        tray.icon = icon
        return tray
      },
      nativeImage: fakeNativeImage,
      buildMenu: () => ({ popup: () => {} }),
      cover,
    })
    expect(tray.icon?.isEmpty()).toBe(true)

    controller.update(playingState())
    await vi.waitFor(() => {
      expect(tray.images.length).toBeGreaterThan(0)
    })
    // 播放 → 停止 ⇒ 没有封面 ⇒ 降级成**空图**（**老行为**）。
    controller.update(idleState())
    const last = lastImage(tray.images)
    expect(last.isEmpty()).toBe(true)
    controller.destroy()
  })
})
