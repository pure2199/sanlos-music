// ---------------------------------------------------------------------------
// 生成应用图标（**零依赖**：PNG 编码手写，不引任何 npm 包）
// ---------------------------------------------------------------------------
//
// 为什么手写：本项目**不引新 npm 依赖**是硬约束；而 `sharp` / `pngjs` /
// `jimp` 之类都得装包 ⇒ 自己写 PNG 分块 + CRC32 + `node:zlib` 压 IDAT。
//
// 画法：**4× 超采样 + 预乘 alpha 盒式降采样** ⇒ 边缘干净、无黑边。
//   - 背景：圆角方块（半径 = 边长 × 0.20），对角渐变 #5B21B6 → #A855F7；
//   - 前景：白色八分音符（旋转 −20° 的椭圆符头 + 竖直符干 + 二次贝塞尔符尾）。
//
// 产物（**都进版本库**，打包与离线构建都要用）：
//   build/icon.png —— 256×256（窗口图标 / exe 图标源）
//   build/tray.png ——  32×32（托盘：100% DPI 缩到 16、200% DPI 原生 32）
//
// 用法：node scripts/make-app-icon.mjs
// ---------------------------------------------------------------------------

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 把 RGBA 原始像素编码成 PNG 字节。 */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // 过滤器类型 0（None）
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 6 = RGBA
  ihdr[10] = 0 // 压缩
  ihdr[11] = 0 // 过滤
  ihdr[12] = 0 // 隔行
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// 图形（归一化坐标 0..1，y 向下）
// ---------------------------------------------------------------------------

/** 圆角方块是否包含该点。 */
function insideRoundedRect(px, py, radius) {
  const cx = Math.min(Math.max(px, radius), 1 - radius)
  const cy = Math.min(Math.max(py, radius), 1 - radius)
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= radius * radius
}

/** 对角渐变（深紫 → 亮紫）。 */
function gradient(px, py) {
  const t = Math.min(1, Math.max(0, (px + py) / 2))
  return [
    (0x5b + (0xa8 - 0x5b) * t) / 255,
    (0x21 + (0x55 - 0x21) * t) / 255,
    (0xb6 + (0xf7 - 0xb6) * t) / 255,
  ]
}

/** 旋转 −20° 的椭圆（符头）。 */
function insideNoteHead(px, py) {
  const cx = 0.375
  const cy = 0.715
  const rx = 0.15
  const ry = 0.105
  const angle = (20 * Math.PI) / 180
  const dx = px - cx
  const dy = py - cy
  // 把点转回椭圆自身的坐标系（逆旋转 +20°）。
  const rx0 = dx * Math.cos(angle) - dy * Math.sin(angle)
  const ry0 = dx * Math.sin(angle) + dy * Math.cos(angle)
  return (rx0 / rx) ** 2 + (ry0 / ry) ** 2 <= 1
}

/** 符干（竖条）。 */
function insideStem(px, py) {
  return px >= 0.495 && px <= 0.548 && py >= 0.245 && py <= 0.73
}

/** 符尾：二次贝塞尔曲线上的一串圆盘（半径沿曲线收窄）。 */
function flagDisks() {
  const p0 = { x: 0.548, y: 0.25 }
  const p1 = { x: 0.8, y: 0.27 }
  const p2 = { x: 0.82, y: 0.47 }
  const disks = []
  const steps = 72
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const mt = 1 - t
    const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x
    const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
    disks.push({ x, y, r: 0.058 + (0.014 - 0.058) * t })
  }
  return disks
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 渲染一张 `size × size` 的图标（返回 RGBA 缓冲）。 */
function renderIcon(size) {
  const ss = 4 // 超采样倍数
  const s = size * ss
  const radius = 0.2
  const disks = flagDisks()

  // 音符遮罩（超采样分辨率上的布尔数组）。
  const noteMask = new Uint8Array(s * s)
  const mark = (x, y) => {
    if (x < 0 || y < 0 || x >= s || y >= s) return
    noteMask[y * s + x] = 1
  }
  // 符头（逐点判定，只在包围盒里跑）。
  for (let y = 0; y < s; y += 1) {
    const py = (y + 0.5) / s
    for (let x = 0; x < s; x += 1) {
      const px = (x + 0.5) / s
      if (px > 0.2 && px < 0.56 && py > 0.58 && py < 0.85 && insideNoteHead(px, py)) mark(x, y)
    }
  }
  // 符干。
  for (let y = 0; y < s; y += 1) {
    const py = (y + 0.5) / s
    if (py < 0.245 || py > 0.73) continue
    for (let x = 0; x < s; x += 1) {
      const px = (x + 0.5) / s
      if (px >= 0.495 && px <= 0.548) mark(x, y)
    }
  }
  // 符尾（一串圆盘）。
  for (const disk of disks) {
    const cx = disk.x * s
    const cy = disk.y * s
    const r = disk.r * s
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(s - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(s - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        if (dx * dx + dy * dy <= r * r) mark(x, y)
      }
    }
  }

  // 降采样累加器（预乘 alpha）。
  const acc = new Float64Array(size * size * 4)
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const px = (x + 0.5) / s
      const py = (y + 0.5) / s
      if (!insideRoundedRect(px, py, radius)) continue
      const [gr, gg, gb] = gradient(px, py)
      const isNote = noteMask[y * s + x] === 1
      const r = isNote ? 1 : gr
      const g = isNote ? 1 : gg
      const b = isNote ? 1 : gb
      const ox = Math.floor(x / ss)
      const oy = Math.floor(y / ss)
      const idx = (oy * size + ox) * 4
      acc[idx] += r
      acc[idx + 1] += g
      acc[idx + 2] += b
      acc[idx + 3] += 1
    }
  }

  // 盒式降采样 + 反预乘。
  const n = ss * ss
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    const a = acc[i * 4 + 3] / n
    const idx = i * 4
    if (a <= 0) continue
    out[idx] = Math.round(Math.min(1, acc[idx] / n / a) * 255)
    out[idx + 1] = Math.round(Math.min(1, acc[idx + 1] / n / a) * 255)
    out[idx + 2] = Math.round(Math.min(1, acc[idx + 2] / n / a) * 255)
    out[idx + 3] = Math.round(Math.min(1, a) * 255)
  }
  return out
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

mkdirSync(join(repoRoot, 'build'), { recursive: true })

const targets = [
  { file: 'icon.png', size: 256 },
  { file: 'tray.png', size: 32 },
]

for (const target of targets) {
  const rgba = renderIcon(target.size)
  const png = encodePng(target.size, target.size, rgba)
  const out = join(repoRoot, 'build', target.file)
  writeFileSync(out, png)
  console.log(`[make-app-icon] build/${target.file}  ${target.size}×${target.size}  ${png.length} B`)
}
