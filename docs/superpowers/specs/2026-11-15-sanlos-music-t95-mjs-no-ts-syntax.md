# T95 规格：`.mjs` 里不许有 TypeScript 语法（**CI 的 Node 22 跑不了**）

> 一句话：修掉 `scripts/publish-manifest.mjs` 里一处 **TS 返回类型注解**（它让 v0.3.0 的发版工作流
> 在写清单那一步挂掉），再补一条**守护测试**，让这类错以后**在发版之前**就被拦下。

---

## 一、这是怎么炸的（T94 发版的现场）

| 事实 | 证据 |
|---|---|
| v0.3.0 的发版工作流**失败**了 | Release **run #15** = `43659919970`，**failed in 5m 36s** |
| 死在**写更新清单**这一步 | `Write update manifest (unsigned)` ⇒ `SyntaxError: Unexpected token ':'` |
| 出错的那一行 | `scripts/publish-manifest.mjs:66` ⇒ `function readPackageMeta(): { version: string; productName: string; prefix: string } {` |
| 前面全过了 | Typecheck 11s / Unit tests 1m54s / Build 4s / **Pack 2m12s**（已打出 `SanlosMusic-Setup-0.3.0.exe`）/ Verify unsigned artifacts 3s |
| **`gh release create` 没跑到** | 失败在它**之前** ⇒ **GitHub 上从未生成过 v0.3.0 Release**，没有任何公开产物发出去过 |

⇒ 也就是说：**这一版从头到尾一个字节都没发出去**，用户那边什么也没变。

---

## 二、根因（**不是**「Node 版本不一样」）

```js
// scripts/publish-manifest.mjs（.mjs 文件里写了 TS 返回类型）
function readPackageMeta(): { version: string; productName: string; prefix: string } {
```

⚠️ **Node 的类型剥离只对 `.ts` / `.mts` / `.cts` 生效**，**`.mjs` 从来不剥**
⇒ 不管 Node 22 还是 Node 26，`.mjs` 里出现 TS 语法都是**语法错误**。

**实测（本机 Node v26.13.0）**：

| 探测 | 结果 |
|---|---|
| `node --check scripts/publish-manifest.mjs` | **退出码 1**，`SyntaxError: Unexpected token ':'`（第 66 行） |
| 造一个含 TS 语法的 `.mjs` 再 `--check` | 同样**退出码 1** |
| 同一个内容改成 `.ts` 后缀再 `--check` | **退出码 1**（类型剥离只发生在**加载**路径，`--check` 一律按纯 JS 解析） |
| `new vm.Script('function f(): number {}')` | **抛 SyntaxError**（但 `vm.Script` 不支持 `import`/`export` ⇒ 不能直接用来判 `.mjs`） |
| TypeScript 的 `createSourceFile(..., ScriptKind.JS)` | **判不出来**：纯 ESM 反而报「';' expected」⇒ 不可用 |

⇒ **本地 Node 26 也一样炸** ⇒ 「本地能跑所以没暴露」这个说法**不成立**。

**真正的根因是：那个脚本本地从来没被执行过。**

| 谁 | 当时验了什么 | 为什么没抓到 |
|---|---|---|
| `9ba7326`（T89-⑔ 第二轮，2026-11-13） | tsc 0、vitest 绿、工作流 YAML 解析过、断言「清单脚本含去空白规则」 | 断言查的是**脚本的文本内容**，**没人执行过它** |
| `v0.2.9` 的发版（run #13 / #14） | ✅ 通过 | `9ba7326` **不在 v0.2.9 的祖先链上** ⇒ v0.2.9 用的是**旧版脚本**（没有注解）⇒ **这之后第一次发版，第一次撞上** |

---

## 三、改哪些文件（**3 个 + 1 个规格 + changelog**）

| 文件 | 改什么 | 行尾 |
|---|---|---|
| `scripts/publish-manifest.mjs` | 第 66 行**去掉 TS 返回类型注解** ⇒ 改成 JSDoc 注释（`@returns {{version: string, ...}}`）；全文其余部分**已是纯 JS**，不动 | LF |
| `tools/fn-electron-net-probe.mjs` | 第 174 行 `})    try {` **缺一个换行** ⇒ 这是**已提交进仓库的语法错误**（任何 Node 都跑不起来），顺手补回换行 | LF |
| `test/t95-mjs-no-ts-syntax.test.ts`（**新增**） | **守护**：用 `node --check` 逐个校验仓库里所有 `.mjs` / `.cjs` | LF |
| `docs/superpowers/specs/2026-11-15-sanlos-music-t95-mjs-no-ts-syntax.md`（**新增**） | 本规格 | LF |
| `docs/changelog.md` | 0.3.0 段补一条如实说明（发版链路自身修好了） | **CRLF**（保持原样） |

