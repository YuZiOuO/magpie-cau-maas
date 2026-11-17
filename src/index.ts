// CAU MaaS (https://maas.cau.edu.cn) — New API 套壳,OpenAI 兼容 /v1。
// 会话制鉴权(非 OIDC 跳转):POST /api/auth/login {api_key} 拿 Set-Cookie jwt_token。
// API Key 本身即可做 Bearer:聊天(/v1)、模型列表、用量(/api/budget/me)全通。
//
// 登录流程(SSO 方法):magpie 打开浏览器 → 用户完成 CAU 统一身份认证 →
// 在 MaaS 的「API Key」页面复制 key 粘回 → 插件用 key 换会话 cookie 一并保存。
// (浏览器登录态在浏览器里,插件无法直接读 cookie;jwt_token 有效期仅 ~3 天,
//  而 API Key 长期有效且权限等价,所以以 key 为主凭证。)

const BASE = "https://maas.cau.edu.cn"
const PROVIDER_ID = "cau-maas"

interface LoginResponse {
  user_name: string
}

interface BudgetResponse {
  month_window?: { month_begin_time_secs: number; month_end_time_secs: number }
  member_monthly_used?: string
  effective_member_monthly_budget?: string
}

interface CurrentUserResponse {
  user_name: string
}

interface StoredAuth {
  type?: string
  key?: string
  cookie?: string
}

type UsageResult =
  | {
      user: string
      plan: string
      balance: number
      renew: boolean
      until?: string
      signIn: "renewed"
    }
  | { error: string; signIn: "expired" | "kept" }

const asJson = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

// 用 API Key 换 jwt cookie
async function loginWithApiKey(
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ userName: string; cookie: string }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
    signal,
  })
  const data = await asJson<LoginResponse>(res)
  const cookie = (res.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.split(";")[0]!.trim())
    .filter((c) => c.startsWith("jwt_token="))
    .join("; ")
  return { userName: data.user_name, cookie }
}

export const CauMaasPlugin = async () => ({
  async config(cfg: any) {
    cfg.provider ??= {}
    cfg.provider[PROVIDER_ID] ??= {
      name: "CAU MaaS",
      npm: "@ai-sdk/openai-compatible",
      api: `${BASE}/v1`,
      models: {},
    }
  },

  auth: {
    provider: PROVIDER_ID,
    methods: [
      {
        type: "oauth",
        label: "统一身份认证登录(浏览器)",
        async authorize() {
          return {
            url: `${BASE}/`,
            instructions:
              "浏览器中完成 CAU 统一身份认证后,进入 MaaS 的「API Key」页面,复制你的 API Key 粘贴到此处。",
            method: "code",
            async callback(code: string, { signal }: { signal?: AbortSignal }) {
              const apiKey = code.trim()
              try {
                const { userName, cookie } = await loginWithApiKey(apiKey, signal)
                return {
                  type: "success" as const,
                  key: apiKey,
                  accountId: userName,
                  metadata: { email: userName },
                  cookie,
                }
              } catch {
                return { type: "failed" as const, error: "API Key 无效或网络错误" }
              }
            },
          }
        },
      },
      {
        type: "api",
        label: "直接粘贴 API Key",
        placeholder: "MaaS 个人中心 → API Key",
      },
    ],

    async loader(getAuth: () => Promise<StoredAuth | undefined>) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      const key = auth.key
      return {
        baseURL: `${BASE}/v1`,
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${key}`)
          return fetch(input, { ...init, headers })
        },
      }
    },

    async usage(getAuth: () => Promise<StoredAuth | undefined>): Promise<UsageResult> {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return { error: "未登录", signIn: "expired" }

      const headers = { authorization: `Bearer ${auth.key}`, accept: "application/json" }
      try {
        const [budget, user] = await Promise.all([
          fetch(`${BASE}/api/budget/me`, { headers }).then((r) => asJson<BudgetResponse>(r)),
          fetch(`${BASE}/api/user/current`, { headers }).then((r) =>
            asJson<CurrentUserResponse>(r),
          ),
        ])

        const used = parseFloat(budget.member_monthly_used ?? "0")
        const budgetLimit = parseFloat(budget.effective_member_monthly_budget ?? "0")
        const until = budget.month_window?.month_end_time_secs

        return {
          user: user.user_name,
          plan: "CAU MaaS",
          // 平台金额为人民币元;"0" 表示未设上限,此时仅展示已用
          balance: budgetLimit > 0 ? Math.max(budgetLimit - used, 0) : used,
          renew: budgetLimit > 0,
          until: until ? new Date(until * 1000).toISOString() : undefined,
          signIn: "renewed",
        }
      } catch (e) {
        const expired = /HTTP 401|HTTP 403/.test(String(e))
        return {
          error: expired ? "登录已过期" : "用量读取失败",
          signIn: expired ? "expired" : "kept",
        }
      }
    },
  },
})

export default CauMaasPlugin
