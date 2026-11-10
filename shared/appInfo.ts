// ---------------------------------------------------------------------------
// 软件信息（T41）：开发者 / 公司 / 官网 / ICP 备案号
// ---------------------------------------------------------------------------
//
// ⚠️ **单一真相源**：设置页的「关于」分类要显示这些信息，安装包属性
//    （`electron-builder.yml` 的 `copyright`）与 `package.json` 的 `author`
//    也要写同一份 → 集中在这里，免得两处各写一遍、以后改了其中一处忘了另一处。
//
// ⚠️ **官网只能通过主进程用系统浏览器打开**：主窗口**没有** `setWindowOpenHandler`
//    → 渲染层里直接写 `<a href="https://…">`，点击会把**应用窗口整个导航走**
//    （应用界面被网站替换掉，等于把软件弄坏）。
//    ⇒ 渲染层只**发请求**，主进程用 `shell.openExternal` 开；并且**只允许白名单里的
//    https 域名**（`isAllowedExternalUrl`）→ 渲染层给什么 URL 都开不了别的站点。
// ---------------------------------------------------------------------------

/** 软件信息（关于页显示的就是这份）。 */
export const APP_INFO = {
  /** 应用名。 */
  name: 'Sanlos Music',
  /** 开发者。 */
  developer: 'pure2199',
  /** 公司（著作权人）。 */
  company: '广西闪链时空网络科技有限公司',
  /** 官网（**只能通过主进程**用系统浏览器打开，见文件头说明）。 */
  website: 'https://www.sanlos.cn',
  /** ICP 备案号。 */
  icp: '桂ICP备202507161号-1',
  /**
   * **项目地址**（源码仓库；T82 加）。
   *
   * ⚠️ 同样**只能通过主进程**用系统浏览器打开（见文件头说明）。
   */
  repository: 'https://github.com/pure2199/sanlos-music',
  /**
   * **自动更新源**（T82 加）：GitHub Release 的 `latest/download` 目录。
   *
   * ⚠️ 用 `releases/latest/download`（**不是**某个具体 tag 的目录）⇒
   *    **永远指向最新那版** ⇒ 发新版不用改代码。
   * ⚠️ 清单 `latest.json` 与安装包都在这同一个目录下 ⇒ 满足客户端
   *    「安装包必须与清单**同源**」的硬要求。
   */
  updateBaseUrl: 'https://github.com/pure2199/sanlos-music/releases/latest/download',
} as const

/**
 * 允许用系统浏览器打开的**主机名**白名单。
 *
 * ⚠️ **精确匹配**，**不做后缀匹配** → `sanlos.cn.evil.example` 不放行
 *    （后缀匹配会把 `evil-sanlos.cn` 之类一起放进来）。
 */
export const EXTERNAL_LINK_ALLOWED_HOSTS: readonly string[] = [
  'sanlos.cn',
  'www.sanlos.cn',
  // ⚠️ T82：项目地址在 GitHub 上 ⇒ 放行 `github.com`（仍是**精确匹配**）。
  'github.com',
]

/**
 * 判断一个 URL 是否允许用系统浏览器打开。
 *
 * 规则（**全部**满足才允许）：
 * - 协议必须是 `https:`（`http:` / `file:` / `javascript:` / `data:` 一律拒绝）；
 * - 主机名必须在 {@link EXTERNAL_LINK_ALLOWED_HOSTS} 里（精确匹配，忽略大小写）；
 * - **不许**带用户名 / 密码（`https://user:pass@sanlos.cn` → 拒绝）；
 * - 端口必须是默认的 443（`https://sanlos.cn:8443` → 拒绝）。
 *
 * @param raw 待判断的 URL 字符串。
 * @returns 允许返回 `true`。
 */
export function isAllowedExternalUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false
  const text = raw.trim()
  if (text.length === 0) return false

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }

  if (url.protocol !== 'https:') return false
  if (url.username.length > 0 || url.password.length > 0) return false
  // ⚠️ `new URL('https://sanlos.cn:443/')` 的 `port` 是空串（默认端口被归一化）
  //    → 这里只剩「非默认端口」这一种情况要拒。
  if (url.port.length > 0) return false

  return EXTERNAL_LINK_ALLOWED_HOSTS.includes(url.hostname.toLowerCase())
}
