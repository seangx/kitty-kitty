import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOpenCodeSessions } from '../src/main/sessions/opencode-provider.ts'

test('parses OpenCode history and rejects descendant or sibling project sessions', () => {
  const rows = parseOpenCodeSessions(JSON.stringify([
    { id: 'ses_exact', title: 'Exact project', updated: 1_800_000_000_000, directory: '/repo' },
    { id: 'ses_child', title: 'Child project', updated: 1_900_000_000_000, directory: '/repo/child' },
    { id: 'ses_other', title: 'Other project', updated: 1_700_000_000_000, directory: '/other' },
  ]), '/repo')

  assert.deepEqual(rows.map((row) => row.id), ['ses_exact'])
  assert.equal(rows[0].summary, 'Exact project')
  assert.equal(rows[0].date, new Date(1_800_000_000_000).toISOString())
})

test('sorts exact-project OpenCode sessions newest first with safe fallback titles', () => {
  const rows = parseOpenCodeSessions(JSON.stringify([
    { id: 'ses_old', title: '', created: 1_700_000_000_000, directory: '/repo' },
    { id: 'ses_new', title: 'Newest', updated: 1_800_000_000_000, directory: '/repo' },
  ]), '/repo')

  assert.deepEqual(rows.map((row) => row.id), ['ses_new', 'ses_old'])
  assert.equal(rows[1].summary, 'OpenCode session')
})
