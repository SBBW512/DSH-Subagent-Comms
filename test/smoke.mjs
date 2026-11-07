import assert from 'node:assert/strict'
import { apply, name, inject, diagnostics } from '../index.js'

process.on('unhandledRejection', (err) => {
  console.error('FAIL unhandled rejection:', err)
  process.exitCode = 1
})

function makeCtx() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        assert.equal(typeof def.name, 'string')
        assert.ok(!tools.has(def.name), `duplicate tool ${def.name}`)
        tools.set(def.name, def)
        const dispose = () => tools.delete(def.name)
        disposers.push(dispose)
        return dispose
      },
    },
    on(event, listener) {
      if (event === 'dispose') disposers.push(listener)
    },
  }
  apply(ctx)
  return { tools, disposeAll: () => disposers.forEach((d) => d()) }
}

const call = (tools, toolName, args, exec = {}) => tools.get(toolName).execute(args, exec)

// Early assertions
assert.equal(name, 'peer-sync')
assert.deepEqual(inject, ['tools'])

const { tools, disposeAll } = makeCtx()
assert.ok(tools.has('peer_publish'))
assert.ok(tools.has('peer_read'))
assert.ok(tools.has('peer_await'))
assert.ok(tools.has('peer_broadcast'))

let failed = false

async function runCase(caseName, fn) {
  try {
    await fn()
    console.log(`PASS ${caseName}`)
  } catch (err) {
    failed = true
    process.exitCode = 1
    console.error(`FAIL ${caseName}: ${err.message}`)
  }
}

// 1. publish+read round-trip preserves payload exactly
await runCase('publish+read round-trip preserves payload exactly', async () => {
  const pub1 = await call(tools, 'peer_publish', {
    topic: 'contracts',
    key: 'WeightUnits',
    payload: { unit: 'kg', decimals: 3 },
  })
  assert.equal(pub1.status, 'published')
  assert.equal(pub1.topic, 'contracts')
  assert.equal(pub1.key, 'WeightUnits')

  const read1 = await call(tools, 'peer_read', {
    topic: 'contracts',
    key: 'WeightUnits',
  })
  assert.equal(read1.found, true)
  assert.deepEqual(read1.payload, { unit: 'kg', decimals: 3 })
  assert.equal(read1.topic, 'contracts')
  assert.equal(read1.key, 'WeightUnits')
  assert.equal(typeof read1.published_at, 'string')

  const pub2 = await call(tools, 'peer_publish', {
    topic: 'contracts',
    key: 'WeightUnits',
    payload: 'kg-v2',
  })
  assert.equal(pub2.status, 'published')

  const read2 = await call(tools, 'peer_read', {
    topic: 'contracts',
    key: 'WeightUnits',
  })
  assert.equal(read2.found, true)
  assert.equal(read2.payload, 'kg-v2')
})

// 2. await resolves immediately when key already published
await runCase('await resolves immediately when key already published', async () => {
  await call(tools, 'peer_publish', {
    topic: 'c2-topic',
    key: 'c2-key',
    payload: { instant: true },
  })

  const awaitRes = await call(tools, 'peer_await', {
    topic: 'c2-topic',
    key: 'c2-key',
    timeout_ms: 5000,
  })
  assert.equal(awaitRes.status, 'resolved')
  assert.deepEqual(awaitRes.payload, { instant: true })
  assert.ok(awaitRes.elapsed_ms < 1000, `expected elapsed_ms < 1000, got ${awaitRes.elapsed_ms}`)
})

// 3. await resolves asynchronously when peer publishes 200ms later
await runCase('await resolves asynchronously when peer publishes 200ms later', async () => {
  const topic = 'c3-topic'
  const key = 'c3-key'
  const payload = { delayed: 'ok' }

  setTimeout(() => {
    call(tools, 'peer_publish', { topic, key, payload })
  }, 200)

  const awaitRes = await call(tools, 'peer_await', {
    topic,
    key,
    timeout_ms: 5000,
  })

  assert.equal(awaitRes.status, 'resolved')
  assert.deepEqual(awaitRes.payload, payload)
  assert.ok(
    awaitRes.elapsed_ms >= 150,
    `expected elapsed_ms >= 150, got ${awaitRes.elapsed_ms}`,
  )
})

