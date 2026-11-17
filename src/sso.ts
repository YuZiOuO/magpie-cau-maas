// 纯 HTTP CAS 统一身份认证登录(无浏览器):
//   1. /api/auth/cau/start → OIDC → CAS 登录页(拿 lt/execution)
//   2. rsa = strEnc(学号+密码+lt,'1','2','3')(平台原版 des.js,见 des-loader.ts)
//   3. POST CAS 登录 → 302 ticket 回跳 → Set-Cookie jwt_token
//   4. 用 jwt 复用/创建 API Key;jwt 仅作中间态,不返回

import { strEnc } from "./des-loader"

const BASE = "https://maas.cau.edu.cn"
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const asJson = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

// cookie jar:domain → Map(name → value)
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

async function fetchWithJar(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
  redirect: "follow" | "manual" = "manual",
): Promise<Response> {
  const domain = new URL(url).hostname
  const headers = new Headers(init.headers)
  headers.set("user-agent", BROWSER_UA)
  const cookie = jar.header(domain)
  if (cookie) headers.set("cookie", cookie)
  const res = await fetch(url, { ...init, headers, redirect })
  jar.set(domain, res.headers.getSetCookie())
  return res
}

// 跟踪重定向链,拿到 maas 的 jwt_token 即停
async function followRedirects(
  jar: CookieJar,
  startUrl: string,
): Promise<{ finalUrl: string; jwt: string | null }> {
  let url = startUrl
  for (let i = 0; i < 20; i++) {
    const res = await fetchWithJar(jar, url)
    const jwt = jar.get("maas.cau.edu.cn", "jwt_token")
    if (jwt) return { finalUrl: url, jwt }
    const loc = res.headers.get("location")
    if (!loc) break
    url = loc.startsWith("http") ? loc : new URL(loc, url).href
  }
  return { finalUrl: url, jwt: jar.get("maas.cau.edu.cn", "jwt_token") ?? null }
}

export interface SsoLoginResult {
  userName: string
  apiKey: string
  accountId: string
}

export async function loginWithCas(username: string, password: string): Promise<SsoLoginResult> {
  const jar = new CookieJar()

  // 1. 走 OIDC 链到 CAS 登录页
  const { finalUrl: casLoginUrl } = await followRedirects(jar, `${BASE}/api/auth/cau/start`)
  if (!casLoginUrl.includes("onecas.cau.edu.cn/tpass/login")) {
    throw new Error(`未到达 CAS 登录页,停在 ${casLoginUrl}`)
  }

  // 2. 提取 lt/execution
  const html = await (await fetchWithJar(jar, casLoginUrl, {}, "follow")).text()
  const lt = html.match(/name="lt"\s+value="([^"]+)"/)?.[1]
  const execution = html.match(/name="execution"\s+value="([^"]+)"/)?.[1]
  if (!lt || !execution) throw new Error("CAS 登录页缺少 lt/execution")

  // 3. 加密并提交;失败返回 200 错误页,成功 302 带 ticket
  const submitRes = await fetchWithJar(
    jar,
    casLoginUrl,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        rsa: strEnc(username + password + lt, "1", "2", "3"),
        ul: String(username.length),
        pl: String(password.length),
        sl: "0",
        lt,
        execution,
        _eventId: "submit",
      }).toString(),
    },
    "manual",
  )
  if (submitRes.status !== 302) {
    const errMsg =
      (await submitRes.text()).match(/id="errormsg"[^>]*>([^<]+)</)?.[1] ?? "账号或密码错误"
    throw new Error(`CAS 登录失败: ${errMsg}`)
  }
  const callbackUrl = submitRes.headers.get("location")
  if (!callbackUrl?.includes("ticket=")) throw new Error("CAS 登录成功但未返回 ticket")

  // 4. 跟回跳链拿 jwt
  const { jwt } = await followRedirects(jar, callbackUrl)
  if (!jwt) throw new Error("回跳链未捕获到 jwt_token")

  // 5. 换 API Key:只认名为 "magpie" 的,没有则以 "magpie" 为名创建
  const headers = { cookie: `jwt_token=${jwt}`, accept: "application/json" }
  const user = await fetch(`${BASE}/api/user/current`, { headers }).then((r) =>
    asJson<{ user_name: string; user_id: number }>(r),
  )
  const { keys } = await fetch(`${BASE}/api/user/api_keys/?user_id=${user.user_id}`, {
    headers,
  }).then((r) =>
    asJson<{ keys?: { api_key: string; name: string; status: string }[] }>(r),
  )
  let apiKey = keys?.find((k) => k.name === "magpie" && k.status === "ACTIVE")?.api_key
  if (!apiKey) {
    const created = await fetch(`${BASE}/api/user/api_keys/`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: user.user_id,
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
