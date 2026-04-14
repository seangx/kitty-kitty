/**
 * Kitty Kitty Session MCP Server Script
 *
 * This file is NOT bundled with the Electron app. It's written to disk as a
 * standalone Node.js script that Claude Code launches via stdio.
 *
 * Provides session orchestration tools:
 *   - create_pane     (all sessions)   — split tmux pane + launch agent
 *   - list_panes      (all sessions)   — list tmux panes
 *   - close_pane      (all sessions)   — close a tmux pane, optionally cleanup worktree
 *   - create_worktree (git repo only)  — git worktree add + symlinks + .mcp.json
 *
 * Environment variables (set by kitty-kitty when injecting):
 *   KITTY_AGENT_ID      - this agent's session id
 *   KITTY_TMUX_NAME     - tmux session name (e.g., "kitty_abc123")
 *   KITTY_PROJECT_ROOT  - project root path
 *   KITTY_IS_GIT_REPO   - "1" if project is a git repo
 */

export const SESSION_MCP_SERVER_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const AGENT_ID = process.env.KITTY_AGENT_ID || 'unknown';
const TMUX_NAME = process.env.KITTY_TMUX_NAME || '';
const TMUX_BIN = process.env.KITTY_TMUX_BIN || 'tmux';
const PROJECT_ROOT = process.env.KITTY_PROJECT_ROOT || '';
const IS_GIT_REPO = process.env.KITTY_IS_GIT_REPO === '1';

// Shell-safe quoting: wraps in single quotes, escapes embedded single quotes
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\\\''") + "'";
}

// --- MCP Protocol ---

let outputMode = 'framed'; // 'framed' | 'raw_blank' | 'raw_line'

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  writeProtocolMessage(msg);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  writeProtocolMessage(msg);
}

function writeProtocolMessage(msg) {
  if (outputMode === 'raw_line') {
    process.stdout.write(msg + '\\n');
    return;
  }
  if (outputMode === 'raw_blank') {
    process.stdout.write(msg + '\\n\\n');
    return;
  }
  process.stdout.write('Content-Length: ' + Buffer.byteLength(msg) + '\\r\\n\\r\\n' + msg);
}

// --- Tools ---

const COMMON_TOOLS = [
  {
    name: 'create_pane',
    description: 'Open a new tmux pane in this session and launch an AI agent or shell. Use for parallel sub-tasks, pair programming, or running commands in a separate pane.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'AI tool: claude, codex, or shell', default: 'claude' },
        cwd: { type: 'string', description: 'Working directory for the new pane (default: current project root)' },
        message: { type: 'string', description: 'Initial message/task to send to the new agent' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_panes',
    description: 'List all panes in this tmux session with their working directories.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'close_pane',
    description: 'Close a tmux pane. Optionally remove the associated git worktree and delete the branch if applicable.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Tmux pane ID to close (from list_panes)' },
        branch: { type: 'string', description: 'Branch name — used to find worktree pane if pane_id not provided' },
        cleanup: { type: 'boolean', description: 'Also remove git worktree and delete merged branch', default: false }
      },
      additionalProperties: false
    }
  }
];

const GIT_TOOLS = [
  {
    name: 'create_worktree',
    description: 'Create a git worktree for a branch. Returns the worktree path. Use with create_pane to delegate a sub-task to a separate branch: first create_worktree to get the path, then create_pane with that path as cwd.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name (e.g. feat/user-auth)' },
        base_branch: { type: 'string', description: 'Base branch (default: auto-detect main/master)', default: '' }
      },
      required: ['branch'],
      additionalProperties: false
    }
  },
  {
    name: 'fork_session',
    description: 'Fork the current session into a new git worktree branch. Creates a worktree, splits a tmux pane, and launches claude with --fork-session to continue the conversation context in the new branch. One-step shortcut for create_worktree + create_pane.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name for the worktree (e.g. feat/user-auth)' },
        base_branch: { type: 'string', description: 'Base branch (default: auto-detect main/master)', default: '' },
        message: { type: 'string', description: 'Optional initial message to prepend after forking' }
      },
      required: ['branch'],
      additionalProperties: false
    }
  }
];

