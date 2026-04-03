#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractServerScript(tsPath) {
  const source = fs.readFileSync(tsPath, 'utf8');
  const marker = 'export const MCP_SERVER_SCRIPT = ';
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error('Cannot find MCP_SERVER_SCRIPT export');
  }
  const tplStart = source.indexOf('`', start + marker.length);
  const tplEnd = source.lastIndexOf('`');
  if (tplStart === -1 || tplEnd <= tplStart) {
    throw new Error('Cannot parse MCP_SERVER_SCRIPT template body');
  }
  const templateLiteral = source.slice(tplStart, tplEnd + 1);
  // Evaluate the template literal so escaped sequences are cooked (e.g. \\r\\n -> CRLF in generated JS source).
  return Function(`"use strict"; return ${templateLiteral};`)();
}

function encodeMessage(messageObj, headerSep = '\r\n\r\n') {
  const body = Buffer.from(JSON.stringify(messageObj), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}${headerSep}`, 'utf8');
  return Buffer.concat([header, body]);
}

class McpClient {
  constructor(scriptPath, env) {
    this.proc = spawn('/opt/homebrew/bin/node', [scriptPath], { env });
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.stderr = '';
    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    this.proc.on('close', () => {
      this.closed = true;
    });
  }

  async writeFramed(messageObj, splitAt = [], headerSep = '\r\n\r\n') {
    const framed = encodeMessage(messageObj, headerSep);
    if (!splitAt.length) {
      this.proc.stdin.write(framed);
      return;
    }
    const points = splitAt
      .filter((n) => Number.isInteger(n) && n > 0 && n < framed.length)
      .sort((a, b) => a - b);
    let start = 0;
    for (const point of points) {
      this.proc.stdin.write(framed.slice(start, point));
      await sleep(10);
      start = point;
    }
    this.proc.stdin.write(framed.slice(start));
  }

  async readResponse(timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    const headerBreak = Buffer.from('\r\n\r\n');
    const rawBreak = Buffer.from('\n\n');
    while (Date.now() < deadline) {
      const headerEnd = this.buffer.indexOf(headerBreak);
      if (headerEnd !== -1) {
        const header = this.buffer.slice(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          throw new Error(`Invalid header from server: ${header}`);
        }
        const len = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (this.buffer.length >= bodyStart + len) {
          const body = this.buffer.slice(bodyStart, bodyStart + len).toString('utf8');
          this.buffer = this.buffer.slice(bodyStart + len);
          return JSON.parse(body);
        }
      }
      const rawEnd = this.buffer.indexOf(rawBreak);
      if (rawEnd !== -1) {
        const maybeJson = this.buffer.slice(0, rawEnd).toString('utf8').trim();
        if (maybeJson.startsWith('{')) {
          this.buffer = this.buffer.slice(rawEnd + rawBreak.length);
          return JSON.parse(maybeJson);
        }
      }
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd !== -1) {
        const maybeJsonLine = this.buffer.slice(0, lineEnd).toString('utf8').trim();
        if (maybeJsonLine.startsWith('{')) {
          this.buffer = this.buffer.slice(lineEnd + 1);
          return JSON.parse(maybeJsonLine);
        }
      }
      if (this.closed) {
        throw new Error(`Server closed before response. stderr=${this.stderr || '<empty>'}`);
      }
      await sleep(15);
    }
    throw new Error(`Timeout waiting MCP response. stderr=${this.stderr || '<empty>'}`);
  }

  async close() {
    if (this.closed) return;
    this.proc.kill('SIGTERM');
    const deadline = Date.now() + 2000;
    while (!this.closed && Date.now() < deadline) {
      await sleep(20);
    }
    if (!this.closed) {
      this.proc.kill('SIGKILL');
    }
  }

  async writeRaw(text) {
    this.proc.stdin.write(text, 'utf8');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRawInitializeOneShot(scriptPath, env) {
  const proc = spawn('/opt/homebrew/bin/node', [scriptPath], { env });
  let stdout = Buffer.alloc(0);
  let stderr = '';
  proc.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  proc.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 99,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.117.0' },
    },
  })}\n\n`);
  proc.stdin.end();

  const closeCode = await new Promise((resolve) => proc.on('close', resolve));
  assert(closeCode === 0, `one-shot initialize exited with code=${closeCode}, stderr=${stderr || '<empty>'}`);
  const text = stdout.toString('utf8');
  if (text.includes('Content-Length:')) {
    assert(text.includes('"id":99'), 'one-shot initialize response id mismatch');
    return;
  }
  // Some clients use raw JSON-RPC framing (JSON + blank line) in both directions.
  assert(text.includes('"id":99'), 'one-shot initialize raw response id mismatch');
  assert(text.includes('"jsonrpc":"2.0"'), 'one-shot initialize raw response invalid');
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const tsPath = path.join(root, 'src/main/mcp/server-script.ts');
  const tempScriptPath = path.join(os.tmpdir(), `kitty-mcp-regression-${Date.now()}.js`);
  const busDir = path.join(os.tmpdir(), `kitty-bus-regression-${Date.now()}`);
  fs.mkdirSync(busDir, { recursive: true });
  fs.writeFileSync(tempScriptPath, extractServerScript(tsPath), { mode: 0o755 });

  const agentId = 'agent-a';
  const agentName = '甲方';
  const inboxPath = path.join(busDir, `${agentId}.inbox.jsonl`);
  const peerId = 'agent-ui';
  const peerName = '游戏 ui';
  const peerInboxPath = path.join(busDir, `${peerId}.inbox.jsonl`);
  const env = {
    ...process.env,
    KITTY_AGENT_ID: agentId,
    KITTY_AGENT_NAME: agentName,
    KITTY_BUS_DIR: busDir,
  };

  const client = new McpClient(tempScriptPath, env);

  try {
    await client.writeFramed({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'regression' },
      },
    });
    const init = await client.readResponse();
    assert(init.result?.serverInfo?.name === 'kitty-talk', 'initialize server name mismatch');
    assert(init.result?.protocolVersion === '2024-11-05', 'initialize protocol mismatch');

    // Compatibility: some MCP clients use LF-only header separator.
    await client.writeFramed({
      jsonrpc: '2.0',
      id: 11,
      method: 'ping',
      params: {},
    }, [], '\n\n');
    const pingLf = await client.readResponse();
    assert(pingLf.id === 11, 'LF header separator not supported');

    // Compatibility: raw JSON-RPC frame separated by blank line (no Content-Length).
    await client.writeRaw(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 12,
      method: 'ping',
      params: {},
    })}\n\n`);
    const pingRaw = await client.readResponse();
    assert(pingRaw.id === 12, 'raw JSON-RPC frame not supported');

    await client.writeFramed({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await client.readResponse();
    const toolNames = (list.result?.tools || []).map((t) => t.name).sort();
    assert(JSON.stringify(toolNames) === JSON.stringify(['listen', 'peers', 'slash', 'talk']), 'tools/list mismatch');

    // Codex probes resources APIs during MCP panel rendering.
    await client.writeFramed({ jsonrpc: '2.0', id: 21, method: 'resources/list', params: {} });
    const resources = await client.readResponse();
    assert(Array.isArray(resources.result?.resources), 'resources/list should return resources array');

    await client.writeFramed({ jsonrpc: '2.0', id: 22, method: 'resources/templates/list', params: {} });
    const templates = await client.readResponse();
    assert(Array.isArray(templates.result?.resourceTemplates), 'resources/templates/list should return resourceTemplates array');

    // Send tools/call with unicode payload in split chunks to verify byte-level parser.
    await client.writeFramed(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'talk',
          arguments: { to: '不存在', message: '你好，世界🌏' },
        },
      },
      [7, 29, 64]
    );
    const talk = await client.readResponse();
    const talkText = talk.result?.content?.[0]?.text || '';
    assert(talkText.includes('not found'), 'talk failure response mismatch');

    // Register a peer and verify @mention-style target resolves without requiring peers() first.
    fs.writeFileSync(
      path.join(busDir, 'agents.json'),
      JSON.stringify({
        [agentId]: { id: agentId, name: agentName, groupId: '__ungrouped__', lastSeen: Date.now() },
        [peerId]: { id: peerId, name: peerName, groupId: '__ungrouped__', lastSeen: Date.now() },
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(peerInboxPath, '', 'utf8');

    await client.writeFramed({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'talk',
        arguments: { to: '@游戏 ui', message: '你好' },
      },
    });
    const talkMention = await client.readResponse();
    const mentionText = talkMention.result?.content?.[0]?.text || '';
    assert(mentionText.includes('Delivered to'), 'talk @mention response mismatch');
    const peerInbox = fs.readFileSync(peerInboxPath, 'utf8');
    assert(peerInbox.includes('"message":"你好"'), 'talk @mention did not deliver message');

    // Unified CLI layer: slash command should route to talk/listen/peers.
    await client.writeFramed({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'slash',
        arguments: { command: '/@ 游戏 ui 在吗' },
      },
    });
    const slashTalk = await client.readResponse();
    const slashTalkText = slashTalk.result?.content?.[0]?.text || '';
    assert(slashTalkText.includes('Delivered to'), 'slash /@ did not route to talk');

    await client.writeFramed({
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: {
        name: 'slash',
        arguments: { command: '/@peers' },
      },
    });
    const slashPeers = await client.readResponse();
    const slashPeersText = slashPeers.result?.content?.[0]?.text || '';
    assert(slashPeersText.includes(peerName), 'slash /@peers did not return peers');

    await client.writeFramed({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: 'slash',
        arguments: { command: '/@' },
      },
    });
    const slashAt = await client.readResponse();
    const slashAtText = slashAt.result?.content?.[0]?.text || '';
    assert(slashAtText.includes(peerName), 'slash /@ did not return target suggestions');

    await client.writeFramed({
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: 'slash',
        arguments: { command: '/@ 游' },
      },
    });
    const slashAtPrefix = await client.readResponse();
    const slashAtPrefixText = slashAtPrefix.result?.content?.[0]?.text || '';
    assert(slashAtPrefixText.includes(peerName), 'slash /@ <prefix> did not return filtered suggestions');

    // Append a new unicode message after startup; listen() should read unread messages.
    const msg = JSON.stringify({
      from: '乙方',
      fromId: 'agent-b',
      message: '收到，请继续✅',
      done: false,
      ts: Date.now(),
    }) + '\n';
    fs.appendFileSync(inboxPath, msg, 'utf8');

    await client.writeFramed({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'listen', arguments: {} },
    });
    const listen = await client.readResponse();
    const listenText = listen.result?.content?.[0]?.text || '';
    assert(listenText.includes('乙方'), 'listen sender missing');
    assert(listenText.includes('收到，请继续✅'), 'listen unicode payload missing');

    // Compatibility: Codex sends raw initialize and may close stdin quickly.
    await runRawInitializeOneShot(tempScriptPath, env);

    console.log('MCP_REGRESSION_OK');
  } finally {
    await client.close();
    try { fs.unlinkSync(tempScriptPath); } catch {}
    try { fs.rmSync(busDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error('MCP_REGRESSION_FAIL:', err.message);
  process.exit(1);
});
