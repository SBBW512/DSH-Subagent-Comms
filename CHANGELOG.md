# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — package renamed

The package was renamed from `dsh-peer-sync` to `dsh-subagent-comms` to match the repository name before the first npm release, and no tool name, export or behaviour changed.

## [1.0.0] - 2026-11-07

### Added
- Four DSH host tools registered on `ctx.tools`:
  - `peer_publish`: Publish payloads under `topic` + `key`, resolving waiting subagents immediately.
  - `peer_read`: Non-blocking query for single keys or whole topic catalogs with rolling broadcast history.
  - `peer_await`: Non-polling, token-free wait in Node.js memory for a key to be published, with timeout and cancellation support.
  - `peer_broadcast`: Non-blocking broadcast notices into a per-topic rolling ring buffer.
- Workspace scoping: Full isolation of key/value stores, event emitters, and broadcast streams scoped by `exec.agent.workspaceId` (defaults to `default`).
- Structured payloads: `payload_json` parameter parses and stores structured objects, while `payload` stores values verbatim.
- TTL eviction: Configurable `ttl_seconds` (default 3600s, supports 0 for immediate expiration) with 60-second periodic unref'd sweep and lazy eviction on read.
- Topic catalog inspection: Listing live keys in insertion order and recent broadcast messages with a 200-key pagination cap and truncation flags.
- Diagnostics export: Public `diagnostics(workspaceId)` function returning workspace key counts, active listener counts, and per-topic broadcast metrics.
- Cordis bundle integration: Automatic bundle patch configuration via `cordis.patch.yml`.

### Security / robustness
- Bounded memory limits and LRU eviction:
  - Max 2,000 keys per workspace (oldest evicted first).
  - Max 500 broadcast topics per workspace (least-recently-used evicted).
  - Max 64 workspaces tracked (least-recently-used workspace evicted).
  - Max 50 broadcast messages per topic rolling ring buffer.
- Payload size enforcement: Strict 256 KiB limit (262,144 bytes) for stored payloads and 16 KiB limit (16,384 bytes) for broadcast messages.
- Cancellation and abort handling: `peer_await` tracks AbortSignal and disposal, returning status `cancelled` with zero lingering event listeners.
- Ref-counted multi-instance lifecycle: Disposal of a secondary Cordis context preserves shared workspace state; state and background timers tear down only when the final plugin instance unloads.
- Collision-free keys: Length-prefixed composite key encoding preventing delimiter collision when topic or key contains colons.
- Safe initialization: Catches initialization errors and logs with `[peer-sync]` prefix without crashing the DSH host.

### Tests
- Zero-dependency Node ESM test suite in `test/smoke.mjs` verifying 22 cases:
  - Round-trip publication, read, and last-write-wins TTL resets.
  - Immediate resolution for pre-existing keys and asynchronous waking (200ms).
  - Clean timeout handling with diagnostic verification of zero listener leaks.
  - Rolling broadcast ring buffer retention (50 messages).
  - Cross-workspace isolation.
  - Immediate TTL zero expiry and TTL expiration hiding.
  - Concurrent waiter resolution.
  - AbortSignal cancellation.
  - 200-key catalog capping and truncation signaling.
  - Payload size rejection (>256 KiB).
  - Colon character topic/key collision safety.
  - Clean disposal cancellation.
  - 2,000-key LRU cap eviction.
  - Structured object type preservation.
  - Secondary context disposal preservation.
  - Raw vs JSON-escaped string measurement.
  - Verbatim JSON-looking string preservation.
  - `payload_json` parsing and validation.
  - Invalid JSON rejection.
  - Mutual exclusion between `payload` and `payload_json`.
- Executed via `node test/smoke.mjs` or `npm test`.
