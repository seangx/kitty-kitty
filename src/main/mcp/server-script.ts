/**
 * Kitty Kitty MCP Server Script
 *
 * This file is NOT bundled with the Electron app. It's written to disk as a
 * standalone Node.js script that Claude Code launches via stdio.
 *
 * Each agent gets its own MCP server process, but they all share the same
 * message bus directory for inter-agent communication.
 *
 * Environment variables (set by kitty-kitty when injecting):
 *   KITTY_AGENT_ID    - this agent's unique id (session id)
 *   KITTY_AGENT_NAME  - this agent's display name / alias
 *   KITTY_BUS_DIR     - shared message bus directory
 */

export const MCP_SERVER_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Pane agents inherit parent .mcp.json but get unique identity via TMUX_PANE.
// Every pane in tmux gets a unique TMUX_PANE env var. If not :0.0, this is
// a sub-pane → generate a unique agent ID to avoid collisions with parent.
const BASE_AGENT_ID = process.env.KITTY_PANE_AGENT_ID || process.env.KITTY_AGENT_ID || 'unknown';
const BASE_AGENT_NAME = process.env.KITTY_PANE_AGENT_NAME || process.env.KITTY_AGENT_NAME || 'unknown';
const BUS_DIR = process.env.KITTY_BUS_DIR || '/tmp/kitty-bus';
let GROUP_ID = process.env.KITTY_GROUP_ID || '__ungrouped__';
let GROUP_NAME = process.env.KITTY_GROUP_NAME || '';
const TMUX_NAME = process.env.KITTY_TMUX_NAME || '';
const TMUX_PANE = process.env.TMUX_PANE || '';
const AGENT_ROLES = (process.env.KITTY_AGENT_ROLES || '').split(',').map(s => s.trim()).filter(Boolean);
const AGENT_EXPERTISE = process.env.KITTY_AGENT_EXPERTISE || '';
const PARENT_ID = process.env.KITTY_PANE_PARENT_ID || '';

// Ensure bus directory exists
if (!fs.existsSync(BUS_DIR)) fs.mkdirSync(BUS_DIR, { recursive: true });

// Resolve unique agent identity.
// Sub-panes created by create_pane get KITTY_PANE_AGENT_ID set explicitly.
// Main panes use the base ID directly.
let AGENT_ID = BASE_AGENT_ID;
let AGENT_NAME = BASE_AGENT_NAME;

