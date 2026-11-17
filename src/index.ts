// CAU MaaS (https://maas.cau.edu.cn) — New API 套壳,OpenAI 兼容 /v1。
// API Key 做 Bearer 即可覆盖聊天、模型列表、用量。
// 登录方式一:学号 + CAS 密码,纯 HTTP 跑完 SSO 链(sso.ts)后复用/创建 API Key。
// 登录方式二:直接粘贴 API Key。

import { loginWithCas } from "./sso"

const BASE = "https://maas.cau.edu.cn"
const PROVIDER_ID = "cau-maas"

const asJson = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
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
    icon: "https://www.cau.edu.cn/static2022/images/favicon.ico",
    methods: [
      {
        type: "api",
        label: "统一身份认证登录(学号 + CAS 密码)",
        keyless: true,
        prompts: [
          { type: "text", key: "username", message: "学号/工号" },
          { type: "password", key: "password", message: "统一身份认证密码" },
        ],
        async authorize(inputs: { username?: string; password?: string } | undefined) {
          try {
            if (!inputs?.username || !inputs.password)
              return { type: "failed" as const, error: "请输入学号和密码" }
            const r = await loginWithCas(inputs.username, inputs.password)
            return {
              type: "success" as const,
              key: r.apiKey,
              accountId: r.accountId,
              metadata: { email: r.userName },
            }
          } catch (e) {
            return {
              type: "failed" as const,
              error: e instanceof Error ? e.message : "SSO 登录失败",
            }
          }
        },
      },
      { type: "api", label: "直接粘贴 API Key", placeholder: "MaaS 个人中心 → API Key" },
    ],

    async loader(getAuth: () => Promise<{ type?: string; key?: string } | undefined>) {
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

    async usage(getAuth: () => Promise<{ type?: string; key?: string } | undefined>) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return { error: "未登录", signIn: "expired" as const }

      const headers = { authorization: `Bearer ${auth.key}`, accept: "application/json" }
      try {
        const [budget, user] = await Promise.all([
          fetch(`${BASE}/api/budget/me`, { headers }).then((r) =>
            asJson<{
              month_window?: { month_end_time_secs: number }
              member_monthly_used?: string
              effective_member_monthly_budget?: string
            }>(r),
          ),
          fetch(`${BASE}/api/user/current`, { headers }).then((r) =>
            asJson<{ user_name: string }>(r),
          ),
        ])

        const used = parseFloat(budget.member_monthly_used ?? "0")
        const limit = parseFloat(budget.effective_member_monthly_budget ?? "0")
        const until = budget.month_window?.month_end_time_secs

        return {
          user: user.user_name,
          plan: "CAU MaaS",
          until: until ? new Date(until * 1000).toISOString() : undefined,
          windows: [
            {
              name: "本月",
              // 金额为人民币元;limit=0 表示未设上限,仅展示已用
              display: limit > 0 ? `¥${used.toFixed(4)} / ¥${limit}` : `已用 ¥${used.toFixed(4)}`,
              ...(limit > 0 ? { amount: used, limit, unit: "¥" } : {}),
              resetsAt: until ? new Date(until * 1000).toISOString() : undefined,
            },
          ],
          signIn: "renewed" as const,
        }
      } catch (e) {
        const expired = /HTTP 401|HTTP 403/.test(String(e))
        return {
          error: expired ? "登录已过期" : "用量读取失败",
          signIn: expired ? ("expired" as const) : ("kept" as const),
        }
      }
    },
  },

  provider: {
    id: PROVIDER_ID,
    async models(provider: any, { auth }: { auth?: { type?: string; key?: string } } = {}) {
      if (auth?.type !== "api" || !auth.key) return provider.models
      const res = await fetch(`${BASE}/v1/models`, {
        headers: { authorization: `Bearer ${auth.key}` },
      })
      if (!res.ok) return provider.models
      const { data } = (await res.json()) as { data: { id: string; name?: string }[] }
      return Object.fromEntries(data.map((m) => [m.id, { id: m.id, name: m.name ?? m.id }]))
    },
  },
})

export default CauMaasPlugin
