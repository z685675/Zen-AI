// Run only through libsql-lifecycle-smoke.js, in an isolated Electron process.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const v8 = require('node:v8')
const vm = require('node:vm')
const { setImmediate: yieldTurn } = require('node:timers/promises')
const { app } = require('electron')
const { createClient } = require('@libsql/client')
const { drizzle } = require('drizzle-orm/libsql')
const { sql } = require('drizzle-orm')
const { integer, sqliteTable, text } = require('drizzle-orm/sqlite-core')

const profile = process.env.ZEN_LIBSQL_TEST_PROFILE
const iterations = Number(process.env.ZEN_LIBSQL_TEST_ITERATIONS)
const mode = process.env.ZEN_LIBSQL_TEST_MODE
if (!profile || !fs.existsSync(profile) || !Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error('An isolated lifecycle test profile and iteration count are required')
}
app.setPath('userData', profile)
app.setName('Zen AI database stability test')
v8.setFlagsFromString('--expose_gc')
const gc = vm.runInNewContext('gc')
const databasePath = path.join(profile, 'fixture.db')
const url = `file:${databasePath}`
const fixture = sqliteTable('fixture', {
  id: integer().primaryKey(),
  counter: integer().notNull(),
  body: text().notNull()
})

async function collect() {
  // V8's weak callbacks, FinalizationRegistry and Neon native finalizers run
  // at different points. Give each layer a turn, including the final guard.
  for (let i = 0; i < 4; i++) {
    gc()
    await yieldTurn()
  }
}

async function testTransactions() {
  const client = createClient({ url })
  const db = drizzle(client)
  await client.executeMultiple(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE fixture (id INTEGER PRIMARY KEY, counter INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE bindings (value BLOB, label TEXT, large INTEGER);
    INSERT INTO fixture VALUES (1, 0, 'initial');
  `)
  const body = '中文事务数据'.repeat(1600)
  const rollback = new Error('intentional fixture rollback')
  let commits = 0
  for (let i = 0; i < iterations; i++) {
    try {
      await db.transaction(async (tx) => {
        await tx.update(fixture).set({ counter: sql`${fixture.counter} + 1`, body })
        const [row] = await tx.select().from(fixture)
        assert.equal(row.counter, commits + 1)
        assert.equal(row.body, body)
        if (i % 3 === 0) throw rollback
      })
      commits++
    } catch (error) {
      if (error !== rollback) throw error
    }
    if (i % 50 === 0) await collect()
    if (i % 1000 === 0) process.stdout.write(`transactions ${i}/${iterations}\n`)
  }
  assert.equal((await db.select().from(fixture))[0].counter, commits)
  await client.execute({
    sql: 'INSERT INTO bindings VALUES (:blob, :label, :large)',
    args: { blob: new Uint8Array([0, 127, 255]), label: '中文参数', large: 1234567890123n }
  })
  const binding = (await client.execute('SELECT * FROM bindings')).rows[0]
  assert.equal(binding.label, '中文参数')
  assert.equal(binding.large, 1234567890123)
  assert.deepEqual(Array.from(new Uint8Array(binding.value)), [0, 127, 255])
  const vector = await client.execute(
    "SELECT vector_distance_cos(vector32('[1,0,0]'), vector32('[1,0,0]')) AS distance"
  )
  assert.equal(vector.rows[0].distance, 0)
  await assert.rejects(client.execute('SELECT * FROM missing_fixture_table'))
  assert.equal((await client.execute('SELECT counter FROM fixture')).rows[0].counter, commits)
  client.close()
  client.close()
  await assert.rejects(client.execute('SELECT 1'), /closed/i)
  await collect()
  const reopened = createClient({ url })
  assert.equal((await reopened.execute('SELECT counter FROM fixture')).rows[0].counter, commits)
  assert.equal((await reopened.execute('PRAGMA integrity_check')).rows[0].integrity_check, 'ok')
  reopened.close()
  await collect()
  // On Windows this fails if abandoned native transaction handles still own
  // the database. The fixture never opens an existing application database.
  const moved = path.join(profile, 'released.db')
  fs.renameSync(databasePath, moved)
  fs.renameSync(moved, databasePath)
  return { iterations, commits, rolledBack: iterations - commits, bindings: true, vectors: true, released: true }
}

async function testClose() {
  const { createRequire } = require('node:module')
  const clientRequire = createRequire(require.resolve('@libsql/client'))
  const Database = clientRequire('libsql')
  for (let i = 0; i < 150; i++) {
    const db = new Database(databasePath)
    db.exec('CREATE TABLE IF NOT EXISTS fixture (value TEXT)')
    db.prepare('INSERT INTO fixture VALUES (?)').run('关闭与重新打开')
    await collect()
    db.close()
    db.close()
    assert.equal(db.open, false)
    await collect()
  }
  const moved = path.join(profile, 'released.db')
  fs.renameSync(databasePath, moved)
  return { openedAndClosed: 150, idempotentClose: true, released: true }
}

async function testShutdown() {
  // Deliberately leave live and abandoned connections to the real process
  // exit hook. The parent also checks Electron's *actual* native exit code.
  const clients = []
  for (let i = 0; i < 24; i++) {
    const client = createClient({ url: `file:${path.join(profile, `shutdown-${i}.db`)}` })
    await client.execute('CREATE TABLE fixture (value INTEGER)')
    const tx = await client.transaction()
    await tx.execute('INSERT INTO fixture VALUES (1)')
    await tx.commit()
    clients.push(client)
  }
  global.fixtureClients = clients
  return { liveClientsAtShutdown: clients.length }
}

app
  .whenReady()
  .then(async () => {
    let result
    if (mode === 'transactions') result = await testTransactions()
    else if (mode === 'close') result = await testClose()
    else if (mode === 'shutdown') result = await testShutdown()
    else throw new Error(`Unknown lifecycle test mode: ${mode}`)
    process.stdout.write(
      `ZEN_LIBSQL_RESULT ${JSON.stringify({ mode, electron: process.versions.electron, ...result })}\n`
    )
    app.quit()
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    app.exit(1)
  })
