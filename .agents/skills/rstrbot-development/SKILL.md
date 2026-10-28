---
name: rstrbot-development
description: Use when changing RstrBot core, web UI, API, persistence, deployment, or repository documentation.
---

# RstrBot development

## Start here

1. Read the root `AGENTS.md` and preserve unrelated work in the checkout.
2. Read `README.md`, `docs/API_CONTRACT.md`, and the relevant module docs before changing behavior.
3. Use the versions in `mise.toml`. Do not silently raise or lower the supported toolchain.
4. Check `git status` and the current API contract before editing. The contract and OpenAPI schema are the source of truth for UI choices and backend behavior.

## Product and implementation boundaries

- Keep authorization, validation, and durable state enforcement on the server. A hidden or disabled UI control is not an access check.
- Do not invent resource fields, enum values, provider types, capability support, success states, or retry safety. Derive finite choices from the contract or server response; keep genuinely open text fields editable.
- Treat secrets as write-only. Never put credentials in logs, rendered summaries, links, or errors.
- Preserve the distinction between rejected, failed, unknown, and completed external operations. Do not replay a mutation after an uncertain response unless its contract provides idempotency.
- Keep English and Chinese copy in separate language branches. Use short, plain wording and light original humor only where it does not obscure risk or status.
- Prefer spacing and grouping over decorative rules. Keep keyboard focus, screen-reader names, touch targets, reduced-motion behavior, and narrow-screen layouts usable.
- Keep the root `recipes/rstrbot/BUILD_PROMPT.md` current when a user requests a product improvement; standalone generated source carries `docs/RECIPE_BUILD_PROMPT.md`, and old blueprint prompts remain historical. Record the requirement and its observable acceptance conditions without claiming it is already implemented.

## Verification

Use the smallest relevant local checks first. The repository-wide local check is `mise exec -- ./scripts/check.sh`. Report which checks ran and their result; a successful build does not prove browser, production, or device acceptance.

Browser-local drafts and versions are private user state: scope them by instance origin and authenticated user, retain unattributed legacy records without automatic adoption, and clear stale views on session changes. Use the real read-only schedule preview. Preserve uncertain requests for record review and explicit idempotent continuation, never automatic replay. Run `tests/browser/verify_feedback.mjs` and relevant configuration regressions against an isolated instance; report real-provider and native-device acceptance separately.

Provider rejection codes `-32041`, `-32043`, and `-32029` have optional 1.0-compatible behavior documented in `docs/PLUGIN_PROTOCOL.md`. Preserve generic fallback for old workers/hosts, do not reveal response bodies, and test each SDK runtime separately. The source lives in the pinned implementation submodule; it is not part of the recipe payload.

1.16 用户确认 MaiBot 为对比对象。首次对话默认不为标题另发模型请求；可选模型标题需用户主动启用并说明请求、费用和数据范围。按RSTRBOT-22核对账本，模拟结果不代表整体领先。

1.17 按 R13-OC-185423 验证可选供应商回退：复用已接纳消息，真冲突和 unknown 禁止回退；没有实现或实际账本时保持 gap/not_executed。

1.18 会话按已接纳发送恢复模型；缺绑定或模型失效时显式选择，共享会话拒绝私有模型。按 RSTRBOT-24 核对实际地址、隐私、重启和幂等。

1.19 按 RSTRBOT-25 检查长草稿视口重排，区分末尾编辑与手动滚动阅读；模拟浏览器单路径不能代替输入法、实体手机和全矩阵验收。

1.20 按 RSTRBOT-26 验证确认丢失后的刷新、请求参数和明确新意图；本地存储不代表跨设备或并发标签页的原子协调。

1.21 按 RSTRBOT-27 验证同源多标签页意图协调和过期确认；不支持协调时暂停发送，不能推导跨设备幂等。

1.22 按 RSTRBOT-28 验证知识原文仅进入授权模型上下文，不复制到新引用记录；旧引用响应去除原文。模型回答、旧数据库与备份、在途撤权不归入已解决范围。

1.23 按 RSTRBOT-29 核对资料入口、当前授权、原文版本与 UTF-8 字节位置；候选来源不代表模型已引用，失效或切换不能显示旧原文。

1.24 按 RSTRBOT-31 区分已发布索引与旧读快照；多连接、外部索引和未运行后端分别取证，不能把单实例词法通过扩成全部路径。

1.24 按 RSTRBOT-32 注入已就绪索引损坏，确认检索明确异常、模型零调用、修复可恢复，且无权和停用来源不干扰其他受众。

1.25 按 RSTRBOT-33 核对计划终态与最近运行结果，并用隔离模型账本核对失败和进程中断后的重启次数；不得用计划完成标签掩盖执行失败。

1.26 按 RSTRBOT-34 验证中断计划的显式核对、原子事件和独立恢复，核对不等于确认外部结果，也不得重放旧意图。
