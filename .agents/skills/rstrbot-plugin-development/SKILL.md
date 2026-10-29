---
name: rstrbot-plugin-development
description: Use when building, reviewing, or documenting RstrBot executable plugins or language SDKs.
---

# RstrBot plugin development

## Read the contract first

- Read `docs/PLUGIN_PROTOCOL.md` and `sdk/README.md` before writing a worker.
- Choose the existing Rust, Python, TypeScript, or C# SDK. Implement the public protocol; do not depend on private core objects.
- Treat the package manifest, installed package, workspace instance, and one invocation as separate things.

## Capability and trust rules

- A capability declaration describes what a plugin requests; it does not grant permission. The core checks installed declarations and current user authority for each operation.
- Workers are trusted native programs in this release. A separate process is not a malicious-code sandbox. Do not describe it as one.
- Keep provider credentials scoped to the provider call. Ordinary tool invocations must not receive them.
- Do not add worker-initiated core-admin methods, arbitrary executable installation through workspace settings, or network listeners for the local worker protocol.
- Validate initialization context, nonce, protocol version, request IDs, frame limits, method parameters, and the single terminal response. Bound queues and event output.
- Propagate cancellation and stop child processes. Cancellation cannot reverse a remote side effect; retain an unknown/in-flight outcome for reconciliation and never silently replay it.
- Redact keys, authorization headers, private URL paths, and remote response bodies from diagnostics.

## SDK conformance

Build the selected example using the pinned toolchain and run:

```sh
python3 tests/plugin_conformance.py --sdk <rust|python|typescript|csharp>
```

For a full local check, use `mise exec -- ./scripts/check.sh`. An unavailable runtime is `not_executed`, not a pass. Update the protocol document, SDK README, and conformance vectors together when changing shared behavior.

Provider rejection codes `-32041`, `-32043`, and `-32029` have optional 1.0-compatible behavior documented in `docs/PLUGIN_PROTOCOL.md`. Preserve generic fallback for old workers/hosts, do not reveal response bodies, and test each SDK runtime separately. The source lives in the pinned implementation submodule; it is not part of the recipe payload.

Tool discovery is scoped to the current member and workspace. Test interactive and scheduled runs with more than 100 plugin instances, the 32-tool per-plugin and 64-tool per-run boundaries, and permission revocation; discovery does not grant execution authority. Run `python3 tests/plugin_catalog.py` from the implementation root.

For text attachments, verify that model workers receive the complete user-supplied text as untrusted content, keep the original message and filename, and never imply that text support adds image, audio, or PDF support. Run `python3 tests/text_attachments.py` against a loopback model receiver.
