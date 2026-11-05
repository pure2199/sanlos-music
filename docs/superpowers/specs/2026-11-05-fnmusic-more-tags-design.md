# T42 设计规格：本地音乐标签再补三个容器（MP4/M4A、WAV、AIFF）

- 日期：2026-11-05
- 状态：**已获用户批准**（用户说「继续」＝ 按台账下一个编号任务接着做）
- 前置：T39（ID3v2 / FLAC / Ogg 手写解析器）、T38（未登录也能当播放器）

---

## 1. 背景与动机

T39 已经手写了三个容器的标签解析器（**ID3v2 / FLAC / Ogg**）。T42 把**剩下三个最常见的容器**补上：

| 容器 | 标签放哪 | 备注 |
| --- | --- | --- |
| **MP4 / M4A** | `moov.udta.meta.ilst` | iTunes 系，字段名是**带 © 的四字节码**（`©nam` / `©ART` / `©alb`）→ **复用不了** ID3 解析器 |
| **WAV** | `LIST` → `INFO` → `INAM` / `IART` / `IPRD` | RIFF 家族，**块长小端** |
| **AIFF / AIFC** | `COMM` + `ID3 ` 块 | FORM 家族，**块长大端**；`ID3 ` 块**就是** ID3v2 → 可复用 |

⚠️ **选型说明**：台账里还留着「歌单面板排序 / 过滤」这一条，但**真实账号 `playlist/list` 实测 `total=0`**（一个歌单都没有）→ 对用户**没有实际价值**。本轮选「更多容器标签」，落点更实。

⇒ **不引新 npm 依赖**：三个解析器全部手写（与 T39 一致）。

---

## 2. 关键设计决定

### 2.1 一律**按文件头嗅探**，不靠扩展名猜

`readTagsFromReader(reader)` 是唯一入口 → 新增三条分派：

| 判据（字节） | 容器 |
| --- | --- |
| 第 4~8 字节 = `ftyp` / `moov` / `styp` / `mdat` | MP4 / M4A |
| 第 0~4 字节 = `RIFF` 且第 8~12 字节 = `WAVE` | WAV |
| 第 0~4 字节 = `FORM` 且第 8~12 字节 = `AIFF` / `AIFC` | AIFF / AIFC |

⚠️ **顺序很重要**：`isFlacMagic` / `isId3Magic` / `isOggMagic` 排在前面（ID3 头可能贴在 MP4 前面），新分派排在 ID3 之后、裸 MPEG 之前。

### 2.2 MP4：`moov` 常在**文件尾** → 必须**按偏移走原子表**

不流式写入的 mp4/m4a 会把索引放在**末尾**（ffmpeg 造的样本实测：`moov` 在 25 882 字节文件的 24 517 处）→ **只读文件头会漏掉全部标签**。

⇒ 走**顶层原子表**逐个读原子头（`reader.read(offset, 16)`），找到 `moov` 再把它的内容整块读进来
（预算 `TAG_METADATA_MAX_BYTES` = 2 MB）。

原子头的三种长度写法都要认：

| 长度字段 | 含义 |
| --- | --- |
| `size`（4 字节） | 普通长度 |
| `size == 1` | **64 位长度**在接着的 8 字节里（`largesize`） |
| `size == 0` | 延伸到**文件尾** |

子结构：

```
moov
├─ mvhd   → 时长
└─ udta
   └─ meta      ← ⚠️ FullBox：头 4 字节是 version + flags → 子原子从 +4 开始
      └─ ilst
         ├─ ©nam → data → 歌名
         ├─ ©ART → data → 歌手
         └─ ©alb → data → 专辑
```

⚠️ **`data` 原子的载荷前有 8 字节**：4 字节**类型指示**（`00 00 00 01` = UTF-8）+ 4 字节 **locale** → 载荷从 `contentOffset + 8` 开始。
（字节布局以真实 m4a 核对过：见 §5.2。）

⚠️ **`mvhd` 的时长**：`timescale` / `duration` 的偏移**随版本变**：

| 版本 | timescale | duration |
| --- | --- | --- |
| v0 | `+12`（4 字节） | `+16`（4 字节） |
| v1 | `+20`（4 字节） | `+24`（**8 字节**） |

⚠️ JS 的移位数会 **mod 32** → 取 32 位以上的高位要用 `Math.floor(x / 4294967296)`（与 T39 的 FLAC 同款坑）。

### 2.3 WAV：RIFF 块表，**块长小端**

```
RIFF <size> WAVE
├─ fmt  <size>  → 字节率 @+8（声道 @+0 / 采样率 @+4 / 块对齐 @+12 / 位宽 @+14）
├─ data <size>  → 时长 = size ÷ 字节率（**精确**）
└─ LIST <size>  → 'INFO' → INAM / IART / IPRD
```

⚠️ **块数据按偶数字节补齐**（RIFF 规范）→ 下一个块的位置要跳过补齐字节。文本块常常是**奇数长度**（如 `"A1"` + 1 个 NUL = 3）→ 不补齐就会错位。

### 2.4 AIFF：FORM 块表，**块长大端**

```
FORM <size> AIFF|AIFC
├─ COMM <size>  → 声道 @+0 / 采样帧数 @+2 / 采样位宽 @+6 / 采样率 @+8（**10 字节 80 位扩展精度**）
├─ SSND <size>  → 音频数据
└─ ID3  <size>  → **就是 ID3v2** → 复用 `parseId3v2`
```

