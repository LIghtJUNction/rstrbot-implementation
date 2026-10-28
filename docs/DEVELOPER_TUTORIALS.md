# 开发者教程

本页提供可直接执行的起步流程；教程页内也嵌入了这些关键步骤。项目完整约束以本仓库 README、HTTP 契约和插件协议为准。

## 1. 准备环境并启动本地服务

从仓库根目录安装 `mise.toml` 锁定的 Rust、Node.js、Python、uv 与 .NET SDK：

```sh
mise install
```

构建 WebUI 并启动核心服务：

```sh
mise exec -- npm --prefix web run build
mise exec -- cargo run --locked -- --web-dir web/dist
```

核心默认在本机 `127.0.0.1:8787` 提供页面和 API。首次启动要按 [README 的运行说明](../README.md#使用-linux-运行包) 完成本机初始化；源码构建、数据库、数据目录和密钥的说明也在 README 中。只开发 WebUI 时可以另开 Vite 开发服务器：

```sh
mise exec -- npm --prefix web run dev -- --port 8788
```

它把 `/api` 和 `/health` 转发到本机 8787 端口，前提是核心服务已经启动。

## 2. 从只读工具开始做插件

建议从任意一个 SDK 的 echo 示例开始，按以下顺序推进：

1. 实现 JSON-RPC 2.0 初始化、能力发现和样例工具。
2. 插件清单只声明实现了的协议版本、能力、配置项和工具；声明不授予用户、工作区或实例权限。
3. 先让工具使用 `read_only` 副作用等级。需要写入或外部发送时，按协议声明真实副作用并处理审批、取消、超时和不确定结果。
4. 运行该语言的一致性向量，并检查标准输出只写协议帧、日志写标准错误。
5. 由实例管理员安装插件程序和清单，再由工作区授权成员创建实例。工作区实例默认停用；核对配置、权限披露与目标后再启用。

先构建所需的样例，再从仓库根目录运行共同协议向量：

```sh
mise exec -- cargo build --workspace --bins --locked
mise exec -- npm --prefix sdk/typescript ci
mise exec -- npm --prefix sdk/typescript run build
mise exec -- dotnet build sdk/csharp/EchoPlugin/EchoPlugin.csproj --configuration Debug
mise exec -- python3 tests/plugin_conformance.py --require-all
```

缺少相应 SDK 运行时的项不能算通过。检查安装 CLI、清单字段和各语言示例时，请看 [插件协议](PLUGIN_PROTOCOL.md)、[SDK 总览](../sdk/README.md) 和下列源码：

- [Rust SDK](../sdk/rust/README.md)
- [Python echo 示例](../sdk/python/examples/echo.py)
- [TypeScript echo 示例](../sdk/typescript/examples/echo.mjs)
- [C# echo 示例](../sdk/csharp/EchoPlugin/Program.cs)
- [RstrBot 插件开发技能](../.agents/skills/rstrbot-plugin-development/SKILL.md)

## 3. 修改服务或界面

- API 行为先核对 [HTTP 契约](API_CONTRACT.md) 和 [OpenAPI 3.1 文件](openapi.json)。模型与插件类型来自实例中已安装并声明对应能力的包；渠道类型来自已实现路由适配器。不要把示例值或 UI 文案当成服务端枚举。
- 配置模型时，先选提供方、填基础地址和凭据，再用“读取可用模型 ID”把 `model.list` 的结果填入建议列表；也可以直接输入模型 ID。发现只读取模型列表，不发起生成或占用 RstrBot 预算；临时密钥不保存，供应商仍可能记录或计费。私有网络仍受实例审批和全局策略限制。
- 模型发现可随时取消等待；修改提供方、地址、凭据或私网授权会取消旧浏览器请求并丢弃迟到结果。取消等待不表示供应商已撤回请求。模型和渠道向导在每一步标出字段错误，核对前按 Enter 只进入下一步，核对后才保存。
- 前端交互遵守当前账户、实例和工作区权限；隐藏按钮不构成授权。提交完整配置时只发送该资源允许更新的字段，不回传只读状态或仅供 UI 显示的字段。
- 对发送、删除、权限变化、密钥替换等有副作用的操作，明确指出目标、作用与不确定状态。费用未知时保持未知；不确定的发送不得自动重放。
- 使用当前版本语言字典，同一界面只显示用户选择的语言。新增用户可见文案时，同时补齐两种完整本地化，不添加逐句翻译或双语解释。

## 4. 本地验证

运行完整本地检查：

```sh
mise exec -- ./scripts/check.sh
```

脚本执行格式、Rust 编译与测试、Web 构建与测试、四语言 SDK 协议向量、API 和集成检查。跨数据库/缓存故障矩阵需要显式传入一次性测试服务，详见 `scripts/check.sh --full-matrix` 的脚本说明。浏览器、真实收费供应商、真实聊天平台和桌面安装器属于单独验收，不能由本地组件测试代替。

每个检查项应保留实际状态：`passed`、`failed`、`not_executed` 或 `blocked`。缺少依赖、跳过、仅生成产物或开发服务器能打开，都不是该项通过的证据。查看 [验收追踪](ACCEPTANCE.md) 了解当前实现范围和未完成项目。

## 5. 项目内开发技能

- [RstrBot 开发技能](../.agents/skills/rstrbot-development/SKILL.md)：仓库布局、运行、变更边界、本地验证和报告要求。
- [RstrBot 插件开发技能](../.agents/skills/rstrbot-plugin-development/SKILL.md)：协议实现、四语言 SDK、清单、能力与副作用、安装和授权边界。

技能属于本项目源码，修改协议或工具链时需要同步维护对应教程和技能。打包后的 Linux 运行归档会携带这两个技能文件与本页，方便开发者离线查阅。

## 5. 同步构建提示词

当前配方仓库以 `recipes/rstrbot/BUILD_PROMPT.md` 为根基线。Web 的 `predev` / `prebuild` 会把它复制到生成实现的 `docs/RECIPE_BUILD_PROMPT.md`，再内嵌到编辑器。独立源码包没有根配方时使用随包快照；浏览器草稿和历史不会被这一步覆盖。旧 `docs/blueprint/BUILD_PROMPT.md` 仍保存历史 1.4，不是当前基线。

## 6. 草稿、计划与断网恢复

构建提示词的浏览器草稿和最近20个版本按实例来源及当前认证账号隔离；保存/差异/恢复/导出使用同一作用域，切换账号不会认领旧稿。升级前不含账号归属的旧键原样保留，不自动读取或导出；不能通过一次登录确认其拥有者。

计划任务可选每天/每小时预设或自定义表达式，时区建议来自浏览器真实IANA目录，最终由核心验证。点击“预览执行时间”调用既有只读API；核对计划时区和设备时区，暂停任务仅列候选，不会派发。

断网后正文保留；先检查连接并核对会话/运行记录，再手动继续。传输失败不能证明服务端未收到，恢复网络不会自动重发，技术原文放在折叠详情中。

对应本地回归：`node tests/browser/verify_feedback.mjs --chromium /usr/bin/chromium`。它使用临时实例与诊断worker；不能代替真实商业模型、Google或触摸设备验收。
## 知识引用与删除

知识检索的授权原文用于本次模型上下文；运行和对话中的引用只保存来源、版本和位置。旧引用记录通过接口读取时也会去掉原文。模型已经生成的回答、旧数据库及备份不会因此自动清除；在途删除和撤权仍需单独验证。更改此行为时按配方 RSTRBOT-28 运行删除、历史兼容和权限测试。

回答里的“检索到的资料”是候选，不代表模型确实使用了它。打开时前端重新读取当前获准的原文，并核对摘要、索引版本、分块及 UTF-8 字节范围；不一致时不能显示旧引用对应的新文本。参照 RSTRBOT-29 测试来源修改、停用、删除、权限、断线及迟到响应。
