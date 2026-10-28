#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -gt 1 || ( $# -eq 1 && "${1:-}" != "--full-matrix" ) ]]; then
  printf 'Usage: %s [--full-matrix]\n' "$0" >&2
  exit 2
fi
if [[ "${1:-}" == "--full-matrix" ]]; then
  : "${RSTRBOT_TEST_DATABASE_URL:?Set a disposable PostgreSQL URL}"
  : "${RSTRBOT_TEST_VALKEY_URL:?Set a disposable Valkey URL}"
  : "${RSTRBOT_TEST_VALKEY_SERVER:?Set the Valkey server executable path}"
  : "${RSTRBOT_TEST_VALKEY_CLI:?Set the Valkey CLI executable path}"
fi
command -v dotnet >/dev/null || { printf '.NET 10 SDK (10.0.403) is required for four-language protocol verification.\n' >&2; exit 2; }
mkdir -p test-results
python3 scripts/generate_openapi.py --check
python3 scripts/validate_openapi.py
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
cargo build --workspace --bins --locked
target_dir="$(cargo metadata --locked --no-deps --format-version 1 | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"
binary="$target_dir/debug/rstrbot"
RUSTDOCFLAGS='-D warnings' cargo doc --workspace --no-deps --locked
npm --prefix web ci
npm --prefix web run build
npm --prefix web test
npm --prefix sdk/typescript ci
npm --prefix sdk/typescript run build
dotnet build sdk/csharp/EchoPlugin/EchoPlugin.csproj --configuration Debug
python3 tests/plugin_conformance.py --require-all --rust-bin "$target_dir/debug/rstrbot-diagnostic" | tee test-results/sdk-conformance.json
python3 tests/plugin_mcp.py --binary "$target_dir/debug/rstrbot-webhook" | tee test-results/mcp-stdio.json
python3 tests/integration.py --binary "$binary" --output test-results/integration.json
python3 tests/delivery_integration.py --binary "$binary" --output test-results/delivery.json
python3 tests/delivery_session_revocation.py --binary "$binary" --output test-results/delivery-session-revocation.json
python3 tests/shared_context_privacy.py --binary "$binary" --output test-results/shared-context-privacy.json
python3 tests/schedule_authority.py --binary "$binary" --output test-results/schedule-authority.json
python3 tests/session_revocation.py --binary "$binary" --output test-results/session-revocation.json
python3 tests/model_target_authority.py --binary "$binary" --output test-results/model-target-authority.json
python3 tests/model_test_revocation.py --binary "$binary" --output test-results/model-test-revocation.json
python3 tests/identity_integration.py --binary "$binary" --output test-results/identity.json
python3 tests/stream_persistence.py --binary "$binary" --output test-results/stream-persistence-sqlite.json
python3 tests/history_recovery.py --binary "$binary" --output test-results/history-recovery-sqlite.json

# The cross-database/cache fault matrix requires disposable real services and
# remains an explicit additional gate. It never silently skips missing services.
if [[ "${1:-}" == "--full-matrix" ]]; then
  python3 scripts/verify_integration.py --binary "$binary" \
    --valkey-server "$RSTRBOT_TEST_VALKEY_SERVER" \
    --valkey-cli "$RSTRBOT_TEST_VALKEY_CLI" \
    --output-directory test-results/matrix
fi
