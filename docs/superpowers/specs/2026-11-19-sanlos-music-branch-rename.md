# T114 规格：仓库默认分支改名 —— `feature/fnmusic-desktop` → **`sanlos-music`**

> 一句话：把**产品改名前**遗留的分支名换成现在的产品名，并把它顺手当成**默认分支**用，
> 让 GitHub 首页 / Actions / Release 页面不再顶着旧代号「fnmusic」。

---

## 一、为什么（**事实**，不是洁癖）

| 事实 | 实测依据 |
|---|---|
| 分支建于**软件还叫 "FN Music" 的时候** | T49/T50 把软件改名成 "Sanlos Music" 时，改的是**产品名 / 显示名 / userData 目录**，**分支名没跟着改** |
| 它是仓库的**默认分支** ⇒ 到处顶着旧名 | `api.github.com/repos/pure2199/sanlos-music` ⇒ `default_branch = feature/fnmusic-desktop` |
| GitHub 页面上的显示 | Actions 页「Release #18 · Manually run by pure2199 · **feature/fnmusic-desktop**」⇒ 那三行里的第三行就是**分支名** |
| `master` 是**更老**的历史起点，已完全并入 | `master` = `c640b25`；`git merge-base --is-ancestor origin/master origin/feature/fnmusic-desktop` ⇒ **是祖先**；落后 **0** 个提交（已并入 **362** 个提交） |
| CI **没有硬编码**任何分支名 | `.github/workflows/ci.yml:5` ⇒ `branches: ['**']`；`release.yml` 里那两处 `pure2199/sanlos-music` 是**仓库 slug**，不是分支 |

⚠ **tag 不受影响**：`v0.4.0` / `v0.4.1` 指向 **commit**，分支改名后仍解析到原 commit。

---

## 二、用户拍板（2026-11-19）

| 决定 | 值 |
|---|---|
| 新分支名 | **`sanlos-music`**（用产品名；**去掉**误导的 `feature/` 前缀 —— 它是默认分支，不是特性分支） |
| 旧 `master` | **一并删掉**（已 100% 并入，删了不影响任何提交历史） |
| 执行范围 | **整套做**：推新分支 ＋ 网页切默认分支 ＋ 删旧分支 |

---

## 三、改什么（**分支层 ＋ 文档层**，就这些）

### 分支层（远端可见）

| 动作 | 说明 |
|---|---|
| 推新分支 `sanlos-music` | 与旧分支指向**同一个 commit**（`5d8a284`）⇒ 一条提交都不丢 |
| 网页切默认分支 | Settings → Branches → Default branch ⇒ ⚠ **本机没有 GitHub token** ⇒ 这一步只能走**内置浏览器** |
| 删远端 `feature/fnmusic-desktop` | ⚠ **必须在切默认分支之后**（GitHub **不允许删默认分支**） |
| 删远端 `master` | 已并入，无独有提交 |

### 文档层（仓库内 3 个文件）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `docs/superpowers/specs/2026-11-19-sanlos-music-branch-rename.md` | **新增**：本规格（＋ §九 回填） | LF |
| `docs/build-verification.md` | 「**分支**」那一行（当前写着 `feature/fnmusic-desktop`）⇒ 改成 `sanlos-music` | **CRLF**（保持原样） |
| `docs/calibration.md` | **追加**「## 九十二、T114…」一节（改名过程 ＋ 实测 ＋ 坑） | **CRLF**（保持原样） |

---

## 四、执行顺序（**错一步就做不成**）

```
① 规格 commit（推旧分支）        ← 规格先行
        ↓
② 本地 git branch -m → 推新分支 sanlos-music（-u 跟上游）
        ↓
③ 网页切默认分支 → sanlos-music     ← ⚠ 必须先切，旧分支才能删
        ↓
④ 删远端 feature/fnmusic-desktop ＋ master
        ↓
⑤ 文档 commit（build-verification ＋ calibration 第九十二节）
        ↓
⑥ 复验文档 commit（规格 §九 回填）
```

⚠ **本地分支也要改名**（`git branch -m`）⇒ 否则本地还停在旧名字上，
下一次 `git push` 会把提交又推回已删除的旧分支（GitHub 会自动重建它 ⇒ 改名白做）。

---

## 五、验收点

1. `git ls-remote --heads origin` ⇒ **只剩 `sanlos-music`**（旧的与 `master` 都没了）；
2. `api.github.com` 的 `default_branch` = **`sanlos-music`**；
3. tag `v0.4.1` 仍解析到 `11822c6a14de061f391613f3e032a4273b00b993`（**没被挪动**）；
4. 新分支上 `ci.yml` 能被触发（`branches: ['**']`）⇒ 网页 Actions 页能看到新分支上的 run；
5. `release.yml` 的 dispatch 表单里**分支下拉出现 `sanlos-music`**；
6. `git status` 干净；本地分支 = `sanlos-music`，上游 = `origin/sanlos-music`；
7. 文档改动的字节体检 ＋ 控制字符扫描 **bad=0**；回填脚本**连跑 3 次 sha256 一致**；
8. **提交历史一条不少**：`git rev-list --count` 改名前后相同（**362** 个提交并入旧 `master` ＋ 其后）。

