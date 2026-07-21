import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedSingleFlight } from '../src/main/keyed-single-flight.ts'

test('same-key operations are coalesced and the key is released afterwards', async () => {
  const singleFlight = new KeyedSingleFlight()
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })

  const first = singleFlight.run('session-1', async () => {
    calls += 1
    await gate
    return 'done'
  })
  const second = singleFlight.run('session-1', async () => {
    calls += 1
    return 'duplicate'
  })

  assert.strictEqual(second, first)
  assert.equal(singleFlight.has('session-1'), true)
  release?.()
  assert.deepEqual(await Promise.all([first, second]), ['done', 'done'])
  assert.equal(calls, 1)
  assert.equal(singleFlight.has('session-1'), false)

  assert.equal(await singleFlight.run('session-1', async () => {
    calls += 1
    return 'next'
  }), 'next')
  assert.equal(calls, 2)
})

test('failed operations also release their key', async () => {
  const singleFlight = new KeyedSingleFlight()
  await assert.rejects(
    singleFlight.run('session-1', async () => { throw new Error('boom') }),
    /boom/,
  )
  assert.equal(singleFlight.has('session-1'), false)
})
