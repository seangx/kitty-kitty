import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import test from 'node:test'
import {
  generateCodexRemoteScript,
  generateLaunchScript,
  injectOpenCodeMemory,
} from '../src/main/tmux/cli-wrapper.ts'

function readGenerated(path: string): string {
  try {
    execFileSync('/bin/bash', ['-n', path])
    return readFileSync(path, 'utf-8')
  } finally {
    unlinkSync(path)
  }
}

test('passes handoff as the initial prompt when resuming Claude', () => {
  const script = readGenerated(generateLaunchScript(
    'claude',
    'resume',
    'claude-session-id',
    undefined,
    undefined,
    undefined,
    '请读 /tmp/codex-handoff.md —— 读完接手。',
  ))

  assert.match(script, /--resume "claude-session-id"/)
  assert.ok(script.includes(`'请读 /tmp/codex-handoff.md —— 读完接手。'`))
})

test('passes handoff as the initial prompt to a bare Codex resume', () => {
  const script = readGenerated(generateLaunchScript(
    'codex',
    'resume',
    'codex-thread-id',
    undefined,
    undefined,
    undefined,
    "read /tmp/it's-handoff.md\nthen continue",
  ))

  assert.ok(script.includes(`resume "codex-thread-id"`))
  assert.ok(script.includes(`'read /tmp/it'\\''s-handoff.md\nthen continue'`))
})

test('passes handoff as the initial prompt to a fresh bare Codex session', () => {
  const script = readGenerated(generateLaunchScript(
    'codex',
    'new',
    undefined,
    undefined,
    undefined,
    undefined,
    '请读 /tmp/large-session-handoff.md',
  ))

  assert.ok(script.includes(`'请读 /tmp/large-session-handoff.md'`))
})

test('passes handoff through the Codex CLI when attaching to a remote thread', () => {
  const script = readGenerated(generateCodexRemoteScript(
    'ws://127.0.0.1:41234',
    'codex-thread-id',
    undefined,
    undefined,
    '请读 /tmp/handoff.md',
  ))

  assert.match(script, /codex resume 'codex-thread-id' --remote 'ws:\/\/127\.0\.0\.1:41234' '请读 \/tmp\/handoff\.md'/)
})

test('passes OpenCode initial messages through --prompt instead of TUI input', () => {
  const script = readGenerated(generateLaunchScript(
    'opencode',
    'new',
    undefined,
    undefined,
    undefined,
    undefined,
    "先检查 rules，再继续 it's ready",
  ))

  assert.ok(script.includes(`opencode --prompt '先检查 rules，再继续 it'\\''s ready'`))
})

test('resumes an exact OpenCode session and injects its project memory path', () => {
  const path = generateLaunchScript(
    'opencode',
    'resume',
    'ses_opencode_123',
    '/tmp/project',
    undefined,
    '--agent build',
    '继续处理',
  )
  injectOpenCodeMemory(path, "/tmp/project's-memory/MEMORY.md")
  const script = readGenerated(path)

  assert.ok(script.includes(`cd '/tmp/project'`))
  assert.ok(script.includes(`opencode --agent build --session "ses_opencode_123" --prompt '继续处理'`))
  assert.ok(script.includes(`export KITTY_CLAUDE_MEMORY_FILE='/tmp/project'\\''s-memory/MEMORY.md'`))
})
