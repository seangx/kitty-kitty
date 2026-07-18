import { execFile } from 'child_process'

export interface CliResult {
  success: boolean
  stdout: string
  stderr: string
  errorMessage?: string
}

interface RunCliOptions {
  cwd?: string
  timeoutMs?: number
  input?: string
}

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g

export function cleanCliOutput(value: string): string {
  return value
    .replace(ANSI_ESCAPE, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

export function cliFailureMessage(result: CliResult, fallback: string): string {
  const stderr = cleanCliOutput(result.stderr)
  if (stderr) return stderr
  const stdout = cleanCliOutput(result.stdout)
  if (stdout) return stdout
  const error = cleanCliOutput(result.errorMessage || '')
  return error || fallback
}

export function findRequiredEnvPrompts(output: string): string[] {
  const clean = cleanCliOutput(output)
  const names = new Set<string>()
  const pattern = /Enter value for ([A-Za-z_][A-Za-z0-9_]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(clean)) !== null) names.add(match[1])
  return [...names]
}

export function findReportedDeployments(output: string): string[] {
  const clean = cleanCliOutput(output)
  const names = new Set<string>()
  const pattern = /^\s*\+\s+(.+?)\s+->\s+(?:Claude Code|Codex|OpenCode)\s*$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(clean)) !== null) names.add(match[1])
  return [...names]
}

export function findSavedServers(output: string): string[] {
  const clean = cleanCliOutput(output)
  const names = new Set<string>()
  const pattern = /Server "([^"]+)" (?:saved|installed) to central repository\./g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(clean)) !== null) names.add(match[1])
  return [...names]
}

/**
 * Run a CLI with an optional stdin response. `execFile` normally leaves stdin
 * open, which makes prompt-based CLIs hang until timeout in Electron. Always
 * closing stdin makes headless behavior deterministic; callers may supply the
 * explicit answer for a prompt they have already authorized in the UI.
 */
export function runCli(
  bin: string,
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, {
      cwd: options.cwd,
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 60_000,
    }, (error, stdout, stderr) => {
      resolve({
        success: error === null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        errorMessage: error?.message,
      })
    })

    // A child may exit before stdin is written (for example, an invalid CLI
    // option). Ignore EPIPE because the callback above owns the result.
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
  })
}
