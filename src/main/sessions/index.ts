import { claudeProvider } from './claude-provider'
import { codexProvider } from './codex-provider'
import { opencodeProvider } from './opencode-provider'
import type { ExternalSessionProvider } from './external-session'

export type { ExternalSessionEntry, ExternalSessionProvider } from './external-session'

const PROVIDERS: Record<string, ExternalSessionProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
  opencode: opencodeProvider,
}

/**
 * Returns a session provider for the given tool, or `null` if the tool doesn't
 * persist sessions on disk in a way kitty knows how to consume (e.g. `shell`).
 */
export function getProvider(tool: string): ExternalSessionProvider | null {
  return PROVIDERS[tool] ?? null
}