// Register this agent (atomic write-rename to avoid race conditions)
const agentsFile = path.join(BUS_DIR, 'agents.json');
const agentsTmpFile = path.join(BUS_DIR, '.agents.' + AGENT_ID + '.tmp');
function registerAgent() {
  for (let attempt = 0; attempt < 3; attempt++) {
    let agents = {};
    try { agents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8')); } catch {}
    agents[AGENT_ID] = {
      id: AGENT_ID,
      name: AGENT_NAME,
      groupId: GROUP_ID,
      groupName: GROUP_NAME,
      roles: AGENT_ROLES,
      expertise: AGENT_EXPERTISE,
      parentId: PARENT_ID || null,
      tool: process.env.KITTY_TOOL || '',
      cwd: process.env.KITTY_CWD || '',
      tmuxName: TMUX_NAME,
      tmuxPane: TMUX_PANE,
      lastSeen: Date.now()
    };
    // If another process updated our group while we were running, pick it up
    if (agents[AGENT_ID] && agents[AGENT_ID].groupId && agents[AGENT_ID].groupId !== GROUP_ID) {
      GROUP_ID = agents[AGENT_ID].groupId;
      GROUP_NAME = agents[AGENT_ID].groupName || '';
      agents[AGENT_ID].groupId = GROUP_ID;
      agents[AGENT_ID].groupName = GROUP_NAME;
    }
    try {
      fs.writeFileSync(agentsTmpFile, JSON.stringify(agents, null, 2));
      fs.renameSync(agentsTmpFile, agentsFile);
      return;
    } catch {
      // rename failed (concurrent write) — retry with fresh read
      try { fs.unlinkSync(agentsTmpFile); } catch {}
    }
  }
  // Last resort: direct write
  let agents = {};
  try { agents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8')); } catch {}
  agents[AGENT_ID] = {
    id: AGENT_ID, name: AGENT_NAME, groupId: GROUP_ID,
    groupName: GROUP_NAME, roles: AGENT_ROLES, expertise: AGENT_EXPERTISE,
    parentId: PARENT_ID || null, tool: process.env.KITTY_TOOL || '',
    cwd: process.env.KITTY_CWD || '', tmuxName: TMUX_NAME, tmuxPane: TMUX_PANE,
    lastSeen: Date.now()
  };
  fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
}
registerAgent();

// Inbox for this agent
const inboxFile = path.join(BUS_DIR, AGENT_ID + '.inbox.jsonl');
if (!fs.existsSync(inboxFile)) fs.writeFileSync(inboxFile, '');

// Track read position
let readOffset = 0;
try {
  const stat = fs.statSync(inboxFile);
  readOffset = stat.size; // Start from current end (don't read old messages)
} catch {}

// --- MCP Protocol ---

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

const TOOLS = [
  {
    name: 'talk',
    description: 'Send a message to another agent. Messages are queued and delivered asynchronously — the target does NOT need to be active. When the user says "@name <message>", call this tool directly without asking follow-up questions. Use "role:ux" to route by role, or "parent" to message your parent agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target: agent name/id, "role:<role>" for role-based routing, or "parent" for parent agent.' },
        message: { type: 'string', description: 'Message content' },
        done: { type: 'boolean', description: 'Set true to signal conversation is complete', default: false }
      },
      required: ['to', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'listen',
    description: 'Check for new messages from other agents. Returns unread messages since last check.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'peers',
    description: 'List available agents. By default lists agents in your group. Use all=true to list all agents, role to filter by role, keyword to search.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'List all agents across all groups', default: false },
        role: { type: 'string', description: 'Filter by role (e.g. "ux", "backend")' },
        keyword: { type: 'string', description: 'Search name, roles, and expertise' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'slash',
    description: 'Unified CLI command router. Supports /@ <target> <message>, /@peers, /@listen.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Raw slash command entered by user.' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
];

function handleToolCall(name, args) {
  switch (name) {
    case 'talk': {
      const { to, message, done } = args;
      const agents = readAgents();
      const rawTo = String(to || '').trim();
      const messageText = String(message || '').trim();
      if (!rawTo) {
        return { content: [{ type: 'text', text: 'Missing target. Use talk({ to: "@name", message: "..." }).' }], isError: true };
      }
      if (!messageText) {
        return { content: [{ type: 'text', text: 'Missing message body.' }], isError: true };
      }

      // Special routing: "parent" → send to parent agent
      if (rawTo.toLowerCase() === 'parent') {
        if (!PARENT_ID) {
          return { content: [{ type: 'text', text: 'No parent agent. This is a main session, not a sub-pane.' }], isError: true };
        }
        const parentAgent = agents[PARENT_ID];
        if (!parentAgent) {
          return { content: [{ type: 'text', text: 'Parent agent ' + PARENT_ID + ' not found in registry.' }], isError: true };
        }
        const parentInbox = path.join(BUS_DIR, PARENT_ID + '.inbox.jsonl');
        const msg = JSON.stringify({ from: AGENT_NAME, fromId: AGENT_ID, message: messageText, done: !!done, ts: Date.now() }) + '\\n';
        fs.appendFileSync(parentInbox, msg);
        return { content: [{ type: 'text', text: 'Delivered to parent ' + (parentAgent.name || PARENT_ID) + ' [' + PARENT_ID + ']' }] };
      }

      // Role-based routing: "role:ux"
      if (rawTo.startsWith('role:')) {
        const role = rawTo.slice(5).trim().toLowerCase();
        const matches = Object.entries(agents).filter(([id, v]) => {
          if (!v || id === AGENT_ID) return false;
          return Array.isArray(v.roles) && v.roles.some(r => r.toLowerCase() === role);
        });
        if (matches.length === 0) {
          return { content: [{ type: 'text', text: 'No agent with role "' + role + '". Use peers({ role: "' + role + '" }) to check.' }], isError: true };
        }
        const msg = JSON.stringify({ from: AGENT_NAME, fromId: AGENT_ID, message: messageText, done: !!done, ts: Date.now() }) + '\\n';
        const delivered = [];
        for (const [id, v] of matches) {
          const inbox = path.join(BUS_DIR, id + '.inbox.jsonl');
          fs.appendFileSync(inbox, msg);
          delivered.push((v.name || id) + ' [' + id + ']');
        }
        if (delivered.length === 1) {
          return { content: [{ type: 'text', text: 'Delivered to ' + delivered[0] + (done ? ' (marked as done)' : '') }] };
        }
        return { content: [{ type: 'text', text: 'Broadcast to ' + delivered.length + ' agents with role "' + role + '":\\n' + delivered.join('\\n') }] };
      }

      const targetKey = normalizeTarget(rawTo);
      // Group broadcast: @@groupName (normalizeTarget strips one @, so one @ remains)
      if (targetKey.startsWith('@')) {
        const groupName = targetKey.slice(1);
        return handleGroupBroadcast(agents, groupName, messageText, done);
      }
      const matches = findAllMatches(agents, targetKey);
      if (matches.length === 0) {
        return { content: [{ type: 'text', text: 'Agent "' + to + '" not found. Use peers() to see available agents.' }], isError: true };
      }
      if (matches.length > 1) {
        const candidates = matches.map(([id, v]) => (v.name || id) + ' [' + id + ']' + (v.groupName ? ' (group: ' + v.groupName + ')' : '')).join('\\n');
        return { content: [{ type: 'text', text: 'Multiple agents match "' + to + '". Please specify by id:\\n' + candidates }], isError: true };
      }
      const targetId = matches[0][0];
      const targetName = matches[0][1] && matches[0][1].name ? matches[0][1].name : targetId;
      const targetInbox = path.join(BUS_DIR, targetId + '.inbox.jsonl');
      const msg = JSON.stringify({ from: AGENT_NAME, fromId: AGENT_ID, message: messageText, done: !!done, ts: Date.now() }) + '\\n';
      fs.appendFileSync(targetInbox, msg);
      return { content: [{ type: 'text', text: 'Delivered to ' + targetName + ' [' + targetId + ']' + (done ? ' (marked as done)' : '') }] };
    }
    case 'listen': {
      try {
        const buf = fs.readFileSync(inboxFile);
        if (buf.length < readOffset) readOffset = 0;
        if (buf.length <= readOffset) {
          return { content: [{ type: 'text', text: 'No new messages.' }] };
        }
        const newBuf = buf.slice(readOffset);
        // Only consume up to the last complete line
        const lastNl = newBuf.lastIndexOf(0x0a);
        if (lastNl < 0) {
          return { content: [{ type: 'text', text: 'No new messages.' }] };
        }
        const completeBuf = newBuf.slice(0, lastNl + 1);
        const newContent = completeBuf.toString('utf-8');
        readOffset = readOffset + completeBuf.length;
        if (!newContent.trim()) {
          return { content: [{ type: 'text', text: 'No new messages.' }] };
        }
        const messages = newContent.trim().split('\\n').map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const formatted = messages.map(m =>
          '[' + m.from + '] ' + m.message + (m.done ? ' (conversation complete)' : '')
        ).join('\\n');
        return { content: [{ type: 'text', text: formatted }] };
      } catch {
        return { content: [{ type: 'text', text: 'No new messages.' }] };
      }
    }
    case 'peers': {
      const agents = readAgents();
      const showAll = !!args.all || !!args.role || !!args.keyword;
      const filterRole = String(args.role || '').trim().toLowerCase();
      const filterKeyword = String(args.keyword || '').trim().toLowerCase();
      const hasGroup = GROUP_ID && GROUP_ID !== '__ungrouped__';

      function formatAgent(id, v) {
        const ago = Math.round((Date.now() - (v.lastSeen || 0)) / 1000);
        const label = ago < 60 ? 'active' : ago < 300 ? Math.round(ago / 60) + 'm ago' : 'idle';
        const parts = [v.name + ' [' + id + '] (' + label + ')'];
        const roles = Array.isArray(v.roles) && v.roles.length ? v.roles.join(', ') : '';
        if (roles) parts.push('roles: ' + roles);
        if (v.expertise) parts.push(v.expertise);
        const meta = [v.tool, v.cwd].filter(Boolean).join(' | ');
        if (meta) parts.push(meta);
        if (v.parentId) parts.push('parent: ' + v.parentId);
        return parts.join(' — ');
      }

      function matchesFilter(id, v) {
        if (id === AGENT_ID || !v) return false;
        if (filterRole) {
          if (!Array.isArray(v.roles) || !v.roles.some(r => r.toLowerCase() === filterRole)) return false;
        }
        if (filterKeyword) {
          const haystack = [v.name, ...(v.roles || []), v.expertise || '', v.cwd || ''].join(' ').toLowerCase();
          if (!haystack.includes(filterKeyword)) return false;
        }
        return true;
      }

      let entries = Object.entries(agents);
      if (!showAll && hasGroup) {
        entries = entries.filter(([id, v]) => v && v.groupId === GROUP_ID);
      }
      entries = entries.filter(([id, v]) => matchesFilter(id, v));

      // Separate main agents and sub-panes
      const mainAgents = entries.filter(([id, v]) => !v.parentId);
      const subPanes = entries.filter(([id, v]) => !!v.parentId);

      // Group by group
      const groups = {};
      for (const [id, v] of mainAgents) {
        const gName = v.groupName || v.groupId || '__ungrouped__';
        if (!groups[gName]) groups[gName] = [];
        let line = formatAgent(id, v);
        // Append sub-panes under this agent
        const children = subPanes.filter(([, sv]) => sv.parentId === id);
        if (children.length) {
          line += '\\n' + children.map(([cid, cv]) => '  └─ ' + formatAgent(cid, cv)).join('\\n');
        }
        groups[gName].push(line);
      }
      // Orphan sub-panes (parent not in current view)
      const shownParents = new Set(mainAgents.map(([id]) => id));
      const orphans = subPanes.filter(([, v]) => !shownParents.has(v.parentId));
      if (orphans.length) {
        for (const [id, v] of orphans) {
          const gName = v.groupName || v.groupId || '__ungrouped__';
          if (!groups[gName]) groups[gName] = [];
          groups[gName].push(formatAgent(id, v));
        }
      }

      const sections = Object.keys(groups).sort().map(g => '## ' + g + '\\n' + groups[g].join('\\n')).join('\\n\\n');
      const suffix = !showAll && hasGroup ? '\\n\\nTip: Use peers({ all: true }) to see agents across all groups.' : '';
      return { content: [{ type: 'text', text: (sections || 'No matching agents found.') + suffix + '\\nNote: Messages are queued and will be delivered when the agent is ready. You can always send even if they appear idle.' }] };
    }
    case 'slash': {
      const raw = String(args?.command || '').trim();
      if (!raw) {
        return { content: [{ type: 'text', text: 'Usage: /@ <target> <message> | /@peers | /@listen' }], isError: true };
      }
      if (raw === '/@peers') return handleToolCall('peers', {});
      if (raw === '/@peers --all' || raw === '/@peers -a') return handleToolCall('peers', { all: true });
      if (raw === '/@listen') return handleToolCall('listen', {});
      if (raw.startsWith('/@')) {
        const agents = readAgents();
        const rest = raw.slice(2).trim();
        if (!rest) {
          return buildSlashTargetSuggestions(agents, '');
        }
        const parsed = parseSlashTalk(rest, agents);
        if (!parsed) return buildSlashTargetSuggestions(agents, rest);
        return handleToolCall('talk', parsed);
      }
      return { content: [{ type: 'text', text: 'Unsupported slash command. Use /@, /@peers, /@listen.' }], isError: true };
    }
    default:
      return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
  }
}

function normalizeTarget(value) {
  return String(value || '').trim().replace(/^@/, '').trim();
}

function readAgents() {
  let agents = {};
  try { agents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8')); } catch {}
  return agents;
}

function findTargetEntry(agents, targetKey) {
  const wanted = String(targetKey || '').toLowerCase();
  return Object.entries(agents).find(([id, v]) => {
    if (!v) return false;
    return String(v.name || '').toLowerCase() === wanted || String(id || '').toLowerCase() === wanted;
  });
}

function findAllMatches(agents, targetKey) {
  const wanted = String(targetKey || '').toLowerCase();
  return Object.entries(agents).filter(([id, v]) => {
    if (!v || id === AGENT_ID) return false;
    return String(v.name || '').toLowerCase() === wanted || String(id || '').toLowerCase() === wanted;
  });
}

function handleGroupBroadcast(agents, groupName, messageText, done) {
  const members = Object.entries(agents).filter(([id, v]) => {
    if (!v || id === AGENT_ID) return false;
    return String(v.groupName || '').toLowerCase() === groupName.toLowerCase()
        || String(v.groupId || '').toLowerCase() === groupName.toLowerCase();
  });
  if (members.length === 0) {
    return { content: [{ type: 'text', text: 'No agents found in group "' + groupName + '".' }], isError: true };
  }
  const msg = JSON.stringify({ from: AGENT_NAME, fromId: AGENT_ID, message: messageText, done: !!done, ts: Date.now() }) + '\\n';
  const delivered = [];
  for (const [id, v] of members) {
    const inbox = path.join(BUS_DIR, id + '.inbox.jsonl');
    fs.appendFileSync(inbox, msg);
    delivered.push(v.name || id);
  }
  return { content: [{ type: 'text', text: 'Broadcast to ' + delivered.length + ' agents in ' + groupName + ': ' + delivered.join(', ') }] };
}

function parseSlashTalk(rest, agents) {
  const text = String(rest || '').trim();
  if (!text) return null;

  let best = null;
  const candidates = [];
  for (const [id, v] of Object.entries(agents)) {
    if (id === AGENT_ID || !v) continue;
    const name = normalizeTarget(String(v.name || '').trim());
    if (name) candidates.push(name);
    candidates.push(String(id));
  }
  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();
    const textLower = text.toLowerCase();
    if (textLower === candidateLower || textLower.startsWith(candidateLower + ' ')) {
      if (!best || candidate.length > best.length) best = candidate;
    }
  }
  if (best) {
    const message = text.slice(best.length).trim();
    if (!message) return null;
    return { to: best, message };
  }

  const firstSpace = text.indexOf(' ');
  if (firstSpace <= 0 || firstSpace >= text.length - 1) return null;
  return { to: text.slice(0, firstSpace).trim(), message: text.slice(firstSpace + 1).trim() };
}

function buildSlashTargetSuggestions(agents, prefix) {
  const wanted = normalizeTarget(String(prefix || '')).toLowerCase();
  const rows = Object.entries(agents)
    .filter(([id, v]) => id !== AGENT_ID && v)
    .map(([id, v]) => ({
      id,
      name: String(v.name || id),
      lastSeen: v.lastSeen || 0,
    }))
    .filter((row) => {
      if (!wanted) return true;
      return row.name.toLowerCase().includes(wanted) || row.id.toLowerCase().includes(wanted);
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  if (!rows.length) {
    return { content: [{ type: 'text', text: 'No matching agents. Use /@peers to list all available agents.' }], isError: true };
  }

  const list = rows
    .map((row) => {
      const ago = Math.round((Date.now() - row.lastSeen) / 1000);
      const label = ago < 60 ? 'active' : ago < 300 ? Math.round(ago / 60) + 'm ago' : 'idle';
      return '@' + row.name + ' [' + row.id + '] (' + label + ')';
    })
    .join('\\n');
  const header = wanted
    ? 'Targets matching "' + prefix + '":'
    : 'Available targets:';
  return {
    content: [{ type: 'text', text: header + '\\n' + list + '\\n\\nUsage: /@ <target> <message>' }]
  };
}

function handleRequest(req) {
  process.stderr.write('handle method=' + String(req && req.method) + ' id=' + String(req && req.id) + '\\n');
  switch (req.method) {
    case 'initialize':
      process.stderr.write('handle initialize id=' + String(req.id) + '\\n');
      const protocolVersion =
        typeof req?.params?.protocolVersion === 'string'
          ? req.params.protocolVersion
          : '2024-11-05';
      sendResponse(req.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kitty-talk', version: '1.0.0' }
      });
      break;
    case 'ping':
      sendResponse(req.id, {});
      break;
    case 'tools/list':
      sendResponse(req.id, { tools: TOOLS });
      break;
    case 'resources/list':
      sendResponse(req.id, { resources: [] });
      break;
    case 'resources/templates/list':
      sendResponse(req.id, { resourceTemplates: [] });
      break;
    case 'tools/call':
      registerAgent(); // heartbeat
      const result = handleToolCall(req.params.name, req.params.arguments || {});
      sendResponse(req.id, result);
      break;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      break; // no response needed for notifications
    default:
      // JSON-RPC: notifications (no id) must not get a response
      if (req.id !== undefined && req.id !== null) {
        sendError(req.id, -32601, 'Method not found: ' + req.method);
      }
  }
}

// Read JSON-RPC messages from stdin (Content-Length framing).
// Use byte-level parsing so UTF-8 multibyte chars never break framing.
let buffer = Buffer.alloc(0);
let outputMode = 'framed'; // 'framed' | 'raw_blank' | 'raw_line'
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
      // Compatibility: some clients send line-delimited JSON-RPC (one JSON per line).
      const lineEnd = buffer.indexOf(0x0a); // newline
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
        // Likely partial JSON line; wait for more data.
        break;
      }
    }
    const header = buffer.slice(0, headerEnd).toString('utf-8');
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      // Compatibility: some clients send JSON-RPC bodies as raw JSON separated by blank lines.
      // In that case "header" is actually the full JSON body.
      try {
        outputMode = 'raw_blank';
        handleRequest(JSON.parse(header));
      } catch {
        // Unknown fragment; drop it and continue scanning.
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

function unregisterAgent() {
  try {
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));
    delete agents[AGENT_ID];
    fs.writeFileSync(agentsTmpFile, JSON.stringify(agents, null, 2));
    fs.renameSync(agentsTmpFile, agentsFile);
  } catch {
    try { fs.unlinkSync(agentsTmpFile); } catch {}
  }
}
process.on('SIGTERM', () => { unregisterAgent(); process.exit(0); });
process.on('SIGINT', () => { unregisterAgent(); process.exit(0); });
process.on('exit', () => { unregisterAgent(); });
`
