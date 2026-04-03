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
const PROJECT_ROOT = process.env.KITTY_PROJECT_ROOT || '';
const IS_GIT_REPO = process.env.KITTY_IS_GIT_REPO === '1';

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
  }
];

const TOOLS = IS_GIT_REPO ? [...COMMON_TOOLS, ...GIT_TOOLS] : COMMON_TOOLS;

// --- Tool handlers ---

function handleCreatePane(args) {
  try {
    if (!TMUX_NAME) {
      return { content: [{ type: 'text', text: 'KITTY_TMUX_NAME is not set.' }], isError: true };
    }

    const tool = String(args.tool || 'claude').trim() || 'claude';
    const cwd = String(args.cwd || PROJECT_ROOT || '').trim();
    const message = String(args.message || '').trim();

    if (!cwd) {
      return { content: [{ type: 'text', text: 'No working directory. Provide cwd or set KITTY_PROJECT_ROOT.' }], isError: true };
    }

    // Build the command: pass message as initial prompt argument when possible
    let paneCmd = tool;
    if (message) {
      if (tool === 'claude') {
        paneCmd = tool + ' ' + JSON.stringify(message);
      } else if (tool === 'codex') {
        paneCmd = tool + ' ' + JSON.stringify(message);
      }
    }

    const paneIdRaw = execSync(
      'tmux split-window -t ' + JSON.stringify(TMUX_NAME) + ' -h -c ' + JSON.stringify(cwd) + ' -P -F "#{pane_id}" ' + JSON.stringify(paneCmd),
      { stdio: 'pipe' }
    ).toString().trim();

    // For shell tool, fall back to send-keys
    if (message && paneIdRaw && tool === 'shell') {
      setTimeout(() => {
        try {
          execSync(
            'tmux send-keys -t ' + JSON.stringify(paneIdRaw) + ' ' + JSON.stringify(message) + ' Enter',
            { stdio: 'pipe' }
          );
        } catch {}
      }, 1000);
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
        execSync('git -C ' + JSON.stringify(PROJECT_ROOT) + ' rev-parse --verify ' + JSON.stringify(branch), { stdio: 'pipe' });
        branchExists = true;
      } catch {}

      const baseBranch = String(args.base_branch || '').trim();
      let base = baseBranch;
      if (!base) {
        try {
          execSync('git -C ' + JSON.stringify(PROJECT_ROOT) + ' rev-parse --verify main', { stdio: 'pipe' });
          base = 'main';
        } catch {
          try {
            execSync('git -C ' + JSON.stringify(PROJECT_ROOT) + ' rev-parse --verify master', { stdio: 'pipe' });
            base = 'master';
          } catch {
            base = '';
          }
        }
      }

      if (branchExists) {
        execSync(
          'git -C ' + JSON.stringify(PROJECT_ROOT) + ' worktree add ' + JSON.stringify(worktreePath) + ' ' + JSON.stringify(branch),
          { stdio: 'pipe' }
        );
      } else {
        const newBranchCmd = base
          ? 'git -C ' + JSON.stringify(PROJECT_ROOT) + ' worktree add -b ' + JSON.stringify(branch) + ' ' + JSON.stringify(worktreePath) + ' ' + JSON.stringify(base)
          : 'git -C ' + JSON.stringify(PROJECT_ROOT) + ' worktree add -b ' + JSON.stringify(branch) + ' ' + JSON.stringify(worktreePath);
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
      const encodeProjectPath = (p) => p.replace(/\\//g, '-');
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
      'tmux list-panes -t ' + JSON.stringify(TMUX_NAME) + ' -F "#{pane_id}:#{pane_current_path}:#{pane_current_command}"',
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
        'tmux list-panes -t ' + JSON.stringify(TMUX_NAME) + ' -F "#{pane_id}:#{pane_current_path}"',
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

    try {
      execSync('tmux kill-pane -t ' + JSON.stringify(paneToKill), { stdio: 'pipe' });
    } catch {}

    if (cleanup && PROJECT_ROOT) {
      if (!worktreePath && targetBranch) {
        worktreePath = path.join(PROJECT_ROOT, '.worktrees', targetBranch.replace(/\\//g, '-'));
      }
      if (worktreePath && fs.existsSync(worktreePath)) {
        try { fs.unlinkSync(path.join(worktreePath, '.mcp.json')); } catch {}
        try {
          execSync('git worktree remove ' + JSON.stringify(worktreePath) + ' --force', { stdio: 'pipe' });
        } catch {}
        if (targetBranch) {
          try {
            execSync('git -C ' + JSON.stringify(PROJECT_ROOT) + ' branch -d ' + JSON.stringify(targetBranch), { stdio: 'pipe' });
          } catch {}
        }
      }
    }

    const result = 'Pane ' + paneToKill + ' closed.' + (cleanup ? ' Worktree cleaned up.' : '');
    return { content: [{ type: 'text', text: result }] };
  } catch (e) {
    return { content: [{ type: 'text', text: 'close_pane failed: ' + (e && e.message ? e.message : String(e)) }], isError: true };
  }
}

function handleToolCall(name, args) {
  switch (name) {
    case 'create_pane': return handleCreatePane(args);
    case 'create_worktree': return handleCreateWorktree(args);
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
      sendError(req.id, -32601, 'Method not found: ' + req.method);
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