// 4. await times out cleanly with no lingering listeners
await runCase('await times out cleanly with no lingering listeners', async () => {
  const res = await call(tools, 'peer_await', {
    topic: 'c4-topic',
    key: 'c4-key',
    timeout_ms: 1000,
  })
  assert.equal(res.status, 'timed_out')
  assert.ok(res.waited_ms >= 950, `expected waited_ms >= 950, got ${res.waited_ms}`)
  const diag = diagnostics('default')
  assert.equal(diag.listeners, 0, `expected 0 listeners, got ${diag.listeners}`)
})

// 5. broadcast ring buffer appends and caps at 50
await runCase('broadcast ring buffer appends and caps at 50', async () => {
  const topic = 'c5-topic'
  for (let i = 1; i <= 55; i++) {
    await call(tools, 'peer_broadcast', {
      topic,
      sender: `worker-${i}`,
      message: `msg-${i}`,
    })
  }

  const readRes = await call(tools, 'peer_read', { topic })
  assert.equal(readRes.broadcasts.length, 50)
  assert.equal(readRes.broadcasts[0].sender, 'worker-6')
  assert.equal(readRes.broadcasts[0].message, 'msg-6')
  assert.equal(readRes.broadcasts[49].sender, 'worker-55')
  assert.equal(readRes.broadcasts[49].message, 'msg-55')
})

// 6. workspace isolation keeps identical keys apart
await runCase('workspace isolation keeps identical keys apart', async () => {
  const execA = { agent: { workspaceId: 'ws-a' } }
  const execB = { agent: { workspaceId: 'ws-b' } }
  const topic = 'c6-topic'
  const key = 'c6-key'

  await call(tools, 'peer_publish', { topic, key, payload: 'payload-A' }, execA)
  await call(tools, 'peer_publish', { topic, key, payload: 'payload-B' }, execB)

  const readA = await call(tools, 'peer_read', { topic, key }, execA)
  const readB = await call(tools, 'peer_read', { topic, key }, execB)

  assert.equal(readA.found, true)
  assert.equal(readA.payload, 'payload-A')
  assert.equal(readB.found, true)
  assert.equal(readB.payload, 'payload-B')

  const diagA = diagnostics('ws-a')
  const diagB = diagnostics('ws-b')
  assert.equal(diagA.keys, 1)
  assert.equal(diagB.keys, 1)
})

// 7. ttl expiry hides the key from readers
await runCase('ttl expiry hides the key from readers', async () => {
  const topic = 'c7-topic'
  const key = 'c7-key'

  await call(tools, 'peer_publish', {
    topic,
    key,
    payload: 'temp',
    ttl_seconds: 0.05,
  })

  await new Promise((r) => setTimeout(r, 120))

  const readRes = await call(tools, 'peer_read', { topic, key })
  assert.equal(readRes.found, false)
})

// 8. multiple concurrent waiters all wake on one publish
await runCase('multiple concurrent waiters all wake on one publish', async () => {
  const topic = 'c8-topic'
  const key = 'c8-key'
  const payload = { shared: 42 }

  const p1 = call(tools, 'peer_await', { topic, key, timeout_ms: 5000 })
  const p2 = call(tools, 'peer_await', { topic, key, timeout_ms: 5000 })
  const p3 = call(tools, 'peer_await', { topic, key, timeout_ms: 5000 })

  await new Promise((r) => setTimeout(r, 20))
  await call(tools, 'peer_publish', { topic, key, payload })

  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  assert.equal(r1.status, 'resolved')
  assert.equal(r2.status, 'resolved')
  assert.equal(r3.status, 'resolved')
  assert.deepEqual(r1.payload, payload)
  assert.deepEqual(r2.payload, payload)
  assert.deepEqual(r3.payload, payload)
})