const TOOLS = IS_GIT_REPO ? [...COMMON_TOOLS, ...GIT_TOOLS] : COMMON_TOOLS;

// --- Tool handlers ---

function handleCreatePane(args) {
  try {
    if (!TMUX_NAME) {
      return { content: [{ type: 'text', text: 'KITTY_TMUX_NAME is not set.' }], isError: true };
    }

    const ALLOWED_TOOLS = ['claude', 'codex', 'shell'];
    const rawTool = String(args.tool || 'claude').trim() || 'claude';
    if (!ALLOWED_TOOLS.includes(rawTool)) {
      return { content: [{ type: 'text', text: 'Invalid tool "' + rawTool + '". Allowed: ' + ALLOWED_TOOLS.join(', ') }], isError: true };
    }
    const tool = rawTool;
    const cwd = String(args.cwd || PROJECT_ROOT || '').trim();
    const message = String(args.message || '').trim();

    if (!cwd) {
      return { content: [{ type: 'text', text: 'No working directory. Provide cwd or set KITTY_PROJECT_ROOT.' }], isError: true };
    }

    // Determine pane layout
    let paneCount = 1;
    try {
      paneCount = execSync(
        TMUX_BIN + ' list-panes -t ' + shellQuote(TMUX_NAME) + ' -F "#{pane_id}"',
        { stdio: 'pipe' }
      ).toString().trim().split('\\n').length;
    } catch {}
    const splitFlag = paneCount <= 1 ? '-h -p 65' : '-v';
    let splitTarget = shellQuote(TMUX_NAME);
    if (paneCount > 1) {
      try {
        const panes = execSync(
          TMUX_BIN + ' list-panes -t ' + shellQuote(TMUX_NAME) + ' -F "#{pane_id}"',
          { stdio: 'pipe' }
        ).toString().trim().split('\\n');
        splitTarget = shellQuote(panes[panes.length - 1]);
      } catch {}
    }

    // Split pane (opens shell), then query coordinate and send tool command
    const paneIdRaw = execSync(
      TMUX_BIN + ' split-window -t ' + splitTarget + ' ' + splitFlag + ' -c ' + shellQuote(cwd) + ' -P -F "#{pane_id}"',
      { stdio: 'pipe' }
    ).toString().trim();

    // Get window.pane coordinate for agent identity
    let paneCoord = '0.0';
    try {
      paneCoord = execSync(
        TMUX_BIN + ' display-message -t ' + shellQuote(paneIdRaw) + ' -p "#{window_index}.#{pane_index}"',
        { stdio: 'pipe' }
      ).toString().trim();
    } catch {}

    if (tool !== 'shell') {
      // Build command with pane agent identity + tool + optional message
      const paneAgentId = AGENT_ID + '-pane-' + paneCoord;
      const paneAgentName = tool + '-pane-' + paneCoord;
      let toolCmd = tool;
      if (message) toolCmd = tool + ' ' + shellQuote(message);
      const fullCmd = 'KITTY_PANE_AGENT_ID=' + shellQuote(paneAgentId) + ' KITTY_PANE_AGENT_NAME=' + shellQuote(paneAgentName) + ' KITTY_PANE_PARENT_ID=' + shellQuote(AGENT_ID) + ' ' + toolCmd;
      execSync(TMUX_BIN + ' send-keys -t ' + shellQuote(paneIdRaw) + ' ' + shellQuote(fullCmd) + ' Enter', { stdio: 'pipe' });
    } else if (message) {
      // Shell tool with message: use load-buffer to avoid shell expansion
      setTimeout(() => {
        try {
          execSync(TMUX_BIN + ' load-buffer -', { input: message, stdio: ['pipe', 'ignore', 'ignore'] });
          execSync(TMUX_BIN + ' paste-buffer -t ' + shellQuote(paneIdRaw), { stdio: 'pipe' });
          execSync(TMUX_BIN + ' send-keys -t ' + shellQuote(paneIdRaw) + ' Enter', { stdio: 'pipe' });
        } catch {}
      }, 500);
    }

    return {
      content: [{
        type: 'text',
        text: 'Pane created.\\npaneId: ' + paneIdRaw + '\\ncwd: ' + cwd + '\\ntool: ' + tool
      }]
    };
  } catch (e) {
    return { content: [{ type: 'text', text: 'create_pane failed: ' + (e && e.message ? e.message : String(e)) }], isError: true };
  }
}

