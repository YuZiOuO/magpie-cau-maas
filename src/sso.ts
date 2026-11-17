// 纯 HTTP CAS 统一身份认证登录(无浏览器)。
// 流程:
//   1. GET /api/auth/cau/start → OIDC authorize → CAS 登录页(拿 lt/execution/JSESSIONID)
//   2. rsa = strEnc(un+pd+lt, '1','2','3')(Bun vm 跑平台原版 des.js)
//   3. POST /tpass/login → 302 到 /oidc/upstream/callback/cas?ticket=...
//   4. 跟回跳链 → /api/auth/external/cau/callback 的 Set-Cookie 捕获 jwt_token
//   5. 用 jwt 换 API Key;jwt 仅作中间态,不返回

import vm from "node:vm"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = "https://maas.cau.edu.cn"
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// 加载平台原版 des.js,拿到 strEnc
const desSandbox: { strEnc?: (data: string, k1: string, k2: string, k3: string) => string } = {}
vm.createContext(desSandbox)
vm.runInContext(readFileSync(join(__dirname, "des.js"), "utf-8"), desSandbox)
const strEnc = desSandbox.strEnc!
if (!strEnc) throw new Error("des.js 未导出 strEnc")

export interface SsoLoginResult {
  userName: string
  apiKey: string
  accountId: string
}

const asJson = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

// cookie jar:domain -> Map(name -> value)
class CookieJar {
  private store = new Map<string, Map<string, string>>()

  set(domain: string, setCookies: string[]) {
    if (!this.store.has(domain)) this.store.set(domain, new Map())
    const jar = this.store.get(domain)!
    for (const sc of setCookies) {
      const [pair] = sc.split(";")
      const eq = pair!.indexOf("=")
      if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim())
    }
  }

  header(domain: string): string {
    const jar = this.store.get(domain)
    if (!jar || jar.size === 0) return ""
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
  }

  get(domain: string, name: string): string | undefined {
    return this.store.get(domain)?.get(name)
  }
}

const domainOf = (url: string) => new URL(url).hostname

async function fetchWithJar(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
  redirect: "follow" | "manual" = "manual",
): Promise<Response> {
  const domain = domainOf(url)
  const headers = new Headers(init.headers)
  headers.set("user-agent", BROWSER_UA)
  const cookie = jar.header(domain)
  if (cookie) headers.set("cookie", cookie)
  const res = await fetch(url, { ...init, headers, redirect })
  jar.set(domain, res.headers.getSetCookie())
  return res
}

// 跟踪重定向链,直到拿到最终 Set-Cookie jwt_token
async function followRedirects(
  jar: CookieJar,
  startUrl: string,
  maxHops = 20,
): Promise<{ finalUrl: string; jwt: string | null }> {
  let url = startUrl
  for (let i = 0; i < maxHops; i++) {
    const res = await fetchWithJar(jar, url, {}, "manual")
    // 任何时候拿到 maas 的 jwt_token 就停
    const jwt = jar.get("maas.cau.edu.cn", "jwt_token")
    if (jwt) return { finalUrl: url, jwt }
    const loc = res.headers.get("location")
    if (!loc) break
    url = loc.startsWith("http") ? loc : new URL(loc, url).href
  }
  return { finalUrl: url, jwt: jar.get("maas.cau.edu.cn", "jwt_token") ?? null }
}

export async function loginWithCas(username: string, password: string): Promise<SsoLoginResult> {
  const jar = new CookieJar()

  // 1. 走 OIDC 链到 CAS 登录页
  const { finalUrl: casLoginUrl } = await followRedirects(jar, `${BASE}/api/auth/cau/start`)
  if (!casLoginUrl.includes("onecas.cau.edu.cn/tpass/login")) {
    throw new Error(`未到达 CAS 登录页,停在 ${casLoginUrl}`)
  }

  // 2. 拿登录页提取 lt/execution
  const loginPageRes = await fetchWithJar(jar, casLoginUrl, {}, "follow")
  const html = await loginPageRes.text()
  const lt = html.match(/name="lt"\s+value="([^"]+)"/)?.[1]
  const execution = html.match(/name="execution"\s+value="([^"]+)"/)?.[1]
  if (!lt || !execution) throw new Error("CAS 登录页缺少 lt/execution")

  // 3. 加密并提交
  const rsa = strEnc(username + password + lt, "1", "2", "3")
  const form = new URLSearchParams({
    rsa,
    ul: String(username.length),
    pl: String(password.length),
    sl: "0",
    lt,
    execution,
    _eventId: "submit",
  })
  const submitRes = await fetchWithJar(
    jar,
    casLoginUrl,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    "manual",
  )

  // 登录失败会返回 200(错误页);成功是 302 到回跳 URL
  if (submitRes.status !== 302) {
    const errHtml = await submitRes.text()
    const errMsg = errHtml.match(/id="errormsg"[^>]*>([^<]+)</)?.[1] ?? "账号或密码错误"
    throw new Error(`CAS 登录失败: ${errMsg}`)
  }

  const callbackUrl = submitRes.headers.get("location")
  if (!callbackUrl || !callbackUrl.includes("ticket=")) {
    throw new Error("CAS 登录成功但未返回 ticket")
  }

  // 4. 跟回跳链拿 jwt
  const { jwt } = await followRedirects(jar, callbackUrl)
  if (!jwt) throw new Error("回跳链未捕获到 jwt_token")

  // 5. 换 API Key
  const headers = { cookie: `jwt_token=${jwt}`, accept: "application/json" }
  const user = await fetch(`${BASE}/api/user/current`, { headers }).then((r) =>
    asJson<{ user_name: string; user_id: number }>(r),
  )

  const keysRes = await fetch(`${BASE}/api/user/api_keys/?user_id=${user.user_id ?? 0}`, {
    headers,
  }).then((r) =>
    asJson<{ keys?: { api_key: string; is_default: boolean; status: string }[] }>(r),
  )
  const existing =
    keysRes.keys?.find((k) => k.is_default && k.status === "ACTIVE") ?? keysRes.keys?.[0]

  let apiKey = existing?.api_key
  if (!apiKey) {
    const created = await fetch(`${BASE}/api/user/api_keys/`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: user.user_id ?? 0,
        name: "magpie",
        allowed_ip_networks: [],
        allowed_ip_networks_enabled: false,
      }),
    }).then((r) => asJson<{ api_key?: string; key?: string }>(r))
    apiKey = created.api_key ?? created.key
  }
  if (!apiKey) throw new Error("未能获取或创建 API Key")

  return { userName: user.user_name, apiKey, accountId: user.user_name }
}