// 9. await cancels cleanly on abort
await runCase('await cancels cleanly on abort', async () => {
  const controller = new AbortController()
  const exec = { signal: controller.signal }
  const topic = 'c9-topic'
  const key = 'c9-key'

  const awaitPromise = call(tools, 'peer_await', { topic, key, timeout_ms: 5000 }, exec)
  setTimeout(() => controller.abort(), 50)

  const res = await awaitPromise
  assert.equal(res.status, 'cancelled')
  assert.equal(res.reason, 'aborted')
  assert.equal(res.topic, topic)
  assert.equal(res.key, key)
  const diag = diagnostics('default')
  assert.equal(diag.listeners, 0, `expected 0 listeners, got ${diag.listeners}`)
})

// 10. catalog caps keys and reports truncation
await runCase('catalog caps keys and reports truncation', async () => {
  const topic = 'c10-topic'
  for (let i = 1; i <= 205; i++) {
    await call(tools, 'peer_publish', {
      topic,
      key: `key-${i}`,
      payload: i,
    })
  }

  const readRes = await call(tools, 'peer_read', { topic })
  assert.equal(readRes.keys.length, 200)
  assert.equal(readRes.total, 205)
  assert.equal(readRes.truncated, true)
})

// 11. oversized payload is rejected
await runCase('oversized payload is rejected', async () => {
  const bigString = 'x'.repeat(300 * 1024)
  await assert.rejects(
    async () => {
      await call(tools, 'peer_publish', {
        topic: 'c11-topic',
        key: 'c11-key',
        payload: bigString,
      })
    },
    (err) => {
      assert.ok(err instanceof Error)
      assert.ok(err.message.includes('262144'), `expected 262144 in error message: ${err.message}`)
      return true
    },
  )
})

// 12. colon in topic or key does not alias
await runCase('colon in topic or key does not alias', async () => {
  await call(tools, 'peer_publish', {
    topic: 'a',
    key: 'b:c',
    payload: 'one',
  })
  await call(tools, 'peer_publish', {
    topic: 'a:b',
    key: 'c',
    payload: 'two',
  })

  const read1 = await call(tools, 'peer_read', { topic: 'a', key: 'b:c' })
  const read2 = await call(tools, 'peer_read', { topic: 'a:b', key: 'c' })

  assert.equal(read1.found, true)
  assert.equal(read1.payload, 'one')
  assert.equal(read2.found, true)
  assert.equal(read2.payload, 'two')

  const catalogA = await call(tools, 'peer_read', { topic: 'a' })
  const keysInA = catalogA.keys.map((x) => x.key)
  assert.ok(keysInA.includes('b:c'), `expected b:c in catalogA: ${JSON.stringify(keysInA)}`)
  assert.ok(!keysInA.includes('c'), `expected c NOT in catalogA: ${JSON.stringify(keysInA)}`)
})

// 13. dispose cancels pending waiters
await runCase('dispose cancels pending waiters', async () => {
  const local = makeCtx()
  const p = call(local.tools, 'peer_await', {
    topic: 'c13-topic',
    key: 'c13-key',
    timeout_ms: 60000,
  })
  await new Promise((r) => setTimeout(r, 20))
  local.disposeAll()
  const res = await p
  assert.equal(res.status, 'cancelled')
  assert.equal(res.reason, 'disposed')
})

// 14. key cap evicts the oldest entries
await runCase('key cap evicts the oldest entries', async () => {
  const ws = 'ws-case14'
  const exec = { agent: { workspaceId: ws } }
  const topic = 'c14-topic'
  const total = 2003

  for (let i = 1; i <= total; i++) {
    await call(
      tools,
      'peer_publish',
      {
        topic,
        key: `k-${i}`,
        payload: `val-${i}`,
      },
      exec,
    )
  }

  const diag = diagnostics(ws)
  assert.equal(diag.keys, 2000, `expected 2000 keys, got ${diag.keys}`)

  const r1 = await call(tools, 'peer_read', { topic, key: 'k-1' }, exec)
  const r2 = await call(tools, 'peer_read', { topic, key: 'k-2' }, exec)
  const r3 = await call(tools, 'peer_read', { topic, key: 'k-3' }, exec)
  assert.equal(r1.found, false, 'expected k-1 to be evicted')
  assert.equal(r2.found, false, 'expected k-2 to be evicted')
  assert.equal(r3.found, false, 'expected k-3 to be evicted')

  const rNewest = await call(tools, 'peer_read', { topic, key: 'k-2003' }, exec)
  assert.equal(rNewest.found, true, 'expected k-2003 to be present')
  assert.equal(rNewest.payload, 'val-2003')
})

