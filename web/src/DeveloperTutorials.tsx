import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, BookOpen, Boxes, Code2, FileCode2, Fingerprint, ShieldCheck, Terminal } from 'lucide-react';
import { api, items, value } from './api';
import type { Json, User } from './api';
import { ErrorNotice, Loading, PageHeader, useText } from './ui';
import Sculpture from './Sculpture';
import BuildPromptEditor from './BuildPromptEditor';

const repository = 'https://github.com/LIghtJUNction/RstrBot/blob/main/';

function SourceLink({ path, children }: { path: string; children: string }) {
  return <a className="developer-doc-link" href={`${repository}${path}`} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={15} aria-hidden="true" /></a>;
}

export default function DeveloperTutorials({ user }: { user: User }) {
  const { t } = useText();
  const packages = useQuery({ queryKey: ['plugin-packages'], queryFn: ({ signal }) => api<{ items: Json[] }>('/plugin-packages', { signal }).then(items) });
  const modelPackages = (packages.data ?? []).filter(pkg => Array.isArray(pkg.capabilities) && pkg.capabilities.includes('model'));
  return <section className="page developer-page">
    <PageHeader eyebrow={t('开发者工作台', 'DEVELOPER WORKBENCH')} title={t('开发者教程', 'Developer tutorials')} description={t('从接口契约到第一个插件，路标都在这里。少猜几次，少踩几脚。', 'From the API contract to your first plugin. Follow the signposts and save a few guesses—and toes.')} action={<Sculpture />} />

    <div className="developer-callout"><BookOpen size={19} aria-hidden="true" /><p>{t('下面的摘要直接对应仓库文档；完整细节请打开原文。文档说支持什么，才算支持什么。', 'These notes point to maintained repository docs. Open the source for full details; documented support is the real support.')}</p></div>

    <div className="developer-card-grid">
      <article className="developer-card">
        <span className="developer-card-icon"><Terminal size={20} aria-hidden="true" /></span>
        <h2>{t('开始开发', 'Get started')}</h2>
        <p>{t('先读项目说明，再按 mise.toml 准备工具链。更改 API 或界面前，先对照接口契约。', 'Read the project guide, install the toolchain from mise.toml, and check the API contract before changing an endpoint or form.')}</p>
        <div className="developer-card-links"><SourceLink path="README.md">{t('项目说明', 'Project README')}</SourceLink><SourceLink path="recipes/rstrbot/ACCEPTANCE.md">{t('验收要求', 'Acceptance criteria')}</SourceLink><SourceLink path=".agents/skills/rstrbot-development/SKILL.md">{t('开发技能', 'Development skill')}</SourceLink></div>
      </article>

      <article className="developer-card">
        <span className="developer-card-icon"><Boxes size={20} aria-hidden="true" /></span>
        <h2>{t('制作插件', 'Build a plugin')}</h2>
        <p>{t('四种语言 SDK 共用 JSON-RPC 2.0 协议和一致性样例。插件声明能力不等于拿到权限；每次操作仍由核心核验。', 'Four language SDKs share JSON-RPC 2.0 and the same conformance vectors. Declared capabilities do not grant access; the core checks every operation.')}</p>
        <div className="developer-card-links"><SourceLink path="recipes/rstrbot-plugin-protocol/PROTOCOL_REFERENCE.md">{t('插件协议', 'Plugin protocol')}</SourceLink><SourceLink path="recipes/rstrbot-sdk/BUILD_PROMPT.md">{t('SDK 总览', 'SDK overview')}</SourceLink><SourceLink path=".agents/skills/rstrbot-plugin-development/SKILL.md">{t('插件开发技能', 'Plugin development skill')}</SourceLink></div>
      </article>

      <article className="developer-card">
        <span className="developer-card-icon"><Code2 size={20} aria-hidden="true" /></span>
        <h2>{t('选择 SDK', 'Choose an SDK')}</h2>
        <p>{t('选你熟悉的语言；协议保持一致，运行时要求以项目工具链和 SDK 文档为准。', 'Use the language you know. The protocol stays consistent; check the project toolchain and SDK docs for runtime requirements.')}</p>
        <div className="developer-sdk-list">
          <SourceLink path="recipes/rstrbot-sdk/BUILD_PROMPT.md">Rust</SourceLink>
          <SourceLink path="recipes/rstrbot-sdk/BUILD_PROMPT.md">Python</SourceLink>
          <SourceLink path="recipes/rstrbot-sdk/BUILD_PROMPT.md">TypeScript</SourceLink>
          <SourceLink path="recipes/rstrbot-sdk/BUILD_PROMPT.md">C#</SourceLink>
        </div>
      </article>

      <article className="developer-card">
        <span className="developer-card-icon"><Activity size={20} aria-hidden="true" /></span>
        <h2>{t('验证改动', 'Verify a change')}</h2>
        <p>{t('先跑改动对应的本地检查。完整检查脚本会记录未执行的 SDK，不会把缺少运行时算成通过。', 'Run the relevant local check first. The full check records missing SDK runtimes as not executed, never as a pass.')}</p>
        <pre className="developer-command"><code>mise exec -- ./scripts/check.sh</code></pre>
        <div className="developer-card-links"><SourceLink path="recipes/rstrbot/ACCEPTANCE.md">{t('验收标准', 'Acceptance criteria')}</SourceLink><SourceLink path="recipes/rstrbot-core/OPENAPI.md">OpenAPI 3.1</SourceLink></div>
      </article>
    </div>

    <section className="developer-section developer-lessons" aria-labelledby="developer-lessons-title">
      <div className="developer-section-heading"><span className="developer-card-icon"><Terminal size={19} aria-hidden="true" /></span><div><h2 id="developer-lessons-title">{t('直接开工', 'Start building')}</h2><p>{t('先给可执行步骤，细节再看对应的项目文档。', 'Start with runnable steps, then open the project source for details.')}</p></div></div>
      <details className="developer-lesson"><summary>{t('准备环境并启动本地服务', 'Set up the toolchain and run locally')}</summary><ol><li>{t('在源码实现目录安装 mise.toml 锁定的工具；本仓库的实现位于 generated/rstrbot/，独立源码包使用解压后的根目录。', 'Run from the implementation directory: generated/rstrbot/ in this recipe repository, or the root of a standalone source package. Install the tools pinned in mise.toml.')}</li><li>{t('构建 WebUI，再启动 Rust 核心；首次使用要按 README 完成本机初始化。', 'Build the WebUI, then start the Rust core. Follow the README for first-run initialization.')}</li></ol><pre><code>mise install{`\n`}mise exec -- npm --prefix web run build{`\n`}mise exec -- cargo run --locked -- --web-dir web/dist</code></pre><p className="muted small">{t('核心默认在本机 8787 端口提供页面和 API。运行中的服务请使用单独数据目录。', 'The core serves the UI and API on local port 8787 by default. Use a dedicated data directory for a running instance.')}</p><SourceLink path="recipes/rstrbot-core/CLI.md">{t('查看初始化与数据目录说明', 'Read initialization and data-directory guidance')}</SourceLink></details>
      <details className="developer-lesson"><summary>{t('从只读工具开始做插件', 'Build a plugin, starting with a read-only tool')}</summary><ol><li>{t('选 Rust、Python、TypeScript 或 C# SDK 的 echo 样例。', 'Choose the echo example from the Rust, Python, TypeScript, or C# SDK.')}</li><li>{t('只声明样例实际实现的能力；工具先使用 read_only 效果。声明能力不会替代核心授权。', 'Declare only implemented capabilities. Start tools with read_only effects; declarations do not replace core authorization.')}</li><li>{t('先通过对应 SDK 的一致性向量，再由实例管理员安装清单；工作区内创建的实例默认停用。', 'Pass that SDK’s conformance vectors first. An instance administrator installs the manifest; workspace instances start disabled.')}</li><li>{t('检查配置与权限披露，再启用实例并从获准会话调用。', 'Review configuration and permission disclosures, then enable the instance and call it from an authorized conversation.')}</li></ol><pre><code>mise exec -- cargo build --workspace --bins --locked{`\n`}mise exec -- npm --prefix sdk/typescript ci{`\n`}mise exec -- npm --prefix sdk/typescript run build{`\n`}mise exec -- dotnet build sdk/csharp/EchoPlugin/EchoPlugin.csproj --configuration Debug{`\n`}mise exec -- python3 tests/plugin_conformance.py --require-all</code></pre><p className="muted small">{t('先构建四种 SDK 样例；--require-all 会把缺少运行时明确判为失败。', 'Build all four SDK examples first. --require-all treats missing runtimes as failures.')}</p><div className="developer-card-links"><SourceLink path="recipes/rstrbot-plugin-protocol/PROTOCOL_REFERENCE.md">{t('协议、清单与生命周期', 'Protocol, manifest, and lifecycle')}</SourceLink><SourceLink path=".agents/skills/rstrbot-plugin-development/SKILL.md">{t('插件开发技能', 'Plugin development skill')}</SourceLink></div></details>
      <details className="developer-lesson"><summary>{t('构建前验证并看懂结果', 'Verify changes and read the result correctly')}</summary><p>{t('完整检查包含 Rust、Web、四语言协议、API 与集成检查。缺少运行时会明确记录为未执行；它不是通过。浏览器、真实收费模型、真实聊天平台和桌面安装器仍需各自验收。', 'The full check covers Rust, Web, four-language protocol, API, and integration checks. Missing runtimes are recorded as not executed, not passed. Browser, paid-provider, real platform, and desktop-installer acceptance remain separate.')}</p><pre><code>mise exec -- ./scripts/check.sh</code></pre><SourceLink path="docs/MIGRATION.md">{t('查看已通过与未执行项目', 'Review passed and unexecuted checks')}</SourceLink></details>
    </section>

    <section className="developer-section" aria-labelledby="developer-options-title">
      <div className="developer-section-heading"><span className="developer-card-icon"><FileCode2 size={19} aria-hidden="true" /></span><div><h2 id="developer-options-title">{t('模型与渠道：可选项写清楚', 'Models and channels: the actual choices')}</h2><p>{t('当前 API 契约里列出的类型如下。没有列出的类型，不要靠猜。', 'These are the types listed in the current API contract. Anything else needs a real contract first.')}</p></div></div>
      <div className="developer-option-list">
        <div><span>{t('已安装的模型提供方', 'Installed model providers')}</span><div>{packages.isPending ? <Loading /> : packages.error ? <ErrorNotice error={packages.error} onRetry={() => { void packages.refetch(); }} /> : modelPackages.length ? modelPackages.map(pkg => {
          const id = value(pkg, 'id'); const version = value(pkg, 'version'); const capabilities = Array.isArray(pkg.capabilities) ? pkg.capabilities.filter((item): item is string => typeof item === 'string') : [];
          const summary = id === 'diagnostic' ? t('本地诊断夹具，不是 AI 模型。', 'Local diagnostic fixture; not an AI model.') : id === 'openai' ? t('OpenAI 兼容 HTTP 接口。', 'OpenAI-compatible HTTP API.') : t('由实例管理员安装的模型插件。', 'A model plugin installed by the instance administrator.');
          return <div key={id}><code>{id}</code>{version && <small> · v{version}</small>}<p>{summary}</p>{capabilities.length > 0 && <small>{t('声明能力：', 'Declared capabilities: ')}{capabilities.join(', ')}</small>}</div>;
        }) : <p>{t('当前没有已安装的模型插件。', 'No model plugin is installed.')}</p>}</div></div>
        <div><span>{t('消息渠道', 'Message channel')}</span><div><code>webhook</code><p>{t('当前路由适配器。启用前要经过实例网络目标审批。', 'Current route adapter. An instance administrator must approve the network destination before it is enabled.')}</p></div></div>
      </div>
      <div className="developer-caution"><ShieldCheck size={17} aria-hidden="true" /><p>{t('模型“测试”会发起真实请求，可能产生费用。当前渠道没有无副作用的连通性测试；不要把“测试成功”按钮做成摆设。', 'Model “test” sends a real request and may incur a charge. Channels have no side-effect-free connectivity test today; do not add a pretend test button.')}</p></div>
      <div className="developer-caution"><ShieldCheck size={17} aria-hidden="true" /><p>{t('发送结果未确认时先核对会话和运行记录。刷新后可用原正文、模型和代理继续同一意图；换内容或配置要明确开始新意图。浏览器禁止本地存储或不支持同源标签页协调时会暂停发送；请使用 HTTPS 或本机地址。', 'When a send is unconfirmed, review the conversation and run records first. After refresh, continue the same intent with the original text, model and agent; changing them requires confirming a new intent. Sending pauses if browser storage or same-origin tab coordination is unavailable; use HTTPS or a local address.')}</p></div>
      <SourceLink path="recipes/rstrbot-core/HTTP_CONTRACT.md">{t('查看完整 HTTP 契约', 'Read the full HTTP contract')}</SourceLink>
    </section>

    <section className="developer-section developer-trust" aria-labelledby="developer-trust-title">
      <div className="developer-section-heading"><span className="developer-card-icon"><Fingerprint size={19} aria-hidden="true" /></span><div><h2 id="developer-trust-title">{t('边界先讲明白', 'Know the boundaries')}</h2><p>{t('插件是独立进程，不代表恶意代码已被沙箱隔离。凭据、权限与副作用按协议处理。', 'A separate plugin process is not a sandbox for malicious code. Handle credentials, authority, and side effects according to the protocol.')}</p></div></div>
      <SourceLink path="recipes/rstrbot-plugin-protocol/PROTOCOL_REFERENCE.md">{t('查看信任模型与取消规则', 'Read the trust model and cancellation rules')}</SourceLink>
    </section>
    <BuildPromptEditor userId={user.id} />
  </section>;
}
