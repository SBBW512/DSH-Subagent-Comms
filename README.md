# dsh-subagent-comms

In-memory Pub/Sub and blackboard synchronization plugin for DeepSeek Harness (DSH) subagents.

**Repository**: [https://github.com/SBBW512/DSH-Subagent-Comms](https://github.com/SBBW512/DSH-Subagent-Comms)

## Installation

> **Important**: A DSH restart is required for newly installed plugins and tools to appear. After restarting DSH, the four tools `peer_publish`, `peer_read`, `peer_await`, and `peer_broadcast` appear in an agent's registered tool list. Package `dsh-subagent-comms` registers the Cordis plugin named `peer-sync` and the four tool names are unchanged.

You can install `dsh-subagent-comms` using any of the following three routes:

### Route 1: From a Git Clone (Development / Local Linking)

1. Clone the repository to your machine:
   ```bash
   git clone https://github.com/SBBW512/DSH-Subagent-Comms.git
   ```
2. Navigate to your target DSH profile directory (e.g. `profiles\<name>`):
   ```bash
   cd ~/.dsh/profiles/<name>
   ```
3. Create a junction or symlink in the profile's `node_modules`:
   - **Windows PowerShell / CMD**:
     ```cmd
     mklink /J node_modules\dsh-subagent-comms C:\path\to\DSH-Subagent-Comms
     ```
   - **Linux / macOS**:
     ```bash
     ln -s /path/to/DSH-Subagent-Comms node_modules/dsh-subagent-comms
     ```
4. In the profile's `package.json`, add the package to `dependencies`:
   ```json
   "dependencies": {
     "dsh-subagent-comms": "link:../../plugins/dsh-subagent-comms"
   }
   ```
   *(adjust the relative path to your clone location)*
5. In the same profile's `package.json`, add `"dsh-subagent-comms"` to `dsh.profile.bundles`:
   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "dsh-subagent-comms"
       ]
     }
   }
   ```
   The plugin's `dsh.bundle.patch` field in its `package.json` points to `./cordis.patch.yml`, which instructs DSH to load the Cordis bundle patch configuration automatically.
6. Restart DSH.

### Route 2: From npm (Once Published)

1. Navigate to your target DSH profile directory:
   ```bash
   cd ~/.dsh/profiles/<name>
   ```
2. Install the package via npm:
   ```bash
   npm install dsh-subagent-comms
   ```
3. Add `"dsh-subagent-comms"` to `dsh.profile.bundles` in the profile's `package.json`:
   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "dsh-subagent-comms"
       ]
     }
   }
   ```
4. Restart DSH.

### Route 3: Manual Installation

1. Copy the `dsh-subagent-comms` folder directly into your profile's `node_modules` directory:
   `profiles\<name>\node_modules\dsh-subagent-comms`
2. In the profile's `package.json`, add `"dsh-subagent-comms"` to `dependencies`:
   ```json
   "dependencies": {
     "dsh-subagent-comms": "*"
   }
   ```