// 15. object payloads keep their type
await runCase('object payloads keep their type', async () => {
  const topic = 'c15-topic'
  const key = 'c15-key'
  const payloadObj = { unit: 'kg', decimals: 3 }

  await call(tools, 'peer_publish', {
    topic,
    key,
    payload: payloadObj,
  })

  const readRes = await call(tools, 'peer_read', { topic, key })
  assert.equal(readRes.found, true)
  assert.deepEqual(readRes.payload, payloadObj)
  assert.equal(typeof readRes.payload, 'object')
  assert.notEqual(typeof readRes.payload, 'string')

  const catalog = await call(tools, 'peer_read', { topic })
  const entry = catalog.keys.find((k) => k.key === key)
  assert.ok(entry, 'expected key in catalog')
  assert.equal(entry.type, 'object')
})

// 16. secondary context dispose preserves shared state
await runCase('secondary context dispose preserves shared state', async () => {
  const ctx2 = makeCtx()
  await call(tools, 'peer_publish', {
    topic: 'c16-topic',
    key: 'c16-key',
    payload: 'c16-value',
  })

  ctx2.disposeAll()

  const readRes = await call(tools, 'peer_read', {
    topic: 'c16-topic',
    key: 'c16-key',
  })
  assert.equal(readRes.found, true)
  assert.equal(readRes.payload, 'c16-value')

  const diag = diagnostics('default')
  assert.equal(diag.listeners, 0)
})

// 17. ttl zero expires immediately
await runCase('ttl zero expires immediately', async () => {
  await call(tools, 'peer_publish', {
    topic: 'c17-topic',
    key: 'c17-key',
    payload: 'instant-expire',
    ttl_seconds: 0,
  })

  const readRes = await call(tools, 'peer_read', {
    topic: 'c17-topic',
    key: 'c17-key',
  })
  assert.equal(readRes.found, false)

  await assert.rejects(
    async () => {
      await call(tools, 'peer_publish', {
        topic: 'c17-topic',
        key: 'c17-key-neg',
        payload: 'val',
        ttl_seconds: -1,
      })
    },
    (err) => {
      assert.ok(err instanceof Error)
      assert.ok(
        err.message.includes('ttl_seconds must be a number greater than or equal to 0'),
        `unexpected error message: ${err.message}`,
      )
      return true
    },
  )
})

// 18. string payload size is measured raw not escaped
await runCase('string payload size is measured raw not escaped', async () => {
  const backslashes = '\\'.repeat(100_000)
  const pubRes = await call(tools, 'peer_publish', {
    topic: 'c18-topic',
    key: 'c18-key',
    payload: backslashes,
  })
  assert.equal(pubRes.status, 'published')

  const readRes = await call(tools, 'peer_read', {
    topic: 'c18-topic',
    key: 'c18-key',
  })
  assert.equal(readRes.found, true)
  assert.equal(readRes.payload, backslashes)
  assert.equal(typeof readRes.payload, 'string')
})

// 19. json-looking string payload stays a string
await runCase('json-looking string payload stays a string', async () => {
  const topic = 'c19-topic'
  const key = 'c19-key'
  const payloadStr = '{"looks":"like json"}'

  await call(tools, 'peer_publish', {
    topic,
    key,
    payload: payloadStr,
  })

  const readRes = await call(tools, 'peer_read', { topic, key })
  assert.equal(readRes.found, true)
  assert.equal(typeof readRes.payload, 'string')
  assert.deepEqual(readRes.payload, payloadStr)

  const catalog = await call(tools, 'peer_read', { topic })
  const entry = catalog.keys.find((k) => k.key === key)
  assert.ok(entry, 'expected key in catalog')
  assert.equal(entry.type, 'string')
})

