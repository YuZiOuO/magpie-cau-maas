# CAU MaaS — Magpie 插件

将 [maas.cau.edu.cn](https://maas.cau.edu.cn)(中国农业大学 MaaS 平台,New API 套壳,OpenAI 兼容)接入 Magpie,支持统一身份认证登录与用量显示。

## 安装

```bash
magpie plugin add /path/to/cau-maas   # 本地目录开发
magpie plugin login cau-maas          # 登录
magpie quota                          # 查看用量
```

## 登录方式

1. **统一身份认证登录(浏览器)**:插件打开浏览器,完成 CAU 统一身份认证后,在 MaaS 的「API Key」页面复制 API Key 粘贴回 Magpie。插件会用 Key 换取会话 cookie 一并保存。
2. **直接粘贴 API Key**:已有 Key 时直接使用。

> 为什么浏览器登录后仍需粘贴一次 Key?MaaS 是会话制鉴权(非 OAuth 跳转),浏览器登录态无法自动回传给插件;而 `jwt_token` 仅约 3 天有效,API Key 长期有效且权限等价(聊天、模型列表、用量查询均可),故以 Key 作为主凭证。

## 功能

- **聊天**:注册 OpenAI 兼容 provider(`https://maas.cau.edu.cn/v1`),自动注入 `Authorization: Bearer <api-key>`
- **用量显示**:查询 `/api/budget/me`,展示本月已用金额(或预算剩余)与账期结束时间
- **凭证验证**:登录时即调用 `/api/auth/login` 验证 Key 有效性,避免存下无效凭证

## 实现要点

平台对 Magpie 暴露的接口全部可用 Bearer API Key 访问:

| 接口 | 用途 |
|---|---|
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | 聊天(OpenAI 兼容) |
| `GET /api/budget/me` | 本月用量 / 预算 |
| `GET /api/user/current` | 用户信息 |
| `POST /api/auth/login` `{api_key}` | Key 换会话 cookie(验证 Key) |

## 开发

```bash
bun install
bunx tsc --noEmit   # 类型检查
```

入口为 `src/index.ts`(Magpie 插件由 Bun 直接加载 TS,无需构建)。修改后重新 `magpie plugin add .` 生效。
