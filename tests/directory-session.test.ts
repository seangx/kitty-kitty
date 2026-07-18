import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDirectoryPickResult,
  createDirectoryStartAction,
} from '../src/shared/directory-session.ts'

test('an empty non-git directory still opens the tool picker', () => {
  assert.deepEqual(createDirectoryPickResult('/tmp/empty', [], false), {
    type: 'pick',
    dir: '/tmp/empty',
    sessions: [],
    isGitRepo: false,
  })
})

test('new and continue actions use the tool selected in the directory picker', () => {
  assert.deepEqual(createDirectoryStartAction('new', 'opencode'), {
    type: 'new',
    tool: 'opencode',
  })
  assert.deepEqual(createDirectoryStartAction('continue-latest', 'codex'), {
    type: 'continue-latest',
    tool: 'codex',
  })
})