// 20. payload_json stores a parsed object
await runCase('payload_json stores a parsed object', async () => {
  const topic = 'c20-topic'
  const key = 'c20-key'
  const expectedObj = { unit: 'kg', decimals: 3 }

  const pubRes = await call(tools, 'peer_publish', {
    topic,
    key,
    payload_json: '{"unit":"kg","decimals":3}',
  })
  assert.equal(pubRes.status, 'published')

  const readRes = await call(tools, 'peer_read', { topic, key })
  assert.equal(readRes.found, true)
  assert.equal(typeof readRes.payload, 'object')
  assert.deepEqual(readRes.payload, expectedObj)

  const catalog = await call(tools, 'peer_read', { topic })
  const entry = catalog.keys.find((k) => k.key === key)
  assert.ok(entry, 'expected key in catalog')
  assert.equal(entry.type, 'object')
})

// 21. payload_json rejects invalid json
await runCase('payload_json rejects invalid json', async () => {
  await assert.rejects(
    async () => {
      await call(tools, 'peer_publish', {
        topic: 'c21-topic',
        key: 'c21-key',
        payload_json: '{not json',
      })
    },
    /not valid JSON/,
  )
})

// 22. payload and payload_json together are rejected
await runCase('payload and payload_json together are rejected', async () => {
  await assert.rejects(
    async () => {
      await call(tools, 'peer_publish', {
        topic: 'c22-topic',
        key: 'c22-key',
        payload: { unit: 'kg' },
        payload_json: '{"unit":"kg"}',
      })
    },
    /not both/,
  )
})

// 23. evicted workspace cancels its waiters with reason evicted
await runCase('evicted workspace cancels its waiters with reason evicted', async () => {
  const exec0 = { agent: { workspaceId: 'evict-0' } }
  const awaitPromise = call(
    tools,
    'peer_await',
    {
      topic: 'evict-topic',
      key: 'evict-key',
      timeout_ms: 60000,
    },
    exec0,
  )

  // Force eviction by touching MAX_WORKSPACES (64) further workspaces
  for (let i = 1; i <= 64; i++) {
    await call(
      tools,
      'peer_publish',
      {
        topic: 'dummy-topic',
        key: 'dummy-key',
        payload: i,
      },
      { agent: { workspaceId: `evict-${i}` } },
    )
  }

  const res = await awaitPromise
  assert.equal(res.status, 'cancelled')
  assert.equal(res.reason, 'evicted')
  assert.equal(res.topic, 'evict-topic')
  assert.equal(res.key, 'evict-key')
})

// 24. diagnostics reports cumulative eviction counters
await runCase('diagnostics reports cumulative eviction counters', async () => {
  const diagInit = diagnostics()
  assert.ok(diagInit.evicted, 'expected evicted in diagnostics')
  assert.equal(typeof diagInit.evicted.keys, 'number')
  assert.equal(typeof diagInit.evicted.topics, 'number')
  assert.equal(typeof diagInit.evicted.workspaces, 'number')

  const before = diagInit.evicted.keys
  const ws = 'ws-diag-evict'
  const exec = { agent: { workspaceId: ws } }
  const maxKeys = 2000
  const count = maxKeys + 5

  for (let i = 1; i <= count; i++) {
    await call(
      tools,
      'peer_publish',
      {
        topic: 'diag-topic',
        key: `k-${i}`,
        payload: `val-${i}`,
      },
      exec,
    )
  }

  const diagAfter = diagnostics(ws)
  assert.ok(
    diagAfter.evicted.keys >= before + 5,
    `expected evicted.keys >= ${before + 5}, got ${diagAfter.evicted.keys}`,
  )
})

disposeAll()

if (!failed && process.exitCode !== 1) {
  console.log('SMOKE OK (24 cases)')
}
