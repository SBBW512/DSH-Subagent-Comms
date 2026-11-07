import { EventEmitter } from 'node:events'

export const name = 'peer-sync'
export const inject = ['tools']

const DEFAULT_TTL_SECONDS = 3600
const BROADCAST_CAP = 50
const SWEEP_INTERVAL_MS = 60_000
const MAX_PAYLOAD_BYTES = 262_144
const MAX_MESSAGE_BYTES = 16_384
const MAX_KEYS_PER_WORKSPACE = 2_000
const MAX_TOPICS_PER_WORKSPACE = 500
const MAX_WORKSPACES = 64
const MAX_CATALOG_KEYS = 200

const workspaces = new Map() // workspaceId -> { kv: Map, emitter: EventEmitter, broadcasts: Map, waiters: Set }
const evictions = { keys: 0, topics: 0, workspaces: 0 }
let sweepTimer = null
let liveApplies = 0

const compositeKey = (topic, key) => `${topic.length}:${topic}${key}`

function validateString(value, tool, name, disallowEmpty = false) {
  if (typeof value !== 'string') {
    throw new Error(`${tool}: ${name} must be a string (received ${typeof value})`)
  }
  if (disallowEmpty && value.trim() === '') {
    throw new Error(`${tool}: ${name} must be a string (received empty string)`)
  }
}

function measureBytes(tool, value) {
  try {
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch (err) {
    throw new Error(`${tool}: payload is not JSON-serialisable (${err && err.message ? err.message : err})`)
  }
}

function workspaceIdOf(exec) {
  const raw = exec?.agent?.workspaceId
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'default'
}

function storeFor(workspaceId) {
  let ws = workspaces.get(workspaceId)
  if (ws) {
    workspaces.delete(workspaceId)
    workspaces.set(workspaceId, ws)
    return ws
  }

  while (workspaces.size >= MAX_WORKSPACES) {
    const lruWsId = workspaces.keys().next().value
    const evictedWs = workspaces.get(lruWsId)
    if (evictedWs?.waiters) {
      for (const cancel of evictedWs.waiters) {
        try {
          cancel('evicted')
        } catch {}
      }
      evictedWs.waiters.clear()
    }
    workspaces.delete(lruWsId)
    evictions.workspaces += 1
  }

  ws = {
    kv: new Map(),
    emitter: new EventEmitter(),
    broadcasts: new Map(),
    waiters: new Set(),
  }
  ws.emitter.setMaxListeners(0)
  workspaces.set(workspaceId, ws)
  return ws
}

function getLiveEntry(ws, kvKey, now = Date.now()) {
  const entry = ws.kv.get(kvKey)
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    ws.kv.delete(kvKey)
    return undefined
  }
  return entry
}

/**
 * Return in-memory diagnostics for the given workspace.
 *
 * @param {string} [workspaceId='default'] - Workspace identifier.
 * @returns {{ workspaceId: string, keys: number, listeners: number, broadcasts: Record<string, number>, evicted: { keys: number, topics: number, workspaces: number } }}
 */
export function diagnostics(workspaceId = 'default') {
  const id =
    typeof workspaceId === 'string' && workspaceId.trim() !== ''
      ? workspaceId.trim()
      : 'default'
  const ws = workspaces.get(id)
  if (!ws) {
    return {
      workspaceId: id,
      keys: 0,
      listeners: 0,
      broadcasts: Object.create(null),
      evicted: {
        keys: evictions.keys,
        topics: evictions.topics,
        workspaces: evictions.workspaces,
      },
    }
  }

  const now = Date.now()
  let liveKeys = 0
  for (const entry of ws.kv.values()) {
    if (entry.expiresAt > now) {
      liveKeys++
    }
  }

  const totalListeners = ws.emitter
    .eventNames()
    .reduce((sum, evtName) => sum + ws.emitter.listenerCount(evtName), 0)

  const broadcastCounts = Object.create(null)
  for (const [topic, buffer] of ws.broadcasts.entries()) {
    broadcastCounts[topic] = buffer.length
  }

  return {
    workspaceId: id,
    keys: liveKeys,
    listeners: totalListeners,
    broadcasts: broadcastCounts,
    evicted: {
      keys: evictions.keys,
      topics: evictions.topics,
      workspaces: evictions.workspaces,
    },
  }
}

