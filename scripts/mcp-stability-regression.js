#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function extractServerScript(tsPath) {
  const source = fs.readFileSync(tsPath, 'utf8')
  const marker = 'export const MCP_SERVER_SCRIPT = '
  const start = source.indexOf(marker)
  if (start === -1) throw new Error('Cannot find MCP_SERVER_SCRIPT export')
  const tplStart = source.indexOf('`', start + marker.length)
  const tplEnd = source.lastIndexOf('`')
  if (tplStart === -1 || tplEnd <= tplStart) throw new Error('Cannot parse MCP_SERVER_SCRIPT template body')
  return Function(`"use strict"; return ${source.slice(tplStart, tplEnd + 1)};`)()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class Client {
  constructor(proxyPath, serverPath, busDir) {
    this.proc = spawn('/opt/homebrew/bin/node', [proxyPath, serverPath], {
      env: {
        ...process.env,
        KITTY_BUS_DIR: busDir,
        KITTY_AGENT_ID: '',
        KITTY_AGENT_NAME: '',
      },
    })
    this.buffer = Buffer.alloc(0)
    this.stderr = ''
    this.closed = false
    this.mode = 'framed' // framed | raw
    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    })
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8')
    })
    this.proc.on('close', () => {
      this.closed = true
    })
  }

  writeRaw(obj) {
    this.mode = 'raw'
    this.proc.stdin.write(`${JSON.stringify(obj)}\n\n`)
  }

  writeFramed(obj) {
    this.mode = 'framed'
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
    this.proc.stdin.write(Buffer.concat([header, body]))
  }

  async read(timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs
    const framedBreak = Buffer.from('\r\n\r\n')
    const rawBreak = Buffer.from('\n\n')
    while (Date.now() < deadline) {
      if (this.mode === 'framed') {
        const headerEnd = this.buffer.indexOf(framedBreak)
        if (headerEnd !== -1) {
          const header = this.buffer.slice(0, headerEnd).toString('utf8')
          const m = header.match(/Content-Length:\s*(\d+)/i)
          if (!m) throw new Error(`Invalid header: ${header}`)
          const len = Number(m[1])
          const bodyStart = headerEnd + framedBreak.length
          if (this.buffer.length >= bodyStart + len) {
            const body = this.buffer.slice(bodyStart, bodyStart + len).toString('utf8')
            this.buffer = this.buffer.slice(bodyStart + len)
            return JSON.parse(body)
          }
        }
      } else {
        const rawEnd = this.buffer.indexOf(rawBreak)
        if (rawEnd !== -1) {
          const text = this.buffer.slice(0, rawEnd).toString('utf8').trim()
          this.buffer = this.buffer.slice(rawEnd + rawBreak.length)
          if (!text) continue
          return JSON.parse(text)
        }
      }
      if (this.closed) throw new Error(`Server closed early. stderr=${this.stderr || '<empty>'}`)
      await sleep(10)
    }
    throw new Error(`Timeout waiting response. mode=${this.mode} stderr=${this.stderr || '<empty>'}`)
  }

  async close() {
    if (this.closed) return
    this.proc.kill('SIGTERM')
    const deadline = Date.now() + 1200
    while (!this.closed && Date.now() < deadline) await sleep(10)
    if (!this.closed) this.proc.kill('SIGKILL')
  }
}

async function runCycle({ proxyPath, serverPath, busDir, useRaw }) {
  const c = new Client(proxyPath, serverPath, busDir)
  try {
    const write = useRaw ? (obj) => c.writeRaw(obj) : (obj) => c.writeFramed(obj)

    write({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.117.0' },
      },
    })
    const init = await c.read()
    assert(init?.result?.serverInfo?.name === 'kitty-talk', 'initialize serverInfo mismatch')

    write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    write({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const list = await c.read()
    const names = (list?.result?.tools || []).map((t) => t.name).sort()
    assert(JSON.stringify(names) === JSON.stringify(['listen', 'peers', 'slash', 'talk']), 'tools/list mismatch')
  } finally {
    await c.close()
  }
}

async function main() {
  const root = path.resolve(__dirname, '..')
  const tsPath = path.join(root, 'src/main/mcp/server-script.ts')
  const proxyPath = path.join(os.tmpdir(), 'kitty-mcp-codex-proxy.js')
  const serverPath = path.join(os.tmpdir(), 'kitty-mcp-server.js')
  const busDir = path.join(os.tmpdir(), `kitty-bus-stability-${Date.now()}`)
  fs.mkdirSync(busDir, { recursive: true })
  fs.writeFileSync(serverPath, extractServerScript(tsPath), { mode: 0o755 })
  assert(fs.existsSync(proxyPath), 'proxy script missing: run app boot once to generate proxy')

  // Stress both framing modes across many short-lived handshakes.
  for (let i = 0; i < 12; i++) await runCycle({ proxyPath, serverPath, busDir, useRaw: true })
  for (let i = 0; i < 12; i++) await runCycle({ proxyPath, serverPath, busDir, useRaw: false })

  console.log('MCP_STABILITY_REGRESSION_OK')
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})

