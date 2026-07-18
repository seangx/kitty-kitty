import { spawn } from 'child_process'

const HIVE_BIN = 'kitty-hive'

export function runHive(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(HIVE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, opts.timeoutMs)
      : null
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
  })
}