---

## 六、明确**不做**

| 不做 | 理由 |
|---|---|
| 改 `package.json` 的 `"name": "fnmusic-desktop"` | 它是**包标识**，还决定 exe 元数据里的**公司名** ⇒ 改了要单独一轮做 ＋ 真机复验（不是本轮） |
| 动 `LEGACY_USER_DATA_DIR_NAME = 'fnmusic-desktop'` | ⚠ 它是**老用户数据目录的迁移源** ⇒ 删了老用户升级会**丢登录态与偏好** |
| 改几百处 CSS 类名（`fnm-playerbar` 等） | 与分支名无关，且纯属内部标识 |
| 改历史 changelog 段 / 历史规格文件名 | 历史是**当时的记录** ⇒ 改它等于篡改历史 |
| 改 `docs/releases/v0.2.0.md` 里指向旧分支的 blob 链接 | 同上（历史记录） |
| 动 `v0.4.0` / `v0.4.1` 两个 tag | 它们指向 commit，**本来就与分支无关** |
| 改任何**运行时标识**（userData 目录名、应用名、产物名） | 本轮是**纯分支层**改动 ⇒ **零运行时影响** |

---

## 七、风险与兜底

| 风险 | 兜底 |
|---|---|
| 网页切默认分支失败（GitHub 可能要密码确认） | 停下来如实上报，不硬来；改分支本身已生效（不影响仓库可用性） |
| 删旧分支后本地还停在旧分支 | `git branch -m` 已在流程里；真出问题可用 `git push origin sanlos-music:sanlos-music` 重建 |
| 新分支上的 CI 没跑 | `branches: ['**']` ⇒ 手动 dispatch `ci.yml` 即可补跑 |
| 以后发版选错分支 | `release.yml` 的 `workflow_dispatch` 用**所选分支**的 YAML ⇒ 下拉里选 `sanlos-music` 即可（同一个 YAML） |

---

## 八、实测状态（如实标注，不夸大）

| 项 | 状态 |
|---|---|
| 起因 | 用户在 GitHub Actions 页看到「Release #18 · **feature/fnmusic-desktop**」⇒ 问「为什么不改成现在的软件名」 |
| 事实基线 | 默认分支 = 旧分支名；`master` 已并入、落后 0；CI 无硬编码；tag 与分支无关 |
| 决定 | 用户拍板：新名 `sanlos-music`／删 `master`／整套做 |
| 执行 | ✅ 远端**只剩 `sanlos-music`** 一条分支（旧的 `feature/fnmusic-desktop` 与 `master` **都删了**）；API `default_branch` = **`sanlos-music`**；tip sha **1d5484f**、提交数 **365** 与改名前**完全一致**；tag `v0.4.1` **未动** |
| 复验 | ✅ 探针 `release/verify/t114-01-verify.mjs` ⇒ **BRANCH_RENAME_OK**（**14 条**断言全过）；改名动作**自动**触发了新分支上的 CI（run **44482556919**）⇒ **success** |

---

## 九、待回填（**执行后回填**）

| 项 | 状态 |
|---|---|
| 规格 | ✅ 本文件 |
| 改名操作（推分支 / 切默认 / 删旧分支） | ✅ 远端**只剩 `sanlos-music`** 一条分支（旧的 `feature/fnmusic-desktop` 与 `master` **都删了**）；API `default_branch` = **`sanlos-music`**；tip sha **1d5484f** 与提交数（**365**）与改名前**完全一致**；tag `v0.4.1` **未动**（仍 → `11822c6a14de061f391613f3e032a4273b00b993`） |
| 文档改动（build-verification ＋ calibration 第九十二节） | ✅ calibration **第九十二节**（起因 / 事实 / 拍板 / 执行过程 / 复验表 / 6 个坑 / 没做什么）＋ `docs/build-verification.md` 顶部**一条说明**（⚠ **历史那行分支名不动**） |
| 复验（远端分支 / 默认分支 / tag / CI / dispatch 下拉） | ✅ 探针 `release/verify/t114-01-verify.mjs` ⇒ **BRANCH_RENAME_OK**；改名动作**自动**触发了新分支上的 CI（run **44482556919**，分支 `sanlos-music`）⇒ **success** |
| 复验文档 commit | ✅ **本 commit**（规格 §九 回填 ＋ 复验记录；台账见仓库外的 `progress-ledger.md`） |
