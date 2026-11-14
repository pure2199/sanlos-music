# 第三方组件声明（Third-Party Notices）

本项目（Sanlos Music / fnmusic-desktop）自身协议见 [`LICENSE`](./LICENSE)（MIT）。
本文件声明**仓库内直接移植或引用**的第三方代码。

---

## 1. lx-music-desktop（洛雪音乐）—— QQ 逐字歌词（QRC）解密

| 项 | 内容 |
| --- | --- |
| 上游项目 | [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) |
| 上游文件 | `src/renderer/utils/musicSdk/tx/qrcDecode.js` |
| 协议 | **Apache License 2.0**（协议正文见本文末尾） |
| 移植到 | [`electron/lyricCodecs/qrc.ts`](./electron/lyricCodecs/qrc.ts) |

### 移植内容

上游 `qrcDecode.js` 里的 **3DES（DES-EDE3）解密核心**与 **zlib inflate** 流程：

- DES 的 S 盒、密钥置换表、压缩置换表、轮密钥编排、初始置换 / 逆置换、Feistel 轮函数；
- 3DES 的 EDE 三组编排与分组加解密；
- 「hex → 字节 → 3DES（ECB、无填充）→ zlib inflate → UTF-8」的管线。

### 本仓库的改动（逐条列出）

1. **改写为 TypeScript**（严格模式，补齐类型标注）；
2. **S 盒表拆成「基础表 + 两处补丁」**：上游把非标准表整体硬编码；本仓库把
   「基础表」与 `QRC_PATCHES`（`S2[23]=15`、`S4[53]=10`）分开，并额外导出
   `QRC_SBOX_WITH_STANDARD_VALUES`（把两处改回标准值）**仅供单测做差分断言**；
3. **抽出 `decrypt3des` / `encrypt3des`**（上游只导出 `decodeQrc`）；
4. **`inflate` 的失败处理**：上游吞掉 `Z_BUF_ERROR`；本仓库显式 `try/catch`，
   失败时返回**空串**（**不抛异常**）；
5. **补 `node:zlib` 的显式导入**（上游用 `from 'zlib'`，本仓库用 `node:zlib`）；
6. **上游的 `decodeQrc` 只解不解转**；本仓库另在
   [`electron/lyricWordFormat.ts`](./electron/lyricWordFormat.ts) 里补了
   **QRC → 增强 LRC** 的转换器与**元信息行过滤**（这部分**不是**上游代码）。

### 说明

- 上游协议允许商用与再分发；本仓库保留其版权与许可声明，并遵守
  「保留 NOTICE / 注明修改」的条款；
- ⚠️ **不附带上游的任何资源文件**（图标、界面、歌词库一律没有），
  只移植了上述算法实现；
- ⚠️ 上游的「搜索请求签名」（`signRequest`）**未被采用**（本仓库另用免签名的公开接口）。

---

## 2. 各音乐平台的公开 Web 接口

本仓库的歌词源（网易云 / QQ 音乐 / 酷狗 / 酷我 / 咪咕）调用的是这些平台的
**非官方公开 Web 接口**。

- 这些接口**没有**第三方开源许可可依 —— 它们是各平台的公开 HTTP 接口；
- ⚠️ **没有 SLA、条款上属灰色、接口可能变更**；
- ⚠️ 本仓库**不附带**任何平台账号、Cookie、token 或其他用户凭证
  （取词请求走**干净的** Chromium 分区栈，不附 NAS 凭证）；
- ⚠️ 平台的**歌词内容版权**属于各自的权利人；本项目只做**运行时在线获取与显示**，
  **不在仓库里存放任何歌词内容**（连测试用的密文都是**占位歌词**造的）。

---

## 3. lx-music-desktop（洛雪音乐）—— 咪咕逐字歌词（mrc）解密

| 项 | 内容 |
| --- | --- |
| 上游项目 | [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) |
| 上游文件 | `src/renderer/utils/musicSdk/mg/utils/mrc.js`（另有同源的 `mg/lyric.js` 里的**解析**口径） |
| 协议 | **Apache License 2.0**（协议正文见本文末尾） |
| 对应到 | [`electron/lyricCodecs/migu.ts`](./electron/lyricCodecs/migu.ts) |

### 声明的算法口径

咪咕的 mrc 载荷是 **hex 文本密文**，解密是一条**公开算法**（多家社区实现口径一致）：

- 每 **16 个 hex 字符** = 1 个 **64 位**字（`BigInt`，按有符号解释）；
- **TEA 变体**解密（⚠️ **不是**标准 TEA：标准 TEA 是 32 位字长）——
  轮数 `6 + floor(52 / n)`、密钥下标 `(3 & i) ^ (3 & (sum >> 2))`；
- 密钥是 **9 个 64 位常量**，但下标恒在 `0…3` ⇒ **实际只用前 4 个**；
- 解出的字按 **8 字节小端**拼成字节流，再按 **UTF-16LE** 解码。

### 本仓库的做法

1. **按算法自行实现**（`electron/lyricCodecs/migu.ts`，TypeScript 严格模式，
   `BigInt` + 64 位回绕）——⚠️ **未移植上游任何一行代码**；
2. ✅ **正确性锚点 = 与上游逐字节差分**：用**同一份真实载荷**，
   比对本仓库实现与上游快照的输出 ⇒ 必须**逐字节相等**
   （实测 26/26 份真实载荷全等；脚本见 `release/verify/`）；
3. 单测用**自己合成**的明文 + **独立手写**的加密器
   （⚠️ 加密器已与**上游解密器**验过互逆 ⇒ 排除「加密解密一起错」的假绿）；
4. ⚠️ **不附带上游的任何资源文件**，也**不把任何真实密文放进仓库**
   （咪咕的密钥是公开的 ⇒ 真实密文入库 = 把歌词放进公开仓库）。

### 其它咪咕接口

- 搜索端点（`jadeite.migu.cn`）的 **MD5 签名**（固定客户端密钥 + 时间戳）
  属于**接口调用约定**，与上游的代码实现无关；
- mrc → 增强 LRC 的**转换器**（[`electron/lyricWordFormat.ts`](./electron/lyricWordFormat.ts)）
  与**元信息行过滤**是本仓库**自行实现**的（不是上游代码）。

---

## 4. 运行时依赖

本项目的依赖清单见 [`package.json`](./package.json)（全部为 MIT / Apache-2.0 / BSD 等
宽松协议的 npm 包），随 npm 分发时各自的许可证随包附带。

---

## 附录：Apache License 2.0 全文

以下为上游 lx-music-desktop 所用的 Apache License 2.0 全文
（逐字节取自上游仓库的 `LICENSE` 文件）。

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

