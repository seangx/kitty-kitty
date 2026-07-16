import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedTaskQueue, runSerializedWithDedupe } from '../src/main/keyed-task-queue.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('serializes injections for the same session', async () => {
  const queue = new KeyedTaskQueue()
  const gate = deferred()
  const started = deferred()
  const events: string[] = []

  const first = queue.run('session-a', async () => {
    events.push('first:start')
    started.resolve()
    await gate.promise
    events.push('first:end')
  })
  const second = queue.run('session-a', async () => {
    events.push('second:start')
  })

  await started.promise
  assert.deepEqual(events, ['first:start'])
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start'])
})

test('re-checks dedupe state when a queued injection reaches the head', async () => {
  const queue = new KeyedTaskQueue()
  const gate = deferred()
  let markerPresent = false
  let injected = false

  const first = queue.run('session-a', async () => {
    await gate.promise
    markerPresent = true
  })
  const second = runSerializedWithDedupe(
    queue,
    'session-a',
    () => markerPresent,
    async () => { injected = true },
  )

  gate.resolve()
  await first
  const result = await second
  assert.deepEqual(result, { kind: 'already-present' })
  assert.equal(injected, false)
})

test('allows different sessions to inject concurrently', async () => {
  const queue = new KeyedTaskQueue()
  const gate = deferred()
  let secondStarted = false

  const first = queue.run('session-a', async () => { await gate.promise })
  const second = queue.run('session-b', async () => { secondStarted = true })

  await second
  assert.equal(secondStarted, true)
  gate.resolve()
  await first
})
