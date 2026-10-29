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