export function apply(ctx) {
  let createdSweepTimer = false
  let disposed = false
  const localWaiters = new Set()
  try {
    liveApplies += 1

    const cleanup = () => {
      if (disposed) return
      disposed = true

      for (const cancel of localWaiters) {
        try {
          cancel('disposed')
        } catch {}
      }
      localWaiters.clear()

      liveApplies -= 1
      if (liveApplies > 0) return

      if (sweepTimer !== null) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
      for (const ws of workspaces.values()) {
        if (ws.waiters) {
          for (const cancel of ws.waiters) {
            try {
              cancel('disposed')
            } catch {}
          }
          ws.waiters.clear()
        }
      }
      workspaces.clear()
    }

    if (typeof ctx?.on === 'function') {
      ctx.on('dispose', cleanup)
    }

    const toolOutput = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        let text
        if (typeof value === 'string') {
          text = value
        } else {
          try {
            text = JSON.stringify(value, null, 2)
          } catch {
            text = String(value)
          }
        }
        return [{ type: 'text', text }]
      },
    }

    /* ----------------------------------------------------------- peer_publish */

    ctx.tools.register({
      name: 'peer_publish',
      description:
        'Publish a data payload, interface definition, or status under a specific topic and key in the shared workspace blackboard. Immediately resolves any concurrent peer subagents currently waiting on this key via peer_await.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'key'],
        properties: {
          topic: {
            type: 'string',
            minLength: 1,
            description: 'Grouping topic (e.g. "contracts", "signals", "build").',
          },
          key: {
            type: 'string',
            minLength: 1,
            description: 'Unique identifier (e.g. "WeightUnits", "ready").',
          },
          payload: {
            description:
              'Verbatim value, stored exactly as received. Note: this host delivers a non-scalar value here as JSON text, so use payload_json when you need a real structure.',
            oneOf: [
              { type: 'object', description: 'Structured JSON object (preferred for contracts and interfaces).' },
              { type: 'array', description: 'Structured JSON array.' },
              { type: 'string', description: 'Plain string, code snippet, or status text.' },
              { type: 'number' },
              { type: 'boolean' },
            ],
          },
          ttl_seconds: {
            type: 'number',
            minimum: 0,
            description: 'Time-to-live in seconds before automatic cleanup. Default 3600.',
          },
          payload_json: {
            type: 'string',
            description:
              'JSON-encoded value to decode and store as a real structure (object, array, number, boolean or string). Use this instead of payload when publishing structured data. Must be valid JSON text; invalid JSON is rejected.',
          },
        },
      },
      output: toolOutput,
      execute(args, exec) {
        validateString(args?.topic, 'peer_publish', 'topic', true)
        validateString(args?.key, 'peer_publish', 'key', true)

        const hasPayload = args?.payload !== undefined
        const hasJson = args?.payload_json !== undefined
        if (hasPayload && hasJson) {
          throw new Error('peer_publish: provide either payload or payload_json, not both')
        }
        if (!hasPayload && !hasJson) {
          throw new Error('peer_publish: payload or payload_json is required')
        }

        let value
        if (hasJson) {
          validateString(args.payload_json, 'peer_publish', 'payload_json', true)
          try {
            value = JSON.parse(args.payload_json)
          } catch (err) {
            throw new Error(`peer_publish: payload_json is not valid JSON (${err && err.message ? err.message : err})`)
          }
        } else {
          value = args.payload
        }

        const bytes = measureBytes('peer_publish', value)
        if (bytes > MAX_PAYLOAD_BYTES) {
          throw new Error(`peer_publish: payload is ${bytes} bytes, limit is ${MAX_PAYLOAD_BYTES}`)
        }

        if (args?.ttl_seconds !== undefined) {
          if (
            typeof args.ttl_seconds !== 'number' ||
            !Number.isFinite(args.ttl_seconds) ||
            args.ttl_seconds < 0
          ) {
            throw new Error('peer_publish: ttl_seconds must be a number greater than or equal to 0')
          }
        }

        const ws = storeFor(workspaceIdOf(exec))
        const ttl =
          args?.ttl_seconds !== undefined
            ? args.ttl_seconds
            : DEFAULT_TTL_SECONDS
        const publishedAt = new Date().toISOString()
        const expiresAt = Date.now() + ttl * 1000
        const kvKey = compositeKey(args.topic, args.key)

        ws.kv.delete(kvKey)
        ws.kv.set(kvKey, { payload: value, expiresAt, publishedAt })

        while (ws.kv.size > MAX_KEYS_PER_WORKSPACE) {
          const oldestKey = ws.kv.keys().next().value
          ws.kv.delete(oldestKey)
          evictions.keys += 1
        }

        ws.emitter.emit(kvKey, { payload: value, publishedAt })
        return {
          status: 'published',
          topic: args.topic,
          key: args.key,
          timestamp: publishedAt,
        }
      },
    })

    /* -------------------------------------------------------------- peer_read */

    ctx.tools.register({
      name: 'peer_read',
      description:
        'Read a published payload from the workspace blackboard without blocking. If key is omitted, returns a catalog of all currently published keys and metadata under that topic.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['topic'],
        properties: {
          topic: {
            type: 'string',
            description: 'Grouping topic to read from.',
          },
          key: {
            type: 'string',
            description: 'Exact key to read. Omit to list every key under the topic.',
          },
        },
      },
      output: toolOutput,
      execute(args, exec) {
        validateString(args?.topic, 'peer_read', 'topic', true)
        if (args?.key !== undefined) {
          validateString(args.key, 'peer_read', 'key', true)
        }

        const ws = storeFor(workspaceIdOf(exec))
        const now = Date.now()

        if (args.key !== undefined) {
          const kvKey = compositeKey(args.topic, args.key)
          const entry = ws.kv.get(kvKey)
          if (entry) {
            if (entry.expiresAt <= now) {
              ws.kv.delete(kvKey)
            } else {
              return {
                found: true,
                topic: args.topic,
                key: args.key,
                payload: entry.payload,
                published_at: entry.publishedAt,
              }
            }
          }
          return {
            found: false,
            topic: args.topic,
            key: args.key,
          }
        }

        const prefix = compositeKey(args.topic, '')
        const keys = []
        let total = 0
        for (const [k, entry] of ws.kv.entries()) {
          if (k.startsWith(prefix)) {
            if (entry.expiresAt <= now) {
              ws.kv.delete(k)
            } else {
              total++
              if (keys.length < MAX_CATALOG_KEYS) {
                const bareKey = k.slice(prefix.length)
                let payloadType
                if (Array.isArray(entry.payload)) {
                  payloadType = 'array'
                } else if (entry.payload === null) {
                  payloadType = 'null'
                } else {
                  payloadType = typeof entry.payload
                }
                keys.push({
                  key: bareKey,
                  published_at: entry.publishedAt,
                  type: payloadType,
                })
              }
            }
          }
        }
        const buffer = ws.broadcasts.get(args.topic) ?? []
        return {
          topic: args.topic,
          keys,
          broadcasts: [...buffer],
          total,
          truncated: total > keys.length,
        }
      },
    })

    /* ------------------------------------------------------------- peer_await */

    ctx.tools.register({
      name: 'peer_await',
      description:
        'Asynchronously wait for a specific key under a topic to be published by a peer subagent. Blocks the tool call in Node.js memory without generating LLM tokens or running polling loops. Resolves immediately when published, or returns a timeout status.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'key'],
        properties: {
          topic: {
            type: 'string',
            description: 'Grouping topic to wait on.',
          },
          key: {
            type: 'string',
            description: 'Unique identifier to wait for.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 180000,
            description: 'Maximum duration to wait before timing out. Default 60000.',
          },
        },
      },
      output: toolOutput,
      async execute(args, exec) {
        const started = Date.now()
        validateString(args?.topic, 'peer_await', 'topic', true)
        validateString(args?.key, 'peer_await', 'key', true)

        const signal = exec?.signal
        if (signal?.aborted) {
          return {
            status: 'cancelled',
            topic: args.topic,
            key: args.key,
            waited_ms: 0,
            reason: 'aborted',
          }
        }

        const timeoutMs = Math.min(
          180000,
          Math.max(1000, Number.isFinite(args?.timeout_ms) ? Math.trunc(args.timeout_ms) : 60000),
        )
        const ws = storeFor(workspaceIdOf(exec))
        const evt = compositeKey(args.topic, args.key)

        const live = getLiveEntry(ws, evt, started)
        if (live) {
          return {
            status: 'resolved',
            topic: args.topic,
            key: args.key,
            payload: live.payload,
            elapsed_ms: Math.max(0, Date.now() - started),
          }
        }

        return new Promise((resolve) => {
          let timer = null
          let handler = null
          let onAbort = null
          let onDispose = null

          const cleanup = () => {
            if (timer !== null) {
              clearTimeout(timer)
              timer = null
            }
            if (handler !== null) {
              ws.emitter.off(evt, handler)
              handler = null
            }
            if (onAbort !== null && typeof signal?.removeEventListener === 'function') {
              signal.removeEventListener('abort', onAbort)
              onAbort = null
            }
            if (onDispose !== null) {
              ws.waiters.delete(onDispose)
              localWaiters.delete(onDispose)
              onDispose = null
            }
          }

          handler = (record) => {
            cleanup()
            resolve({
              status: 'resolved',
              topic: args.topic,
              key: args.key,
              payload: record.payload,
              elapsed_ms: Math.max(0, Date.now() - started),
            })
          }

          // This timer is intentionally NOT unref()'d: an unref'd timer would
          // let Node exit with the promise unsettled, so the tool call could
          // hang forever; the accepted trade-off is that a pending wait can
          // delay process shutdown by up to the timeout.
          timer = setTimeout(() => {
            cleanup()
            resolve({
              status: 'timed_out',
              topic: args.topic,
              key: args.key,
              waited_ms: Math.max(0, Date.now() - started),
            })
          }, timeoutMs)

          if (typeof signal?.addEventListener === 'function') {
            onAbort = () => {
              cleanup()
              resolve({
                status: 'cancelled',
                topic: args.topic,
                key: args.key,
                waited_ms: Math.max(0, Date.now() - started),
                reason: 'aborted',
              })
            }
            signal.addEventListener('abort', onAbort)
          }

          onDispose = (reason = 'disposed') => {
            cleanup()
            resolve({
              status: 'cancelled',
              topic: args.topic,
              key: args.key,
              waited_ms: Math.max(0, Date.now() - started),
              reason,
            })
          }
          ws.waiters.add(onDispose)
          localWaiters.add(onDispose)

          ws.emitter.once(evt, handler)

          if (signal?.aborted) {
            if (onAbort) onAbort()
            return
          }

          const liveAfter = getLiveEntry(ws, evt)
          if (liveAfter) {
            cleanup()
            resolve({
              status: 'resolved',
              topic: args.topic,
              key: args.key,
              payload: liveAfter.payload,
              elapsed_ms: Math.max(0, Date.now() - started),
            })
          }
        })
      },
    })

    /* --------------------------------------------------------- peer_broadcast */

    ctx.tools.register({
      name: 'peer_broadcast',
      description:
        'Broadcast a lightweight notification message to peer workers into an in-memory rolling ring buffer (max 50 messages per topic). Useful for announcing non-blocking progress or broad warnings (e.g. \'Removed arcBrush parameter\').',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sender', 'message'],
        properties: {
          topic: {
            type: 'string',
            description: 'Broadcast channel name. Default "general".',
          },
          sender: {
            type: 'string',
            description: 'Caller task slug or worker ID.',
          },
          message: {
            type: 'string',
            description: 'Concise status or notice.',
          },
        },
      },
      output: toolOutput,
      execute(args, exec) {
        if (args?.topic !== undefined && args.topic !== '') {
          validateString(args.topic, 'peer_broadcast', 'topic', true)
        }
        validateString(args?.sender, 'peer_broadcast', 'sender', false)
        validateString(args?.message, 'peer_broadcast', 'message', false)

        const msgBytes = Buffer.byteLength(args.message, 'utf8')
        if (msgBytes > MAX_MESSAGE_BYTES) {
          throw new Error(`peer_broadcast: message is ${msgBytes} bytes, limit is ${MAX_MESSAGE_BYTES}`)
        }

        const ws = storeFor(workspaceIdOf(exec))
        const topic =
          args.topic === undefined || args.topic === '' ? 'general' : args.topic
        let buffer = ws.broadcasts.get(topic)
        if (!buffer) {
          buffer = []
        } else {
          ws.broadcasts.delete(topic)
        }
        ws.broadcasts.set(topic, buffer)

        while (ws.broadcasts.size > MAX_TOPICS_PER_WORKSPACE) {
          const lruTopic = ws.broadcasts.keys().next().value
          ws.broadcasts.delete(lruTopic)
          evictions.topics += 1
        }

        const timestamp = new Date().toISOString()
        buffer.push({
          sender: args.sender,
          message: args.message,
          timestamp,
        })
        if (buffer.length > BROADCAST_CAP) {
          buffer.splice(0, buffer.length - BROADCAST_CAP)
        }
        return {
          status: 'broadcasted',
          topic,
          timestamp,
        }
      },
    })

    if (sweepTimer === null) {
      sweepTimer = setInterval(() => {
        const now = Date.now()
        for (const ws of workspaces.values()) {
          for (const [k, entry] of ws.kv.entries()) {
            if (entry.expiresAt <= now) {
              ws.kv.delete(k)
            }
          }
        }
      }, SWEEP_INTERVAL_MS)
      sweepTimer.unref?.()
      createdSweepTimer = true
    }
  } catch (err) {
    disposed = true
    if (createdSweepTimer && sweepTimer !== null) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    liveApplies -= 1
    console.error('[peer-sync] failed to initialise:', err && err.message ? err.message : err)
    return
  }
}
