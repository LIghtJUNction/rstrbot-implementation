# Local migration and acceptance record

Date: 2026-10-29. Scope: RFB-016 administrator reconciliation for unknown model costs, including paged reservation/history reads. All build and acceptance runs were local; CI, release, signing and deployment were not run.

## Toolchain

- Linux x86_64; rustc/cargo 1.99.1; Python 3.15.2; Node.js 24.22.1; npm 12.2.0.
- Vite 8.3.5; Playwright 1.62.1; system Chromium 156.0.8078.73; Recipkg 0.1.1.
- The browser and HTTP tests used isolated temporary SQLite databases and a loopback OpenAI-compatible fake provider. No commercial provider or bill was contacted.

## Checks

| Command | Result |
| --- | --- |
| `cargo fmt --all` | Passed; formatted the workspace. |
| `cargo test --locked` | Passed: 33 tests across 3 suites. Includes same-value idempotency, conflicting administrators, budget-update serialization, reservation pages, history cursor pages, role redaction and backup restore. PostgreSQL was not configured. |
| `cargo build --locked` | Passed. `target/debug/rstrbot` SHA-256: `f0464fc81fcd93f2e4e1f32d72102fa420ba4e3b30149e04d34cb0908cb085bb`. |
| `npm --prefix web run typecheck` and `npm --prefix web run build` | Passed. Vite transformed 2,010 modules. Final CSS: 54.08 kB (10.85 kB gzip); JS: 581.23 kB (190.98 kB gzip). |
| `python3 scripts/generate_openapi.py` and `python3 scripts/validate_openapi.py` | Passed. Static checks cover 62 registered paths, 73 operations (71 API v1 + 2 health), 132 schemas, 930 references, 133 examples and 29 request-schema type checks. This is not a full external OpenAPI meta-schema validator. |
| `python3 tests/image_attachments.py` | Passed: 10 checks against SQLite and the loopback fake provider, including paged reservation API, unknown-cost reconciliation, correction delta, no replay and isolated backup restore. Report: [image-attachments.json](evidence/RFB-016/image-attachments.json). |
| `node tests/browser/verify_image_attachments.mjs --chromium /usr/bin/chromium` | Passed: 3 browser groups; no console or network errors. Includes explicit Enter-to-review with zero POSTs before confirmation, Chinese 320px views and exact cost entry. Report and screenshots: [browser.json](evidence/RFB-016/browser.json). |
| `recipkg check recipes/rstrbot` | Passed: `rstrbot@0.2.0-recipe.27`. |
| `recipkg pack ...` and `recipkg check <archive>` | Passed. Archive SHA-256 `ace62ed9981bf003da0de68c27322a3f9c4222f849c9c4932d1fa47bb55bbe08`; 109 entries, all `.md`, recursive `LOCK.md` included, no generated source. |
| `recipkg build recipes/rstrbot --lang zh-CN ...` | Passed. Prompt SHA-256 `bd8a7f2b6e0f20c286a8d6f238d387ddc4385c56bc25879c14a58d5f6bdf6728`. |

The generated Chinese prompt and recipe archive were written under `/tmp/rstrbot-recipkg-Vxe978` (`RstrBot.final.recipe.tar.gz`, `BUILD_PROMPT.final.zh-CN.md`), outside the repository. The archive and prompt are temporary validation outputs, not releases.

## Evidence and limits

Browser evidence records the exact binary, Web asset and harness hashes. The mobile budget page and reconciliation form were inspected at 320 px; decorative section separators were removed while retaining readable spacing. Reservation pages expose `total` and `has_more`; history pages continue from the last event ID. Core tests exercise one-row pages and cursor continuation.

This establishes local SQLite, fake-provider, Chromium and Recipkg material checks only. PostgreSQL/Valkey behavior, external provider billing, screen readers, native desktop, other browsers/platforms, production load, independent software reconstruction from the recipe, release and deployment remain unverified.

## CMP-03 工具调用 ID 关联回归（2026-10-29）

修复已提交并推送至独立源码仓库，提交 `89355964d2c1f0561fed9188fbdc2b09b8e8c357`（父提交 `9fd0f6d304ab3f0993dbb104e3a7b4f6ad493930`）。修复前，`tests/plugin_catalog.py` 的真实独立Python SDK worker返回 `call_id: null`，而会话历史保存了模型工具ID；修复后，核心将原ID传进 `tools.call.params.call_id`。回归用固定 `catalog_fixed_tool_call` 逐字对比worker返回、持久工具消息和 `run.tool` 事件，三者相同。此检查未重启核心读取历史，也未通过WebUI安装自定义插件。

| 检查 | 结果 |
| --- | --- |
| `cargo build --bin rstrbot` 与 `cargo build -p rstrbot-plugin --bin rstrbot-diagnostic` | 通过。核心二进制 SHA-256：`0dbb6577a2e14fe381cf93575ca2f9325aa84a44b2979fdc37e4a84d51bd048c`。 |
| `npm run build`（SDK TypeScript）与 `dotnet build sdk/csharp/EchoPlugin/EchoPlugin.csproj --configuration Debug` | 通过；C# 构建2个项目，0错误、0警告。 |
| `python3 tests/plugin_conformance.py --require-all` | 通过：Python、TypeScript、Rust、C#共24项，含独立ID关联向量。 |
| `python3 tests/plugin_catalog.py` | 通过：真实Python worker回显固定ID；消息、事件与worker结果一致；既有64/65总目录及32/33单插件边界保持通过。 |
| `cargo test -p rstrbot-plugin --test process` | 通过：10项。 |
| Recipkg `check`、`pack`、归档`check`、`unpack`、解包目录`check`及`build --lang zh-CN` | 全部通过；归档109/109项均为普通UTF-8 Markdown，LOCK完整，生成提示词包含109/109份材料及全部新关联ID验收。归档 SHA-256：`11feff4fd80fcec53fc2c390d65be1eebc4c19c5a421a78ec7881a97f3867e40`；中文提示词 SHA-256：`b0c75ba4a7d8314d478947701edaa38835b4acba10bf1ee9567d40030b0c70c4`。 |

证据目录：`/home/lightjunction/.cache/rstrbot-comparison-3zpgia2m/rstrbot-cmp03-call-id-20261029/`。报告 SHA-256：`sdk-conformance.json` `a81208bf0502e3d373dc17fee2ae97e7e5289964273a150a798a8ad1953a80b8`；`plugin-catalog.json` `657245d483603bd7c02252633efdfbd20726835dc7bed1f580018096447348b5`；`host-process.txt` `c28fe135c4bcbeeab763b3fd04a630c5ca1d96e9f7dd7d08a8cc280f44c9610c`。均为隔离本地合成数据；没有联系模型供应商或重启常驻服务。完整CMP-03仍是partial，不能由这组调用关联检查推断WebUI自定义安装、撤权/恢复、跨平台或竞品对比已通过。

来源证据配方文件补齐后，最终 Recipkg `check`、`pack`、归档 `check`、`unpack`、解包目录 `check` 和 `build --lang zh-CN` 均通过，版本为 `rstrbot@0.2.0-recipe.28`。最终归档 SHA-256：`79a6c87154b99bcae69a5eceb5070ab13f97fb0fc4c1e0ef558b9a8a7fd77185`；中文提示词 SHA-256：`73c386d589185978cc45be6387225292361315d415202e168ee7d404dbe651ce`。归档含109份普通UTF-8 Markdown与完整LOCK；逐文件检查确认109/109材料正文出现在生成提示词中。
