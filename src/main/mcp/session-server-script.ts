/**
 * Kitty Kitty Session MCP Server Script
 *
 * This file is NOT bundled with the Electron app. It's written to disk as a
 * standalone Node.js script that Claude Code launches via stdio.
 *
 * Provides session orchestration tools:
 *   - create_pane — split tmux pane + launch agent
 *   - list_panes  — list tmux panes
 *   - close_pane  — close a tmux pane
 *
 * Environment variables (set by kitty-kitty when injecting):
 *   KITTY_AGENT_ID      - this agent's session id
 *   KITTY_TMUX_NAME     - tmux session name (e.g., "kitty_abc123")
 *   KITTY_PROJECT_ROOT  - project root path
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

const TOOLS = [
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
    description: 'Close a tmux pane.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Tmux pane ID to close (from list_panes)' }
      },
      required: ['pane_id'],
      additionalProperties: false
    }
  }
];

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
    const paneToKill = String(args.pane_id || '').trim();
    if (!paneToKill) {
      return { content: [{ type: 'text', text: 'pane_id is required.' }], isError: true };
    }
    try {
      execSync(TMUX_BIN + ' kill-pane -t ' + shellQuote(paneToKill), { stdio: 'pipe' });
      return { content: [{ type: 'text', text: 'Pane ' + paneToKill + ' closed.' }] };
    } catch {
      return { content: [{ type: 'text', text: 'Pane ' + paneToKill + ' not found (may be already dead).' }] };
    }
  } catch (e) {
    return { content: [{ type: 'text', text: 'close_pane failed: ' + (e && e.message ? e.message : String(e)) }], isError: true };
  }
}

function handleToolCall(name, args) {
  switch (name) {
    case 'create_pane': return handleCreatePane(args);
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