⚠️ **80 位扩展精度浮点**（IEEE 754 extended）：`value = 尾数 × 2^(指数 − 16383 − 63)`。
符号位是第 1 字节的最高位，指数是 15 位（`0` = 0，`0x7FFF` = Inf/NaN → 都当「没有采样率」）。
⇒ 时长 = 采样帧数 ÷ 采样率（**精确**）。

### 2.5 文本解码：**UTF-8 → GBK → Latin-1**

`decodeContainerText()`（与 ID3 那个 `decodeText(encoding)` **不是同一个函数**，签名不同）：

1. 带 BOM 的 **UTF-16**（`FF FE` / `FE FF`）→ 先解；
2. **UTF-8 严格模式**（`fatal: true`）→ 能解就用；
3. 解不出来 → **GBK**（老工具写的 WAV `LIST INFO` 常见中文）→ 再退 **Latin-1**（至少不炸）。

⚠️ **结尾的 NUL 必须剔掉**：WAV 的文本块按 **C 字符串**写 → 长度里含结尾的 NUL。
`String.trim()` **不删 NUL**（只删空白）→ 要先 `replace(/\u0000/g, '')` 再 trim。

### 2.6 字节预算与容错

- 元数据块续读沿用 `TAG_METADATA_MAX_BYTES`（2 MB）→ 超了只吃前面的部分（**宁可少读**，不把内存吃穿）；
- 所有解析器**全程不抛**：不认识 / 头不完整 / 长度异常 → 返回 `null` 或**空标签**；
- 原子/块遍历都做了**防死循环**（下一个位置 ≤ 当前位置 → 立刻收手）。

---

## 3. 影响文件清单

| 文件 | 改动 |
| --- | --- |
| `electron/audioTags.ts` | 新增 `decodeContainerText` / `cleanText`、MP4 解析器（`parseMp4Tags`）、RIFF 家族辅助（`readRiffChunkIn` / `readRiffChunk` / `findRiffChunk`）、WAV 解析器（`parseWavTags`）、AIFF 解析器（`parseAiffTags`）、`readExtended80`、`readUint64BE`；`readTagsFromReader` 加三条嗅探分派 |
| `test/audio-tags-containers.test.ts` | **新**：19 条（三个容器的字节流构造 + 分派 + 坏输入） |
| `docs/superpowers/specs/2026-11-05-fnmusic-more-tags-design.md` | **新**：本规格 |
| `README.md` | 「本地音乐」一节补三种容器的支持范围 |
| `docs/changelog.md` | T42 条目 |
| `docs/calibration.md` | T42 实测记录（**含 T38 章节里「FLAC 不能解」的错句修正**） |

⚠️ **既有测试一条没删、断言一条没削弱**：T39 的 `test/audio-tags.test.ts` **完全没动**（新测试另起一个文件），
`test/settings-page.test.tsx` / `test/tray-tooltip.test.ts` / `test/media-session.test.ts` 也不涉及。

---

## 4. 验收点

1. `tsc --noEmit` exit 0；
2. `vitest` 全绿且**总数 ≥ 1688**（既有 1669 + 新增 19）；
3. `playwright` 既有 **24 条**全绿（**本任务不改 UI → 不新增 E2E**）；
4. **真文件验证**（不入库样本）：ffmpeg 造的 m4a / wav / aiff → 真解析器读出歌名 / 歌手 / 专辑 / 时长；
5. **变异自证**（先红后复原，哈希回基线）**6 处**：
   - MP4 `data` 载荷偏移 `+8` → `+4` → 挂；
   - MP4 找 `moov` 改成**只看文件头** → 挂；
   - 去掉**结尾 NUL 剔除** → 挂；
   - GBK 退路改成 Latin-1 → 挂；
   - 80 位浮点指数少减 63 → 挂；
   - WAV 字节率取错字段（`@+4` 采样率 instead of `@+8` 字节率）→ 挂；
6. U+FFFD 扫描 0、无 BOM、行尾保持原样（`docs/calibration.md` 仍 CRLF）；
7. 真机观感：本地音乐里放 m4a / wav / aiff → 歌名、歌手、专辑、时长都对。

---

## 5. 风险与待校准

### 5.1 不做的（明确写出来，免得被当漏做）

| 不做 | 原因 |
| --- | --- |
| **APEv2** | 另一种标签格式，用得少 |
| **WMA / ASF** | 另一个容器家族，跟 RIFF/FORM 都不同 |
| **裸 ADTS-AAC** | 裸流没有容器头，元数据本来就无处安放 |

### 5.2 待校准 / 已知限制

- ⚠️ **字节布局以 ffmpeg 9.0.2 造的样本核对过**（ffmpeg 的 locale 恒为 0）；
  其他写入器（尤其 iTunes 写的 m4a）**没实测** → 单测里用**非 0 的 locale** 把载荷偏移钉死。
- ⚠️ **WAV 的 `LIST INFO` 文本块若是 UTF-16（无 BOM）** → 解不出来（会走 GBK / Latin-1）→
  标签可能乱码。这是 WAV 的历史遗留（无 BOM 无法判定），**不猜**。
- ⚠️ **AIFF 的 `AIFC` 变体**只解析了 `COMM` 的采样率（**没读压缩类型**）→ AIFC 的压缩音频时长仍按采样帧数算。
- ⚠️ **`ilst` 里的自由格式条目**（`----` 开头）**不解析** → 只取 `©nam` / `©ART` / `©alb`。
- ⚠️ **真机未验**：本地音乐里放真实的 m4a / wav / aiff 文件（用户侧操作）。
