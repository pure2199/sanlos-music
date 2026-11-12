# T89-⑰ 规格：版本号 bump 到 0.2.8

> 配套：发布文档见 `2026-11-13-sanlos-music-v0.2.8-release.md`（T89-⑯，commit `979c146` ＋ `1c4b265`）。

---

## 一、为什么现在 bump（它在发版链上的位置）

`.github/workflows/release.yml` 是 **`workflow_dispatch`（手动触发）**，输入三个参数：
`tag`（必填）、`pack_only`（默认 `true` = 只打包）、`sign`（默认 `true`，但 SignPath 已被拒 ⇒ 当前须取消勾选走未签名路径）。

关键的一行在 checkout：

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ inputs.tag }}   # ← 只签这个标签的源码
```

⇒ **产物是按「tag 指向的那次提交」构建的**，而不是按触发时所在的分支。

而产物名与更新清单的版本**全部来自 `package.json`**：

| 位置 | 取版本的方式 | 后果 |
|---|---|---|
| `electron-builder.yml` | `artifactName: FN-Music-Setup-${version}.${ext}` | 产物文件名 |
| `scripts/publish-manifest.mjs` | `readVersion()` 读 `package.json` | `latest.json` 的 `version` ＋ 清单里的文件名 |
| `.github/workflows/release.yml` | `(Get-Content package.json -Raw).version` | 要上传的资产清单 |
| 主进程 `app.getVersion()` | 读 `package.json` | 安装包 FileVersion、**About 页**与**更新页**显示的版本 |

⇒ **tag 指向的那次提交里，`package.json` 的 version 必须是 `0.2.8`**
⇒ 否则会得到「tag 是 `v0.2.8`、资产却叫 `FN-Music-Setup-0.2.7.exe`」的错位。

⇒ **bump 必须发生在打 tag 之前。**

---

## 二、改动清单（**1 个文件、1 行**）

| 文件 | 改动 | 行数 |
|---|---|---|
| `package.json` | `"version": "0.2.7"` → `"version": "0.2.8"` | **1 行** |

⇒ 与 v0.2.7 那次 bump（`d8d71a1`，`chore(release): 版本号 bump 到 0.2.7`）**完全同形**：只动 `package.json` 一行。

---

## 三、明确**不改**的（每条都有理由）

| 项 | 理由 |
|---|---|
| **`package-lock.json` 的根版本** | 它现在停在 **`0.2.4`** —— v0.2.5 / 0.2.6 / 0.2.7 **三次 bump 都没动过它** ⇒ 这是**既有状态**，不是本次引入的。`npm ci` 校验的是**依赖树**、**不是**根版本字段 ⇒ 现在改它只会制造一份与前三次都不一致的 lock 噪音。⇒ **不动** |
| `docs/changelog.md` 的「当前版本」行 | 上一轮 T89-⑯（`1c4b265`）**已经**改成 `0.2.8` ⇒ 无需再动 |
| 源码里的版本号 | 已全仓库 grep：**非 docs 文件**里写死的版本号只有 `package.json` 一处（`package-lock.json` 里那个 `0.2.7` 是 `tmp` 这个**依赖**的版本，与本应用无关）⇒ 无需改 |
| `electron-builder.yml` | 它的 `artifactName` 用 `${version}` 模板 ⇒ **自动跟随** |
| 任何测试 | E2E `e2e/t82-shell.spec.ts` 断言的是「About 显示的版本 == 主进程 `app.getVersion()`」⇒ **动态比对**、不写死版本号 ⇒ **不会被 bump 打破** |
| 产品代码 / 发布说明 | 本轮只改版本号 ⇒ 一律不动 |

---

## 四、bump 之后要核的一致性（8 条）

| # | 核什么 | 期望 |
|---|---|---|
| 1 | `package.json` 的 version | `0.2.8`，且 `git diff --numstat` **只 1 行** |
| 2 | 主进程 `app.getVersion()` | `0.2.8` ⇒ About 页 / 更新页显示 `v0.2.8` |
| 3 | 产物文件名 | `FN-Music-Setup-0.2.8.exe` / `FN-Music-Portable-0.2.8.exe` |
| 4 | 更新清单 `latest.json` 的 `version` | `0.2.8` |
| 5 | `docs/releases/v0.2.8.md` | **存在**（CI 读 `docs/releases/$env:TAG.md`，**找不到会 throw**）⇒ 已就位（`1c4b265`） |
| 6 | `docs/changelog.md` 的「当前版本」 | `0.2.8` ⇒ 已就位（`1c4b265`） |
| 7 | `package-lock.json` 根版本 | **仍是 `0.2.4`**（**刻意不动**，与前三次 bump 一致） |
| 8 | 规格/文档行尾 | 新增的规格文件 **LF**；`package.json` 保持其现状行尾 |

---

## 五、执行顺序（**顺序不可换**）

| 步 | 做什么 | commit |
|---|---|---|
| 1 | 写本规格文件 | **commit 1**：`docs(spec): 版本号 bump 到 0.2.8 —— 规格（T89-⑰）` |
| 2 | 改 `package.json` 的 version（**只这一行**） | **commit 2**：`chore(release): 版本号 bump 到 0.2.8` |
| 3 | 两个 commit 一起 push 到 `feature/fnmusic-desktop` | — |

⇒ 之后才是发版（**本轮不做**）：打 tag `v0.2.8` **必须**指向 commit 2 或其之后的提交
⇒ 再手动 dispatch `release.yml`（`tag=v0.2.8`、`pack_only=false`、`sign=false` 走未签名路径）。

---

## 六、验收点

| # | 验收项 | 怎么验 |
|---|---|---|
| 1 | 只改了 1 行 | `git diff --numstat HEAD~1` ⇒ `1  1  package.json` |
| 2 | 改的正是 version 字段 | `git show HEAD -- package.json` ⇒ 只有 `"version"` 一行 |
| 3 | 文件没被整体重写 | 行尾/BOM/字节自检（`fnm-bytes-check.mjs`）⇒ 无 BOM、无 U+FFFD、无 NUL |
| 4 | JSON 仍然合法 | `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` |
| 5 | 规格文件行尾 | LF（与 `docs/superpowers/specs/*` 其余文件一致） |
| 6 | 两个 commit、顺序正确 | `git log --oneline -2` ⇒ 规格在前、bump 在后 |
| 7 | 已 push | `git status -sb` ⇒ 与远端无差异 |

---

## 七、明确不做 / 做不到的事

| 项 | 说明 |
|---|---|
| **不打 tag、不 dispatch 发布** | 属**外部可见动作** ⇒ 需用户确认后再做；本轮只出规格 + 版本号 |
| **不改 `package-lock.json`** | 见第三节（既有状态，且与前三次 bump 一致） |
| **不改任何代码 / 测试 / 发布说明** | 本轮只动版本号 |
| **不删 tag、不 force-push、不改任何已发布的 Release** | 一律不做 |
