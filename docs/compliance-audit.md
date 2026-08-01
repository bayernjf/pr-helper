# PR Helper 合规审计报告

> 审计日期：2026-08-01
> 审计范围：P0–P4 质量改进批次交付后、上线前
> 审计依据：代码静态分析 + 架构文档审查

## 一、凭证安全

| 项目 | 状态 | 详情 |
|---|---|---|
| GitHub App Private Key | ✅ 合规 | 仅存服务端环境变量 `GITHUB_APP_PRIVATE_KEY`，不进浏览器和数据库 |
| OAuth Client Secret | ✅ 合规 | 仅存服务端环境变量 `GITHUB_APP_CLIENT_SECRET` |
| Installation Token | ✅ 合规 | 短期生成，仅服务端使用，不持久化 |
| Session Cookie | ✅ 合规 | `HttpOnly; Secure; SameSite=Lax`，签名防篡改 |
| Session Secret | ✅ 合规 | 通过 `AUTH_SESSION_SECRET` 环境变量注入 |
| AI API Key | ✅ 合规 | 仅存浏览器 `sessionStorage`，不传服务端、不持久化 |
| GitHub PAT（开发回退） | ⚠️ 注意 | `sessionStorage` 存储 PAT，XSS 可读取；标记为开发用途，生产走 GitHub App |

## 二、数据隐私

| 数据 | 存储位置 | 风险 |
|---|---|---|
| GitHub 用户名、ID | Supabase Postgres | 🟢 低 — 用户主动授权 |
| 流程配置、阶段状态 | Supabase Postgres | 🟢 低 — 用户自己配置的数据 |
| PR 草稿、生成规则 | 浏览器 localStorage | 🟢 低 — 不离开用户设备 |
| 加密云同步密文 | Supabase Postgres | 🟢 低 — 服务端无法解密 |
| **隐私政策** | ✅ 已交付 | `public/privacy.html`，连接页和账户菜单均有入口 |
| **数据删除机制** | ✅ 已交付 | `DELETE /api/account` + 账户菜单「删除账号」按钮 + 输入 DELETE 确认 |

## 三、GitHub App 权限

| 权限 | 当前设置 | 评估 |
|---|---|---|
| Actions | Read & write | ✅ 必要 — 读取运行状态、重跑失败 Actions |
| Contents | Read-only | ✅ 合理 — 只需读分支和 PR |
| Pull requests | Read & write | ✅ 必要 — 创建/合并 PR |
| 权限最小化 | 🟢 基本合规 | 未发现超出产品功能需要的权限 |
| 权限变更通知 | ✅ 已交付 | 应用内权限说明对话框（连接页 + 账户菜单均可打开） |

## 四、Cookie 与追踪

| 项目 | 状态 |
|---|---|
| Cookie 属性 | ✅ `HttpOnly; Secure; SameSite=Lax` |
| 第三方追踪 Cookie | ✅ 无 — 未使用任何分析/追踪 SDK |
| 跨站请求伪造防护 | ✅ `SameSite=Lax` + 签名 session |
| Cookie 同意提示 | ⚠️ 非必需 — 仅功能 Cookie，无追踪 Cookie，GDPR 下可豁免同意 |

## 五、加密与数据保护

| 项目 | 状态 | 评估 |
|---|---|---|
| 传输加密 | ✅ HTTPS | Vercel/Cloudflare 均强制 HTTPS |
| 静态加密（云同步） | ✅ AES-GCM 256 | 密钥派生 PBKDF2-SHA256, 600k 迭代 |
| 数据库加密 | ✅ Supabase 托管 | Supabase 提供 at-rest 加密 |
| 密钥管理 | 🟡 原型 | 口令仅存内存，刷新丢失；正式启用前仍需设计密钥轮换、恢复和冲突处理 |

## 六、第三方服务合规

| 服务 | 数据处理 | 评估 |
|---|---|---|
| Vercel | API + 前端托管 | 🟢 标准 DPA |
| Cloudflare Pages | 前端镜像 | 🟢 标准 DPA |
| Supabase | Postgres 数据库 | 🟢 标准 DPA，AWS 托管 |
| GitHub | OAuth + App + API | 🟢 标准 DPA |
| OpenAI 兼容 API | AI 生成（用户自选） | 🟡 用户自行选择 endpoint，数据流向用户控制 |

## 七、上线前合规待办

| # | 项目 | 优先级 | 状态 |
|---|---|---|---|
| 1 | **添加 Privacy Policy** | 🔴 高 | ✅ 已交付 — `public/privacy.html`，覆盖数据收集、存储、第三方服务、用户权利、数据删除 |
| 2 | **数据删除机制** | 🟡 中 | ✅ 已交付 — `DELETE /api/account` + 前端确认对话框（输入 DELETE），级联删除所有用户数据 |
| 3 | **GitHub App 权限文档** | 🟡 中 | ✅ 已交付 — 应用内权限说明对话框，列出每项权限及用途，支持跳转 GitHub 管理 |
| 4 | Terms of Service | 🟢 低（个人项目可暂缓） | ❌ 缺失 |
| 5 | 凭证安全 | ✅ 已合规 | — |
| 6 | Cookie/Session 安全 | ✅ 已合规 | — |
| 7 | 传输加密 | ✅ 已合规 | — |
| 8 | 加密云同步 | ✅ 原型状态安全 | 密钥管理和线上回归仍待完成 |

## 八、总结

**技术安全层面基本合规**：凭证不泄露、Cookie 属性正确、传输全 HTTPS、加密标准够高。

**法律合规层面基本补齐**：

- ✅ Privacy Policy 已交付 — 覆盖数据收集范围、存储位置、第三方服务、用户权利、数据删除说明
- ✅ 数据删除已交付 — 用户可自助删除账号和全部关联数据（CASCADE）
- ✅ 权限说明已交付 — 应用内权限说明对话框，连接页和账户菜单均可打开
- 如面向外部用户，可考虑补充 Terms of Service

## 九、建议实施顺序

1. ~~起草 Privacy Policy~~ ✅ 已交付
2. ~~实现数据删除 API~~ ✅ 已交付
3. ~~在应用内添加权限说明~~ ✅ 已交付
4. 如面向外部用户，补充 Terms of Service