function handleCreateWorktree(args) {
  try {
    if (!PROJECT_ROOT) {
      return { content: [{ type: 'text', text: 'KITTY_PROJECT_ROOT is not set.' }], isError: true };
    }

    const rawBranch = String(args.branch || '').trim();
    if (!rawBranch) {
      return { content: [{ type: 'text', text: 'branch is required.' }], isError: true };
    }

    // 1. Sanitize branch name
    const branch = rawBranch.replace(/[^a-zA-Z0-9\\/_.-]/g, '-');

    // 2. Build worktree path
    const worktreesDir = path.join(PROJECT_ROOT, '.worktrees');
    const worktreePath = path.join(worktreesDir, branch.replace(/\\//g, '-'));

    // 3. git worktree add
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    if (!fs.existsSync(worktreePath)) {
      let branchExists = false;
      try {
        execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' rev-parse --verify ' + shellQuote(branch), { stdio: 'pipe' });
        branchExists = true;
      } catch {}

      const baseBranch = String(args.base_branch || '').trim();
      let base = baseBranch;
      if (!base) {
        try {
          execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' rev-parse --verify main', { stdio: 'pipe' });
          base = 'main';
        } catch {
          try {
            execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' rev-parse --verify master', { stdio: 'pipe' });
            base = 'master';
          } catch {
            base = '';
          }
        }
      }

      if (branchExists) {
        execSync(
          'git -C ' + shellQuote(PROJECT_ROOT) + ' worktree add ' + shellQuote(worktreePath) + ' ' + shellQuote(branch),
          { stdio: 'pipe' }
        );
      } else {
        const newBranchCmd = base
          ? 'git -C ' + shellQuote(PROJECT_ROOT) + ' worktree add -b ' + shellQuote(branch) + ' ' + shellQuote(worktreePath) + ' ' + shellQuote(base)
          : 'git -C ' + shellQuote(PROJECT_ROOT) + ' worktree add -b ' + shellQuote(branch) + ' ' + shellQuote(worktreePath);
        execSync(newBranchCmd, { stdio: 'pipe' });
      }
    }

    // 4. Ensure .worktrees in .gitignore
    const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
    const gitignoreEntry = '.worktrees/';
    try {
      let gitignoreContent = '';
      if (fs.existsSync(gitignorePath)) {
        gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      }
      if (!gitignoreContent.split('\\n').some(line => line.trim() === gitignoreEntry || line.trim() === '.worktrees')) {
        fs.appendFileSync(gitignorePath, '\\n' + gitignoreEntry + '\\n');
      }
    } catch {}

    // 5. Symlink Claude project dir
    try {
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
            const encodeProjectPath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
      const mainProjectKey = encodeProjectPath(PROJECT_ROOT);
      const worktreeProjectKey = encodeProjectPath(worktreePath);
      const mainClaudeDir = path.join(claudeProjectsDir, mainProjectKey);
      const worktreeClaudeDir = path.join(claudeProjectsDir, worktreeProjectKey);

      if (fs.existsSync(mainClaudeDir) && !fs.existsSync(worktreeClaudeDir)) {
        if (!fs.existsSync(claudeProjectsDir)) {
          fs.mkdirSync(claudeProjectsDir, { recursive: true });
        }
        fs.symlinkSync(mainClaudeDir, worktreeClaudeDir);
      }
    } catch {}

    // 6. Symlink openspec dir
    try {
      const openspecSrc = path.join(PROJECT_ROOT, 'openspec');
      const openspecDst = path.join(worktreePath, 'openspec');
      if (fs.existsSync(openspecSrc) && !fs.existsSync(openspecDst)) {
        fs.symlinkSync(openspecSrc, openspecDst);
      }
    } catch {}

    // 7. Write .mcp.json for worktree agent
    try {
      const wtAgentId = AGENT_ID + '-' + branch.replace(/\\//g, '-');
      const mainMcpPath = path.join(PROJECT_ROOT, '.mcp.json');
      let mcpConfig = {};
      try { mcpConfig = JSON.parse(fs.readFileSync(mainMcpPath, 'utf-8')); } catch {}
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

      if (mcpConfig.mcpServers['kitty-session']) {
        mcpConfig.mcpServers['kitty-session'] = JSON.parse(JSON.stringify(mcpConfig.mcpServers['kitty-session']));
        mcpConfig.mcpServers['kitty-session'].env = mcpConfig.mcpServers['kitty-session'].env || {};
        mcpConfig.mcpServers['kitty-session'].env.KITTY_AGENT_ID = wtAgentId;
        mcpConfig.mcpServers['kitty-session'].env.KITTY_PROJECT_ROOT = worktreePath;
      }

      if (mcpConfig.mcpServers['kitty-talk']) {
        mcpConfig.mcpServers['kitty-talk'] = JSON.parse(JSON.stringify(mcpConfig.mcpServers['kitty-talk']));
        mcpConfig.mcpServers['kitty-talk'].env = mcpConfig.mcpServers['kitty-talk'].env || {};
        mcpConfig.mcpServers['kitty-talk'].env.KITTY_AGENT_ID = wtAgentId;
        mcpConfig.mcpServers['kitty-talk'].env.KITTY_AGENT_NAME = branch;
        mcpConfig.mcpServers['kitty-talk'].env.KITTY_CWD = worktreePath;
      }

      fs.writeFileSync(path.join(worktreePath, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
    } catch {}

    return {
      content: [{
        type: 'text',
        text: 'Worktree created.\\nbranch: ' + branch + '\\npath: ' + worktreePath + '\\n\\nUse create_pane with cwd=' + JSON.stringify(worktreePath) + ' to open a pane in this worktree.'
      }]
    };
  } catch (e) {
    return { content: [{ type: 'text', text: 'create_worktree failed: ' + (e && e.message ? e.message : String(e)) }], isError: true };
  }
}

function handleListPanes() {
  try {
    if (!TMUX_NAME) {
      return { content: [{ type: 'text', text: 'KITTY_TMUX_NAME is not set.' }], isError: true };
    }
    const output = execSync(
      TMUX_BIN + ' list-panes -t ' + shellQuote(TMUX_NAME) + ' -F "#{pane_id}:#{pane_current_path}:#{pane_current_command}"',
      { stdio: 'pipe' }
    ).toString().trim();
    if (!output) {
      return { content: [{ type: 'text', text: 'No panes found.' }] };
    }
    const lines = output.split('\\n').map(line => {
      const parts = line.split(':');
      const paneId = parts[0] || '';
      const cmd = parts[parts.length - 1] || '';
      const cwd = parts.slice(1, parts.length - 1).join(':') || '';
      return paneId + '  ' + cwd + '  [' + cmd + ']';
    });
    return { content: [{ type: 'text', text: lines.join('\\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'list_panes failed: ' + (e && e.message ? e.message : String(e)) }], isError: true };
  }
}

function handleClosePane(args) {
  try {
    const targetPaneId = String(args.pane_id || '').trim();
    const targetBranch = String(args.branch || '').trim();
    const cleanup = Boolean(args.cleanup);

    let paneToKill = targetPaneId;
    let worktreePath = '';

    if (!paneToKill && targetBranch && TMUX_NAME) {
      const branchDir = targetBranch.replace(/\\//g, '-');
      const output = execSync(
        TMUX_BIN + ' list-panes -t ' + shellQuote(TMUX_NAME) + ' -F "#{pane_id}:#{pane_current_path}"',
        { stdio: 'pipe' }
      ).toString().trim();
      for (const line of output.split('\\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const pid = line.slice(0, idx);
        const cwd = line.slice(idx + 1);
        if (cwd.includes('.worktrees/' + branchDir) || cwd.includes('.worktrees/' + targetBranch)) {
          paneToKill = pid;
          worktreePath = cwd;
          break;
        }
      }
    }

    if (!paneToKill) {
      return { content: [{ type: 'text', text: 'Could not find pane. Provide pane_id or branch.' }], isError: true };
    }

    let paneKilled = false;
    try {
      execSync(TMUX_BIN + ' kill-pane -t ' + shellQuote(paneToKill), { stdio: 'pipe' });
      paneKilled = true;
    } catch (killErr) {
      // Pane may already be dead — continue with cleanup
    }

    // Unregister any agent bound to this pane from agents.json
    try {
      const BUS_DIR = process.env.KITTY_BUS_DIR || path.join(os.tmpdir(), 'kitty-bus');
      const agentsFile = path.join(BUS_DIR, 'agents.json');
      const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));
      for (const [id, v] of Object.entries(agents)) {
        if (v && v.tmuxPane === paneToKill) {
          delete agents[id];
        }
      }
      fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    } catch {}

    let worktreeCleaned = false;
    if (cleanup && PROJECT_ROOT) {
      // If we only have pane_id, try to resolve worktree path from pane's cwd
      if (!worktreePath && !targetBranch && paneToKill) {
        try {
          const output = execSync(
            TMUX_BIN + ' display-message -t ' + shellQuote(paneToKill) + ' -p "#{pane_current_path}"',
            { stdio: 'pipe' }
          ).toString().trim();
          if (output.includes('.worktrees/')) worktreePath = output;
        } catch {}
      }
      if (!worktreePath && targetBranch) {
        worktreePath = path.join(PROJECT_ROOT, '.worktrees', targetBranch.replace(/\\//g, '-'));
      }
      if (worktreePath && fs.existsSync(worktreePath)) {
        // Clean up Claude project dir for this worktree — try both encoding
        // variants so legacy ('.'→'-') and current ('.' preserved) both get wiped.
        try {
          const homeDir = os.homedir();
          const encNew = worktreePath.replace(/[\\\\/]/g, '-');
          const encOld = worktreePath.replace(/[\\\\/\\.]/g, '-');
          const keys = Array.from(new Set([encNew, encOld]));
          const rmSync = fs.rmSync || fs.rmdirSync;
          for (const key of keys) {
            const wtProjDir = path.join(homeDir, '.claude', 'projects', key);
            if (fs.existsSync(wtProjDir)) {
              try { rmSync(wtProjDir, { recursive: true, force: true }); } catch {}
            }
          }
        } catch {}
        try { fs.unlinkSync(path.join(worktreePath, '.mcp.json')); } catch {}
        try {
          execSync('git worktree remove ' + shellQuote(worktreePath) + ' --force', { stdio: 'pipe' });
          worktreeCleaned = true;
        } catch {}
        if (targetBranch) {
          try {
            execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' branch -d ' + shellQuote(targetBranch), { stdio: 'pipe' });
          } catch {}
        }
      }
    }

    const parts = [];
    parts.push(paneKilled ? 'Pane ' + paneToKill + ' closed.' : 'Pane ' + paneToKill + ' not found (may be already dead).');
    if (cleanup) {
      parts.push(worktreeCleaned ? 'Worktree cleaned up.' : 'Worktree cleanup skipped (not found or failed).');
    }
    return { content: [{ type: 'text', text: parts.join(' ') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'close_pane failed: ' + (e && e.message ? e.message : String(e)) }], isError: true };
  }
}

function handleForkSession(args) {
  try {
    if (!TMUX_NAME) {
      return { content: [{ type: 'text', text: 'KITTY_TMUX_NAME is not set.' }], isError: true };
    }
    if (!PROJECT_ROOT) {
      return { content: [{ type: 'text', text: 'KITTY_PROJECT_ROOT is not set.' }], isError: true };
    }
    if (!IS_GIT_REPO) {
      return { content: [{ type: 'text', text: 'Not a git repo. fork_session requires git.' }], isError: true };
    }

    // Step 1: Create worktree (reuse handleCreateWorktree logic inline)
    const rawBranch = String(args.branch || '').trim();
    if (!rawBranch) {
      return { content: [{ type: 'text', text: 'branch is required.' }], isError: true };
    }
    const branch = rawBranch.replace(/[^a-zA-Z0-9\\/_.-]/g, '-');
    const worktreesDir = path.join(PROJECT_ROOT, '.worktrees');
    const worktreePath = path.join(worktreesDir, branch.replace(/\\//g, '-'));

    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    if (!fs.existsSync(worktreePath)) {
      let branchExists = false;
      try {
        execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' rev-parse --verify ' + shellQuote(branch), { stdio: 'pipe' });
        branchExists = true;
      } catch {}

      const baseBranch = String(args.base_branch || '').trim();
      let base = baseBranch;
      if (!base) {
        try {
          execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' rev-parse --verify main', { stdio: 'pipe' });
          base = 'main';
        } catch {
          try {
            execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' rev-parse --verify master', { stdio: 'pipe' });
            base = 'master';
          } catch { base = ''; }
        }
      }

      if (branchExists) {
        execSync('git -C ' + shellQuote(PROJECT_ROOT) + ' worktree add ' + shellQuote(worktreePath) + ' ' + shellQuote(branch), { stdio: 'pipe' });
      } else {
        const cmd = base
          ? 'git -C ' + shellQuote(PROJECT_ROOT) + ' worktree add -b ' + shellQuote(branch) + ' ' + shellQuote(worktreePath) + ' ' + shellQuote(base)
          : 'git -C ' + shellQuote(PROJECT_ROOT) + ' worktree add -b ' + shellQuote(branch) + ' ' + shellQuote(worktreePath);
        execSync(cmd, { stdio: 'pipe' });
      }
    }

    // Ensure .worktrees in .gitignore
    const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
    try {
      let content = '';
      if (fs.existsSync(gitignorePath)) content = fs.readFileSync(gitignorePath, 'utf-8');
      if (!content.split('\\n').some(line => line.trim() === '.worktrees/' || line.trim() === '.worktrees')) {
        fs.appendFileSync(gitignorePath, '\\n.worktrees/\\n');
      }
    } catch {}

    // Find latest session and copy to worktree project dir
    const homeDir = os.homedir();
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
    // Claude Code 2.1+: encode '/' → '-', preserve '.'
    const encodeProjectPath = (p) => p.replace(/[\\\\/]/g, '-');
    const mainClaudeDir = path.join(claudeProjectsDir, encodeProjectPath(PROJECT_ROOT));
    const wtClaudeDir = path.join(claudeProjectsDir, encodeProjectPath(worktreePath));
    let latestSession = '';
    try {
      if (fs.existsSync(mainClaudeDir)) {
        const files = fs.readdirSync(mainClaudeDir).filter(f => f.endsWith('.jsonl'));
        let newest = { file: '', mtime: 0 };
        for (const f of files) {
          const st = fs.statSync(path.join(mainClaudeDir, f));
          if (st.mtimeMs > newest.mtime) { newest = { file: f, mtime: st.mtimeMs }; }
        }
        if (newest.file) {
          latestSession = newest.file.replace('.jsonl', '');
          if (!fs.existsSync(wtClaudeDir)) fs.mkdirSync(wtClaudeDir, { recursive: true });
          // Hardlink .jsonl (atomic, zero disk, live updates visible)
          const srcJsonl = path.join(mainClaudeDir, newest.file);
          const dstJsonl = path.join(wtClaudeDir, newest.file);
          if (!fs.existsSync(dstJsonl)) {
            try { fs.linkSync(srcJsonl, dstJsonl); } catch {
              try { fs.copyFileSync(srcJsonl, dstJsonl); } catch {}
            }
          }
          // Symlink session metadata dir
          const metaDir = path.join(mainClaudeDir, latestSession);
          const wtMetaDir = path.join(wtClaudeDir, latestSession);
          if (fs.existsSync(metaDir) && !fs.existsSync(wtMetaDir)) {
            try { fs.symlinkSync(metaDir, wtMetaDir); } catch {}
          }
          // Symlink memory
          const memDir = path.join(mainClaudeDir, 'memory');
          const wtMemDir = path.join(wtClaudeDir, 'memory');
          if (fs.existsSync(memDir) && !fs.existsSync(wtMemDir)) {
            try { fs.symlinkSync(memDir, wtMemDir); } catch {}
          }
        }
      }
    } catch {}

    // Write .mcp.json for worktree
    try {
      const wtAgentId = AGENT_ID + '-' + branch.replace(/\\//g, '-');
      const mainMcpPath = path.join(PROJECT_ROOT, '.mcp.json');
      let mcpConfig = {};
      try { mcpConfig = JSON.parse(fs.readFileSync(mainMcpPath, 'utf-8')); } catch {}
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      if (mcpConfig.mcpServers['kitty-session']) {
        mcpConfig.mcpServers['kitty-session'] = JSON.parse(JSON.stringify(mcpConfig.mcpServers['kitty-session']));
        mcpConfig.mcpServers['kitty-session'].env = mcpConfig.mcpServers['kitty-session'].env || {};
        mcpConfig.mcpServers['kitty-session'].env.KITTY_AGENT_ID = wtAgentId;
        mcpConfig.mcpServers['kitty-session'].env.KITTY_PROJECT_ROOT = worktreePath;
      }
      if (mcpConfig.mcpServers['kitty-talk']) {
        mcpConfig.mcpServers['kitty-talk'] = JSON.parse(JSON.stringify(mcpConfig.mcpServers['kitty-talk']));
        mcpConfig.mcpServers['kitty-talk'].env = mcpConfig.mcpServers['kitty-talk'].env || {};
        mcpConfig.mcpServers['kitty-talk'].env.KITTY_AGENT_ID = wtAgentId;
        mcpConfig.mcpServers['kitty-talk'].env.KITTY_AGENT_NAME = branch;
        mcpConfig.mcpServers['kitty-talk'].env.KITTY_CWD = worktreePath;
      }
      fs.writeFileSync(path.join(worktreePath, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));
    } catch {}

    // Step 2: Split pane and launch claude with --fork-session
    const message = String(args.message || '').trim();
    const paneAgentId = AGENT_ID + '-' + branch.replace(/\\//g, '-');
    const paneAgentName = branch;
    const envPrefix = 'KITTY_PANE_AGENT_ID=' + shellQuote(paneAgentId) + ' KITTY_PANE_AGENT_NAME=' + shellQuote(paneAgentName);

    let forkCmd = latestSession
      ? 'claude --resume ' + latestSession + ' --fork-session'
      : 'claude';
    if (message && latestSession) {
      forkCmd = 'claude --resume ' + latestSession + ' --fork-session -p ' + shellQuote(message);
    }
    forkCmd = 'env ' + envPrefix + ' ' + forkCmd;

    let paneCount = 1;
    try {
      paneCount = execSync(
        TMUX_BIN + ' list-panes -t ' + shellQuote(TMUX_NAME) + ' -F "#{pane_id}"',
        { stdio: 'pipe' }
      ).toString().trim().split('\\n').length;
    } catch {}

    const splitFlag = paneCount <= 1 ? '-h -p 65' : '-v';
    let splitTarget = shellQuote(TMUX_NAME);
    if (paneCount > 1) {
      try {
        const panes = execSync(
          TMUX_BIN + ' list-panes -t ' + shellQuote(TMUX_NAME) + ' -F "#{pane_id}"',
          { stdio: 'pipe' }
        ).toString().trim().split('\\n');
        splitTarget = shellQuote(panes[panes.length - 1]);
      } catch {}
    }

    const paneIdRaw = execSync(
      TMUX_BIN + ' split-window -t ' + splitTarget + ' ' + splitFlag + ' -c ' + shellQuote(worktreePath) + ' -P -F "#{pane_id}" ' + shellQuote(forkCmd),
      { stdio: 'pipe' }
    ).toString().trim();

    return {
      content: [{
        type: 'text',
        text: 'Session forked.\\nbranch: ' + branch + '\\nworktree: ' + worktreePath + '\\npaneId: ' + paneIdRaw + '\\n\\nThe forked session inherits your current conversation context via --fork-session.'
      }]
    };
  } catch (e) {
    return { content: [{ type: 'text', text: 'fork_session failed: ' + (e && e.message ? e.message : String(e)) }], isError: true };
  }
}

function handleToolCall(name, args) {
  switch (name) {
    case 'create_pane': return handleCreatePane(args);
    case 'create_worktree': return handleCreateWorktree(args);
    case 'fork_session': return handleForkSession(args);
    case 'list_panes': return handleListPanes();
    case 'close_pane': return handleClosePane(args);
    default:
      return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
  }
}

function handleRequest(req) {
  process.stderr.write('handle method=' + String(req && req.method) + ' id=' + String(req && req.id) + '\\n');
  switch (req.method) {
    case 'initialize': {
      const protocolVersion =
        typeof req?.params?.protocolVersion === 'string'
          ? req.params.protocolVersion
          : '2024-11-05';
      sendResponse(req.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kitty-session', version: '1.0.0' }
      });
      break;
    }
    case 'ping':
      sendResponse(req.id, {});
      break;
    case 'tools/list':
      sendResponse(req.id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const result = handleToolCall(req.params.name, req.params.arguments || {});
      sendResponse(req.id, result);
      break;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      break;
    default:
      // JSON-RPC: notifications (no id) must not get a response
      if (req.id !== undefined && req.id !== null) {
        sendError(req.id, -32601, 'Method not found: ' + req.method);
      }
  }
}

// Read JSON-RPC messages from stdin (Content-Length framing).
let buffer = Buffer.alloc(0);
const HEADER_BREAK_CRLF = Buffer.from('\\r\\n\\r\\n');
const HEADER_BREAK_LF = Buffer.from('\\n\\n');
process.stdin.on('data', (chunk) => {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  buffer = Buffer.concat([buffer, next]);
  while (true) {
    const crlfEnd = buffer.indexOf(HEADER_BREAK_CRLF);
    const lfEnd = buffer.indexOf(HEADER_BREAK_LF);
    let headerEnd = -1;
    let separatorLen = 0;
    if (crlfEnd !== -1 && (lfEnd === -1 || crlfEnd <= lfEnd)) {
      headerEnd = crlfEnd;
      separatorLen = HEADER_BREAK_CRLF.length;
    } else if (lfEnd !== -1) {
      headerEnd = lfEnd;
      separatorLen = HEADER_BREAK_LF.length;
    }
    if (headerEnd === -1) {
      const lineEnd = buffer.indexOf(0x0a);
      if (lineEnd === -1) break;
      const line = buffer.slice(0, lineEnd).toString('utf-8').trim();
      if (!line) {
        buffer = buffer.slice(lineEnd + 1);
        continue;
      }
      if (!line.startsWith('{')) break;
      try {
        outputMode = 'raw_line';
        handleRequest(JSON.parse(line));
        buffer = buffer.slice(lineEnd + 1);
        continue;
      } catch {
        break;
      }
    }
    const header = buffer.slice(0, headerEnd).toString('utf-8');
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      try {
        outputMode = 'raw_blank';
        handleRequest(JSON.parse(header));
      } catch {
        process.stderr.write('Raw parse error. header=' + JSON.stringify(header.slice(0, 220)) + '\\n');
      }
      buffer = buffer.slice(headerEnd + separatorLen);
      continue;
    }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + separatorLen;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len).toString('utf-8');
    buffer = buffer.slice(bodyStart + len);
    try {
      outputMode = 'framed';
      handleRequest(JSON.parse(body));
    } catch (e) {
      process.stderr.write('Parse error: ' + e.message + '\\n');
    }
  }
});
process.stdin.resume();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`