3. In the profile's `package.json`, add `"dsh-subagent-comms"` to `dsh.profile.bundles`:
   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "dsh-subagent-comms"
       ]
     }
   }
   ```
4. Restart DSH.

---

## Quick start

Here is a four-step pattern showing how concurrent subagents coordinate across vertical slices:

### Step 1: Worker A publishes a contract or artifact

Worker A defines an interface or build artifact and publishes it using `payload_json`:

```json
// Tool: peer_publish
{
  "topic": "contracts",
  "key": "AuthService",
  "payload_json": "{\"version\":\"1.0.0\",\"endpoints\":[\"/login\",\"/logout\",\"/refresh\"]}"
}
```

### Step 2: Worker B awaits the contract without polling

Worker B needs `AuthService` before implementing clients. It blocks cleanly in Node.js memory without spending LLM tokens or running polling loops:

```json
// Tool: peer_await
{
  "topic": "contracts",
  "key": "AuthService",
  "timeout_ms": 60000
}
```

When Worker A publishes, `peer_await` resolves immediately with status `resolved` and returns the payload.

### Step 3: Worker B inspects or reads the stored state

Worker B can also query the topic blackboard at any point to read the payload directly:

```json
// Tool: peer_read
{
  "topic": "contracts",
  "key": "AuthService"
}
```

Returns:
```json
{
  "found": true,
  "topic": "contracts",
  "key": "AuthService",
  "payload": {
    "version": "1.0.0",
    "endpoints": ["/login", "/logout", "/refresh"]
  },
  "published_at": "2026-11-07T00:00:00.000Z"
}
```

### Step 4: Worker A or B broadcasts progress notices

Workers announce lightweight progress or status updates into the rolling broadcast ring buffer:

```json
// Tool: peer_broadcast
{
  "topic": "contracts",
  "sender": "worker-A",
  "message": "AuthService contract published and ready for consumption"
}
```

---

## Compatibility

- **Node.js**: `^22.19.0 || >=24.0.0`
- **Host Testing**: Verified and tested against the packaged DeepSeek Harness build on this machine.
- **DSH Conventions**: The plugin depends exclusively on standard host plugin mechanisms: `ctx.tools.register` for tool registration and `dsh.bundle.patch` (`./cordis.patch.yml`) for Cordis bundle loading. Other DSH versions or environments are untested.

---
## The Problem

DSH subagents run as isolated Cordis sessions. Sibling workers cannot share intermediate artifacts or signal each other, so concurrent slices duplicate work and drift on shared interfaces.

`dsh-subagent-comms` closes that gap with an in-memory Pub/Sub and blackboard that every agent in the active workspace shares. It enables concurrent agents to coordinate handoffs, wait for dependencies without busy-polling or token spend, read shared intermediate state, and broadcast progress notices.

## Plugin Identity and Wiring

- **Package**: `dsh-subagent-comms` v1.0.1
- **Module type**: ESM (`"type": "module"`)
- **Main entry**: `./index.js`
- **Dependencies**: Zero runtime dependencies (uses only standard library `node:events`)
- **Node compatibility**: `^22.19.0 || >=24.0.0`
- **Plugin exports**:
  - `name = 'peer-sync'`
  - `inject = ['tools']`
  - `apply(ctx)`
  - `diagnostics(workspaceId = 'default')`
- **Cordis wiring**: Loaded as a DSH bundle. `cordis.patch.yml` inserts one Cordis entry with `id: dsh-subagent-comms`, `name: 'dsh-subagent-comms'`. The module specifier is `dsh-subagent-comms` and bundle name is `dsh-subagent-comms`.
- **Initialization safety**: A failure to initialise is logged with a `[peer-sync]` prefix instead of crashing the host.

## Workspace Scoping

Every tool resolves its store from `exec.agent.workspaceId`. When the caller has no workspace id, the plugin falls back to the literal workspace id `default`.

Isolation rules:
- Each workspace maintains its own isolated key/value map.
- Each workspace maintains its own dedicated `EventEmitter`.
- Each workspace maintains its own broadcast buffers.
- Two workspaces publishing the same topic and key never see each other's data or events.

## Store Shape and Storage Model

Composite keys are internal and length-prefixed, so a topic or key containing `:` cannot alias another pair. Both `peer_publish` and `peer_await` reject non-string `topic`/`key` with a descriptive error.

Each stored record contains:
- `payload`: The stored data value. `payload` is stored verbatim as received (so on this host a structure arrives as JSON text), while `payload_json` is decoded and therefore returns real structures. Plain strings are stored verbatim and are never parsed, even if they look like JSON; oversized payloads are rejected rather than truncated.
- `expiresAt`: Expiration timestamp in epoch milliseconds.
- `publishedAt`: Publication timestamp formatted as an ISO 8601 string.

Republishing the same `topic:key` overwrites the previous value and re-arms the TTL according to a last-write-wins policy.

## TTL Eviction

- **Default TTL**: `ttl_seconds` defaults to 3600 seconds (1 hour) when omitted. It accepts 0, where `0` expires the entry immediately (an immediate `peer_read` returns `found: false`). A negative value is rejected with an error.
- **Background sweep**: A periodic sweep timer runs every 60 seconds and drops expired entries. The timer is unreferenced (`unref()`), ensuring it never holds the Node.js event loop or process open.
- **Lazy eviction**: Read paths additionally expire lazily upon access. If an entry's TTL has elapsed, it is treated as absent immediately rather than waiting up to 60 seconds for the next background sweep.

## Dispose and Cleanup

When the Cordis plugin instance is disposed (`ctx.on('dispose', ...)`):
- The 60-second periodic background sweep interval is cleared.
- All stored workspace state, key/value maps, event emitters, and broadcast buffers are dropped from memory.
- Any pending `peer_await` calls are cleanly cancelled with status `cancelled` and reason `disposed`.

Note that if the plugin is instantiated more than once in one host, disposing one instance does NOT clear the shared store or stop the background sweep; only the last live instance tears shared state down.

## Limits and Failure Behaviour

| Limit | Value | When exceeded |
|---|---|---|
| Payload size | 262 144 bytes (256 KiB), measured on the stored form (raw UTF-8 byte length for string payloads, the JSON form for objects/arrays/numbers/booleans) | `peer_publish` fails with an error naming the measured size and the limit; nothing is stored |
| Conflicting payloads | Providing both `payload` and `payload_json` | `peer_publish` fails with an error (`not both`); nothing is stored |
| Invalid JSON | Malformed `payload_json` string | `peer_publish` fails with an error (`not valid JSON`); nothing is stored |
| Broadcast message | 16 384 bytes (16 KiB) | `peer_broadcast` fails with an error; nothing is appended |
| Keys per workspace | 2 000 | oldest entries are evicted first |
| Broadcast topics per workspace | 500 | least-recently-used topic buffer is evicted |
| Workspaces tracked | 64 | least-recently-used workspace is evicted |
| Catalog keys per `peer_read` | 200 | `keys` is capped and `truncated: true` is returned with the true `total` |
| Messages per broadcast topic | 50 | oldest dropped (existing ring buffer) |
| Entry TTL | default 3 600 s | entry expires; omitting defaults to 3 600 s; accepts 0 (expires immediately, so an immediate `peer_read` returns `found: false`); negative values are rejected with an error; 60 s background sweep plus lazy expiry on read |
| `peer_await` timeout | default 60 000 ms, clamped 1 000–180 000 ms | returns `timed_out` |

Composite keys are internal and length-prefixed, so a topic or key containing `:` cannot alias another pair. Both `peer_publish` and `peer_await` reject non-string `topic`/`key` with a descriptive error. Supplying both `payload` and `payload_json` fails with an error (`peer_publish: provide either payload or payload_json, not both`), supplying neither fails with an error (`peer_publish: payload or payload_json is required`), and invalid JSON text in `payload_json` fails with an error (`peer_publish: payload_json is not valid JSON (...)`). A failure to initialise is logged with a `[peer-sync]` prefix instead of crashing the host.

If the plugin is instantiated more than once in one host, disposing one instance does NOT clear the shared store or stop the background sweep; only the last live instance tears shared state down.

## Tools

The plugin registers four tools in the DSH tool registry: `peer_publish`, `peer_read`, `peer_await`, and `peer_broadcast`.

### `peer_publish`

Publishes a payload under `topic` + `key` and immediately resolves any peer blocked in `peer_await` on that key.

Callers must provide either `payload` or `payload_json`, not both. `payload_json` is the supported way to publish structured data (objects, arrays, numbers, booleans, or strings). This host delivers a non-scalar `payload` as JSON text, so `payload` is stored verbatim as received (on this host a structure arrives as JSON text), while `payload_json` is decoded and therefore returns real structures. Plain strings passed to `payload` are stored verbatim and are never parsed, even if they look like JSON. Providing both `payload` and `payload_json` is rejected with an error (`peer_publish: provide either payload or payload_json, not both`), providing neither is rejected (`peer_publish: payload or payload_json is required`), and invalid JSON in `payload_json` is rejected (`peer_publish: payload_json is not valid JSON (...)`). Oversized payloads are rejected rather than truncated (exceeding 262 144 bytes measured on the stored form fails with an error naming the measured size and the limit).

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `topic` | string | Yes | None | Logical topic namespace for the entry (must be a string). |
| `key` | string | Yes | None | Key identifier within the topic (must be a string). |
| `payload` | oneOf (object \| array \| string \| number \| boolean) | No | None | Verbatim value, stored exactly as received. Note: this host delivers a non-scalar value here as JSON text, so use `payload_json` when you need a real structure. Plain strings are stored verbatim and never parsed. Oversized payloads (>262 144 bytes measured on the stored form) are rejected rather than truncated. |
| `payload_json` | string | No | None | JSON-encoded value to decode and store as a real structure (object, array, number, boolean or string). Use this instead of `payload` when publishing structured data. Must be valid JSON text; invalid JSON is rejected (`not valid JSON`). Provide either `payload` or `payload_json`, not both. |
| `ttl_seconds` | number | No | 3600 | Time-to-live in seconds before expiry. Accepts 0 (where `0` expires the entry immediately; an immediate `peer_read` returns `found: false`). A negative value is rejected with an error. Omitting it defaults to 3 600 s. |

#### Return Shape

Returns an object confirming publication:

```json
{
  "status": "published",
  "topic": "build",
  "key": "artifact",
  "timestamp": "2026-11-06T12:00:00.000Z"
}
```

Where `timestamp` is the ISO 8601 publish time.

---

### `peer_read`

Non-blocking read of a specific key or an entire topic catalog.

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `topic` | string | Yes | None | Target topic to inspect. |
| `key` | string | No | None | Optional key to read a single entry. |

#### Return Shape

##### With `key`

When present and unexpired:
```json
{
  "found": true,
  "topic": "build",
  "key": "artifact",
  "payload": { "path": "dist/bundle.js" },
  "published_at": "2026-11-06T12:00:00.000Z"
}
```

When absent or expired:
```json
{
  "found": false,
  "topic": "build",
  "key": "artifact"
}
```

##### Without `key`

Returns active keys under the topic alongside topic broadcast messages. The catalog is capped at 200 keys per `peer_read`: if the topic contains more than 200 active keys, `keys` is capped at 200 entries and `truncated: true` is returned alongside the true `total`.

```json
{
  "topic": "build",
  "total": 1,
  "truncated": false,
  "keys": [
    {
      "key": "artifact",
      "published_at": "2026-11-06T12:00:00.000Z",
      "type": "object"
    }
  ],
  "broadcasts": [
    {
      "sender": "worker-1",
      "message": "compilation complete",
      "timestamp": "2026-11-06T12:00:00.000Z"
    }
  ]
}
```

- `total`: Total number of live matching keys in the catalog under this topic.
- `truncated`: Boolean indicating whether the catalog was capped (`true` if key count exceeds the 200-key catalog cap, otherwise `false`).
- `keys`: Lists live keys under the topic in insertion order (capped at 200 keys). `type` is one of `string | number | boolean | object | array | null`.
- `broadcasts`: The topic's rolling buffer oldest-first (capped at 50 messages). `peer_read` is the only way to read broadcasts.

---

### `peer_await`

Waits in Node.js memory for a key to be published — no polling, no token spend while waiting.

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `topic` | string | Yes | None | Topic to monitor (must be a string). |
| `key` | string | Yes | None | Key to wait for (must be a string). |
| `timeout_ms` | integer | No | 60000 | Milliseconds to wait before timing out (clamped to 1000–180000). |

#### Behavior

- Resolves immediately if the key is already published.
- Otherwise attaches a one-shot listener and races it against a timer or cancellation/dispose.
- The listener is always removed on resolution, timeout, or cancellation, so waiting never leaks listeners.
- Both `topic` and `key` must be strings; non-string arguments are rejected with a descriptive error.

#### Return Shape

`peer_await` returns one of three outcomes: `resolved`, `timed_out`, or `cancelled`.

##### When resolved:
```json
{
  "status": "resolved",
  "topic": "build",
  "key": "artifact",
  "payload": { "path": "dist/bundle.js" },
  "elapsed_ms": 204
}
```

##### When timed out:
```json
{
  "status": "timed_out",
  "topic": "build",
  "key": "artifact",
  "waited_ms": 60000
}
```

##### When cancelled:
```json
{
  "status": "cancelled",
  "topic": "build",
  "key": "artifact",
  "reason": "aborted"
}
```

The three outcomes and their fields:
- `resolved`: The key was published (either already present or published while waiting). Includes `payload` and `elapsed_ms`.
- `timed_out`: The timeout elapsed before the key was published. Includes `waited_ms`.
- `cancelled`: Waiting was interrupted before resolution or timeout. The `reason` field indicates the cause:
  - `"aborted"`: The caller's tool call was cancelled (e.g. abort signal).
  - `"disposed"`: The plugin was unloaded or disposed.
  - `"evicted"`: The workspace was dropped by the workspace cap.

---

### `peer_broadcast`

Fire-and-forget notice into a per-topic rolling ring buffer capped at the newest 50 messages (older messages are dropped).

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `topic` | string | No | "general" | Target topic for the broadcast notice. |
| `sender` | string | Yes | None | Sender name or agent identifier. |
| `message` | string | Yes | None | Broadcast message text (max 16 384 bytes). |

#### Buffer Behavior and Retrieval

- Ring buffer is capped at the newest 50 messages per topic. When full, older messages are dropped.
- Messages exceeding 16 384 bytes (16 KiB) fail with an error; nothing is appended.
- Messages are read back with `peer_read({ topic })`.

#### Return Shape

```json
{
  "status": "broadcasted",
  "topic": "general",
  "timestamp": "2026-11-06T12:00:00.000Z"
}
```

---

## Diagnostics Export

The module directly exports a diagnostic inspection function:

```javascript
diagnostics(workspaceId = 'default')
```

### Signature and Behavior

- Parameter: `workspaceId` (string, optional, default `'default'`). Normalises whitespace in the workspace id the same way the tools do.
- Operation: Read-only with no side effects; creates nothing and performs no state mutations.
- Safety: Per-topic counts are safe for any topic name (including names like `__proto__`).
- Return value:
  ```json
  {
    "workspaceId": "default",
    "keys": 4,
    "listeners": 0,
    "broadcasts": {
      "general": 12,
      "build": 3
    },
    "evicted": {
      "keys": 0,
      "topics": 0,
      "workspaces": 0
    }
  }
  ```
  - `workspaceId`: The inspected workspace identifier.
  - `keys`: Live entry count in the workspace key/value store.
  - `listeners`: Total attached `EventEmitter` listener count across keys in the workspace.
  - `broadcasts`: Topic-to-message-count mapping showing retained message counts per topic.
  - `evicted`: Process-wide cumulative counters `{ keys, topics, workspaces }` tracking entries discarded when caps are exceeded. Hitting a cap discards the oldest data silently, but is now observable through these cumulative counters.

The smoke test uses `diagnostics()` to prove no listeners leak after resolution or timeout.

## Deliberate trade-offs

Three behaviours evaluated during adversarial audit are intentional design choices rather than defects:

1. **`peer_await` timeout timer is not unreferenced**: The `peer_await` timeout timer is intentionally not `unref()`'d, because an unref'd timer would let the process exit with the promise unsettled and the tool call could hang forever — the accepted cost is that a pending wait may delay shutdown by up to the timeout.
2. **`peer_read` does not refresh broadcast recency**: `peer_read` does not refresh broadcast-topic recency, because recency tracks writes and a read must not protect a topic from eviction.
3. **`peer_await` post-listener re-check reads the clock again**: The post-listener re-check inside `peer_await` reads the clock again, which is correct because it is a later moment.

## Testing

The plugin ships `test/smoke.mjs`, a zero-dependency Node ESM script run with `node test/smoke.mjs` from the plugin directory.

### Running the Test Suite

Run the following command from the plugin root directory:

```bash
node test/smoke.mjs
```

### Test Cases

The test suite exercises 24 cases:
1. `publish+read round-trip preserves payload exactly`: Verifies publishing a key, reading it back, and overwriting the payload with last-write-wins TTL reset.
2. `await resolves immediately when key already published`: Verifies that `peer_await` immediately returns when the requested key already exists in the store.
3. `await resolves asynchronously when peer publishes 200ms later`: Verifies asynchronous peer signaling where a listener is woken 200 ms later by a peer publication.
4. `await times out cleanly with no lingering listeners`: Verifies timeout handling and inspects `diagnostics()` to ensure zero lingering listeners remain.
5. `broadcast ring buffer appends and caps at 50`: Verifies that the rolling broadcast buffer retains exactly the newest 50 messages and discards older entries.
6. `workspace isolation keeps identical keys apart`: Verifies that distinct workspaces maintain independent key/value stores, event emitters, and broadcast streams.
7. `ttl expiry hides the key from readers`: Verifies that keys past their TTL are immediately hidden on read and removed during background sweeps.
8. `multiple concurrent waiters all wake on one publish`: Verifies that multiple concurrent waiters all wake on one publish.
9. `await cancels cleanly on abort`: Verifies that await cancels cleanly on abort with status `cancelled` and reason `aborted`.
10. `catalog caps keys and reports truncation`: Verifies that catalog caps keys and reports truncation with `total` and `truncated: true` when exceeding 200 keys.
11. `oversized payload is rejected`: Verifies that an oversized payload is rejected by `peer_publish` without being stored.
12. `colon in topic or key does not alias`: Verifies that composite keys are internal and length-prefixed so a colon in topic or key does not alias another pair.
13. `dispose cancels pending waiters`: Verifies that dispose cancels pending waiters with status `cancelled` and reason `disposed`.
14. `key cap evicts the oldest entries`: Verifies that key cap evicts the oldest entries when workspace exceeds 2 000 keys.
15. `object payloads keep their type`: Verifies that object payloads keep their type as structured data without stringification.
16. `secondary context dispose preserves shared state`: Verifies that disposing a secondary plugin instance preserves the shared workspace store and keeps background sweeps active until the final instance is torn down.
17. `ttl zero expires immediately`: Verifies that a TTL of 0 expires the entry immediately so that an immediate `peer_read` returns `found: false`.
18. `string payload size is measured raw not escaped`: Verifies that string payload size is measured on its raw UTF-8 byte length rather than JSON-escaped representation.
19. `json-looking string payload stays a string`: Verifies that a string payload containing JSON text is stored and read verbatim as a string without being parsed.
20. `payload_json stores a parsed object`: Verifies that publishing via `payload_json` parses the JSON string and stores a real structured object.
21. `payload_json rejects invalid json`: Verifies that malformed JSON in `payload_json` is rejected with an error matching `not valid JSON`.
22. `payload and payload_json together are rejected`: Verifies that supplying both `payload` and `payload_json` is rejected with an error matching `not both`.
23. `evicted workspace cancels its waiters with reason evicted`: Verifies that an evicted workspace cancels its pending waiters with status `cancelled` and reason `evicted`.
24. `diagnostics reports cumulative eviction counters`: Verifies that `diagnostics()` reports cumulative process-wide eviction counters for keys, topics, and workspaces.

### Output

The test runner prints one PASS line per case and finishes with `SMOKE OK (24 cases)`:

```text
PASS publish+read round-trip preserves payload exactly
PASS await resolves immediately when key already published
PASS await resolves asynchronously when peer publishes 200ms later
PASS await times out cleanly with no lingering listeners
PASS broadcast ring buffer appends and caps at 50
PASS workspace isolation keeps identical keys apart
PASS ttl expiry hides the key from readers
PASS multiple concurrent waiters all wake on one publish
PASS await cancels cleanly on abort
PASS catalog caps keys and reports truncation
PASS oversized payload is rejected
PASS colon in topic or key does not alias
PASS dispose cancels pending waiters
PASS key cap evicts the oldest entries
PASS object payloads keep their type
PASS secondary context dispose preserves shared state
PASS ttl zero expires immediately
PASS string payload size is measured raw not escaped
PASS json-looking string payload stays a string
PASS payload_json stores a parsed object
PASS payload_json rejects invalid json
PASS payload and payload_json together are rejected
PASS evicted workspace cancels its waiters with reason evicted
PASS diagnostics reports cumulative eviction counters
SMOKE OK (24 cases)
```