### 守护测试为什么用 `node --check`

| 方案 | 结论 |
|---|---|
| `node --check`（**选它**） | ✅ **零新依赖**；用的就是 **CI 那个 node 二进制**；对 `.mjs`（含 `import`/`export`）与 `.cjs` 都按**纯 JS** 解析 ⇒ 任何 TS 语法都报错；Node 22 与 Node 26 行为**一致** |
| `vm.Script` | ❌ 不支持 `import`/`export` ⇒ 纯 ESM 文件**假红** |
| TypeScript `ScriptKind.JS` | ❌ 漏报 TS 语法、误报纯 ESM |
| esbuild（已在 node_modules，但是 **vite 的传递依赖**） | ⚠️ 可用，但依赖**传递依赖**不稳定 ⇒ 不用 |
| `node --experimental-strip-types` | ❌ 只对 `.ts` 生效，对 `.mjs` 无效 |

⚠️ **守护放在 `test/` 里的意义**：Release 工作流的 **`npm test` 步骤排在「写清单」之前**
⇒ 这类错以后会在 **`Unit tests` 那一步**就红（带明确的文件名与行号），**不会**再等到发版中途炸。

---

## 四、验收点

### 本机

1. `node --check scripts/publish-manifest.mjs` ⇒ **退出码 0**；
2. `node --check tools/fn-electron-net-probe.mjs` ⇒ **退出码 0**；
3. **本地真跑** `node scripts/publish-manifest.mjs` ⇒ 真的产出 `latest.json`
   （⚠️ 这一条是本轮**最关键**的验收点 —— 上一轮就是「只做静态检查、从没执行过」才漏掉的）；
4. `tsc --noEmit` ⇒ **0 error**；
5. `vitest run` ⇒ **既有 2639 条一条未删、断言一条未弱化**，新增守护用例全绿；
6. **变异自证**：把 `publish-manifest.mjs` 的注解改回去 ⇒ 守护用例**当场变红** ⇒ 还原后恢复全绿；
7. 字节体检 + 控制字符扫描（改动文件）⇒ **0 bad**；`docs/changelog.md` **0 裸 LF**。

### 重新发版（用户已拍板：**移动 tag v0.3.0**）

8. 把 tag `v0.3.0` **移动**到修复后的提交（force-push tag ⇒ **执行前单独 ask_user 确认**）；
9. 重新 dispatch（`tag=v0.3.0` / `pack_only=false` / `sign=false`）⇒ 工作流**跑完**；
10. Release `v0.3.0` 存在且是 **latest**；资产**恰好 3 个**；`latest.json` 的 `version` = **0.3.0**；
    正文末尾有 **sha256 表** ＋ attestation 验法。

⚠️ **为什么可以移动 tag**：`gh release create` 从没跑到 ⇒ **v0.3.0 Release 从未存在**
⇒ 没有任何已发布的产物被覆写。

---

## 五、明确**不做**

| 不做 | 理由 |
|---|---|
| 改 `scripts/publish-manifest.mjs` 的**功能** | 只修语法；清单的**形状与算法一字不动**（客户端 `electron/update.ts` 依赖它） |
| 把脚本改名成 `.ts` 再用 `tsx`/`ts-node` 跑 | 会给 CI **加依赖** ⇒ 违反「不引新 npm 依赖」；且 `.mjs` 是**既成事实**（工作流 YAML 与文档都按这个名字） |
| 在 workflow 里加「跳过写清单」的兜底 | 那是**发一个没有更新清单的 Release** ⇒ 客户端自动更新会坏 ⇒ **不做** |
| 改 v0.2.9 及更早的 tag | 它们发出去的 Release 都是好的（用的是旧脚本）⇒ 不追溯 |
| 为此新开一个 v0.3.1 | 用户已拍板：**移动 tag v0.3.0**（v0.3.0 从未发布过，移动不会覆写任何东西） |
