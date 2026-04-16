import { BrowserWindow } from 'electron'
import { log } from './logger'
import { getNtfyTopic } from './tmux/cli-wrapper'
import http from 'http'
import https from 'https'

let currentTopic = ''
let abortController: AbortController | null = null

export interface NtfyMessage {
  title: string
  message: string
  url?: string
  priority?: number
  tags?: string[]
}

function parseEvent(data: string): NtfyMessage | null {
  try {
    const obj = JSON.parse(data)
    if (obj.event !== 'message') return null
    return {
      title: obj.title || '',
      message: obj.message || '',
      url: obj.click || undefined,
      priority: obj.priority,
      tags: obj.tags,
    }
  } catch {
    return null
  }
}

function broadcast(msg: NtfyMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ntfy:message', msg)
  }
}

function subscribe(topic: string): void {
  if (abortController) {
    abortController.abort()
    abortController = null
  }

  if (!topic) {
    currentTopic = ''
    return
  }

  currentTopic = topic
  abortController = new AbortController()
  const signal = abortController.signal

  const url = `https://ntfy.sh/${encodeURIComponent(topic)}/json?since=all`
  const mod = url.startsWith('https') ? https : http

  const connect = (): void => {
    if (signal.aborted) return

    log('ntfy', `subscribing to ${topic}`)

    const req = mod.get(url, (res) => {
      let buffer = ''

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          const msg = parseEvent(line)
          if (msg) {
            log('ntfy', `${msg.title || '(no title)'}: ${msg.message}`)
            broadcast(msg)
          }
        }
      })

      res.on('end', () => {
        if (!signal.aborted) {
          log('ntfy', 'connection ended, reconnecting in 5s')
          setTimeout(connect, 5000)
        }
      })

      res.on('error', (err) => {
        if (!signal.aborted) {
          log('ntfy', 'stream error:', err.message)
          setTimeout(connect, 5000)
        }
      })
    })

    req.on('error', (err) => {
      if (!signal.aborted) {
        log('ntfy', 'request error:', err.message)
        setTimeout(connect, 5000)
      }
    })

    signal.addEventListener('abort', () => {
      req.destroy()
    }, { once: true })
  }

  connect()
}

export function start(): void {
  const topic = getNtfyTopic()
  if (topic) {
    subscribe(topic)
  }
}

export function stop(): void {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  currentTopic = ''
}

export function updateTopic(topic: string): void {
  if (topic === currentTopic) return
  subscribe(topic)
}
