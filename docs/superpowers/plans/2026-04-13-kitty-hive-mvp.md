# kitty-hive MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone MCP server that enables AI agents to collaborate via rooms, messages, and tasks over Streamable HTTP.

**Architecture:** Single-process HTTP server backed by SQLite (WAL mode). Agents connect via MCP Streamable HTTP, register with `hive.start()`, then interact through rooms. Tasks are event sequences within rooms with a state machine.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3`, Node.js HTTP

**Repo:** `~/ai-workspace/kitty-hive/` (independent from kitty-kitty)

---

## File Structure

```
kitty-hive/
  src/
    index.ts              # CLI: parse --port, --db args, start server
    server.ts             # HTTP server + MCP StreamableHTTP transport + tool registration
    db.ts                 # SQLite init, schema creation, WAL config, query helpers
    auth.ts               # Extract agent_id from Bearer token
    models.ts             # TS types: Agent, Room, RoomEvent, TaskState, EventType
    state-machine.ts      # Task state transition validation
    utils.ts              # ULID generation, token generation, timestamp helpers
    tools/
      start.ts            # hive.start tool handler
      dm.ts               # hive.dm tool handler
      task.ts             # hive.task + hive.check tool handlers
      room.ts             # hive.room.post / events / list / info tool handlers
  package.json
  tsconfig.json
  README.md
```

---

### Task 1: Scaffold project and configure build

**Files:**
- Create: `~/ai-workspace/kitty-hive/package.json`
- Create: `~/ai-workspace/kitty-hive/tsconfig.json`
- Create: `~/ai-workspace/kitty-hive/src/index.ts`
- Create: `~/ai-workspace/kitty-hive/README.md`

- [ ] **Step 1: Create project directory and init**

```bash
mkdir -p ~/ai-workspace/kitty-hive/src/tools
cd ~/ai-workspace/kitty-hive
git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "kitty-hive",
  "version": "0.1.0",
  "description": "Room-first MCP server for multi-agent collaboration",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "kitty-hive": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js serve",
    "test": "node --test dist/**/*.test.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.8.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create minimal src/index.ts**

```typescript
#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

if (command !== 'serve') {
  console.log('Usage: kitty-hive serve [--port 4100] [--db ~/.kitty-hive/hive.db]');
  process.exit(0);
}

let port = 4100;
let dbPath = '';

for (let i = 1; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--db' && args[i + 1]) {
    dbPath = args[i + 1];
    i++;
  }
}

console.log(`kitty-hive starting on port ${port}...`);
```

- [ ] **Step 5: Install dependencies and build**

```bash
cd ~/ai-workspace/kitty-hive
npm install
npx tsc
```

Expected: `dist/index.js` created, no errors.

- [ ] **Step 6: Test CLI runs**

```bash
node dist/index.js serve
```

Expected: `kitty-hive starting on port 4100...`

- [ ] **Step 7: Create .gitignore and commit**

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
*.db
*.db-wal
*.db-shm
EOF

git add -A
git commit -m "chore: scaffold kitty-hive project"
```

---

### Task 2: Types and utilities

**Files:**
- Create: `src/models.ts`
- Create: `src/utils.ts`
- Create: `src/state-machine.ts`

- [ ] **Step 1: Create src/models.ts**

```typescript
export interface Agent {
  id: string;
  display_name: string;
  token: string;
  tool: string;
  roles: string;
  expertise: string;
  status: 'active' | 'idle' | 'busy' | 'offline';
  created_at: string;
  last_seen: string;
}

export type RoomKind = 'dm' | 'team' | 'task' | 'project' | 'lobby';

export interface Room {
  id: string;
  name: string | null;
  kind: RoomKind;
  host_agent_id: string | null;
  parent_room_id: string | null;
  metadata_json: string;
  created_at: string;
  closed_at: string | null;
}

export const EVENT_TYPES = [
  'join', 'leave', 'message',
  'task-start', 'task-claim', 'task-update',
  'task-ask', 'task-answer',
  'task-complete', 'task-fail', 'task-cancel',
] as const;

export type EventType = typeof EVENT_TYPES[number];

export interface RoomEvent {
  id: number;
  room_id: string;
  seq: number;
  type: EventType;
  actor_agent_id: string | null;
  payload_json: string;
  ts: string;
}

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';
```

- [ ] **Step 2: Create src/utils.ts**

```typescript
import { randomBytes } from 'node:crypto';

// Simple ULID-like ID: timestamp prefix + random suffix (sortable, unique)
export function ulid(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(8).toString('hex');
  return `${ts}-${rand}`;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function nowISO(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 3: Create src/state-machine.ts**

```typescript
import type { TaskState, EventType } from './models.js';

const TRANSITIONS: Record<string, TaskState> = {
  // "fromState:eventType" → toState
  ':task-start': 'submitted',
  'submitted:task-claim': 'working',
  'working:task-update': 'working',
  'working:task-ask': 'input-required',
  'input-required:task-answer': 'working',
  'working:task-complete': 'completed',
  'working:task-fail': 'failed',
  // cancel from any non-terminal
  'submitted:task-cancel': 'canceled',
  'working:task-cancel': 'canceled',
  'input-required:task-cancel': 'canceled',
};

const TERMINAL: Set<TaskState> = new Set(['completed', 'failed', 'canceled']);

export function nextState(current: TaskState | null, event: EventType): TaskState | null {
  const key = `${current ?? ''}:${event}`;
  return TRANSITIONS[key] ?? null;
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

export function isTaskEvent(type: EventType): boolean {
  return type.startsWith('task-');
}

export function deriveTaskState(events: Array<{ type: EventType }>): TaskState {
  let state: TaskState = 'submitted';
  for (const e of events) {
    if (!isTaskEvent(e.type)) continue;
    const next = nextState(state, e.type);
    if (next) state = next;
  }
  return state;
}
```

- [ ] **Step 4: Build and verify**

```bash
npx tsc
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/models.ts src/utils.ts src/state-machine.ts
git commit -m "feat: add types, utilities, and task state machine"
```

---

### Task 3: SQLite database layer

**Files:**
- Create: `src/db.ts`

- [ ] **Step 1: Create src/db.ts**

```typescript
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { Agent, Room, RoomEvent, EventType } from './models.js';
import { ulid, generateToken, nowISO } from './utils.js';

let db: Database.Database;

export function initDB(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || join(homedir(), '.kitty-hive', 'hive.db');
  mkdirSync(join(resolvedPath, '..'), { recursive: true });

  db = new Database(resolvedPath);

  // WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -8192'); // 8MB

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      token         TEXT UNIQUE NOT NULL,
      tool          TEXT DEFAULT '',
      roles         TEXT DEFAULT '',
      expertise     TEXT DEFAULT '',
      status        TEXT DEFAULT 'active'
                    CHECK(status IN ('active','idle','busy','offline')),
      created_at    TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token);
    CREATE INDEX IF NOT EXISTS idx_agents_roles ON agents(roles);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

    CREATE TABLE IF NOT EXISTS rooms (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      kind            TEXT NOT NULL
                      CHECK(kind IN ('dm','team','task','project','lobby')),
      host_agent_id   TEXT REFERENCES agents(id),
      parent_room_id  TEXT REFERENCES rooms(id),
      metadata_json   TEXT DEFAULT '{}',
      created_at      TEXT NOT NULL,
      closed_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_kind ON rooms(kind);
    CREATE INDEX IF NOT EXISTS idx_rooms_host ON rooms(host_agent_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_parent ON rooms(parent_room_id);

    CREATE TABLE IF NOT EXISTS room_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id         TEXT NOT NULL REFERENCES rooms(id),
      seq             INTEGER NOT NULL,
      type            TEXT NOT NULL,
      actor_agent_id  TEXT REFERENCES agents(id),
      payload_json    TEXT DEFAULT '{}',
      ts              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_room_seq ON room_events(room_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_room_type ON room_events(room_id, type);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON room_events(actor_agent_id);
  `);

  return db;
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

// --- Agent queries ---

export function createAgent(displayName: string, tool: string, roles: string, expertise: string): Agent {
  const agent: Agent = {
    id: ulid(),
    display_name: displayName,
    token: generateToken(),
    tool,
    roles,
    expertise,
    status: 'active',
    created_at: nowISO(),
    last_seen: nowISO(),
  };
  getDB().prepare(`
    INSERT INTO agents (id, display_name, token, tool, roles, expertise, status, created_at, last_seen)
    VALUES (@id, @display_name, @token, @tool, @roles, @expertise, @status, @created_at, @last_seen)
  `).run(agent);
  return agent;
}

export function getAgentByToken(token: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE token = ?').get(token) as Agent | undefined;
}

export function getAgentById(id: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}

export function getAgentByName(name: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE display_name = ?').get(name) as Agent | undefined;
}

export function findAgentByRole(role: string): Agent | undefined {
  return getDB().prepare(
    "SELECT * FROM agents WHERE roles LIKE ? AND status = 'active' ORDER BY last_seen DESC LIMIT 1"
  ).get(`%${role}%`) as Agent | undefined;
}

export function touchAgent(id: string): void {
  getDB().prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(nowISO(), id);
}

// --- Room queries ---

export function createRoom(kind: string, hostAgentId: string | null, name?: string, parentRoomId?: string, metadata?: object): Room {
  const room: Room = {
    id: ulid(),
    name: name ?? null,
    kind: kind as Room['kind'],
    host_agent_id: hostAgentId,
    parent_room_id: parentRoomId ?? null,
    metadata_json: JSON.stringify(metadata ?? {}),
    created_at: nowISO(),
    closed_at: null,
  };
  getDB().prepare(`
    INSERT INTO rooms (id, name, kind, host_agent_id, parent_room_id, metadata_json, created_at, closed_at)
    VALUES (@id, @name, @kind, @host_agent_id, @parent_room_id, @metadata_json, @created_at, @closed_at)
  `).run(room);
  return room;
}

export function getRoomById(id: string): Room | undefined {
  return getDB().prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Room | undefined;
}

export function getLobby(): Room | undefined {
  return getDB().prepare("SELECT * FROM rooms WHERE kind = 'lobby' LIMIT 1").get() as Room | undefined;
}

export function findDMRoom(agentA: string, agentB: string): Room | undefined {
  // Find a dm room where both agents have joined and neither has left
  return getDB().prepare(`
    SELECT r.* FROM rooms r
    WHERE r.kind = 'dm'
      AND EXISTS (
        SELECT 1 FROM room_events e WHERE e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?
      )
      AND EXISTS (
        SELECT 1 FROM room_events e WHERE e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?
      )
    LIMIT 1
  `).get(agentA, agentB) as Room | undefined;
}

// --- Event queries ---

export function appendEvent(roomId: string, type: EventType, actorAgentId: string | null, payload: object = {}): RoomEvent {
  const d = getDB();
  const maxSeq = d.prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM room_events WHERE room_id = ?').get(roomId) as { max_seq: number };
  const seq = maxSeq.max_seq + 1;
  const ts = nowISO();
  const payloadJson = JSON.stringify(payload);

  const result = d.prepare(`
    INSERT INTO room_events (room_id, seq, type, actor_agent_id, payload_json, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(roomId, seq, type, actorAgentId, payloadJson, ts);

  return {
    id: result.lastInsertRowid as number,
    room_id: roomId,
    seq,
    type,
    actor_agent_id: actorAgentId,
    payload_json: payloadJson,
    ts,
  };
}

export function getEvents(roomId: string, since: number = 0, limit: number = 50): RoomEvent[] {
  return getDB().prepare(
    'SELECT * FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  ).all(roomId, since, limit) as RoomEvent[];
}

export function getTaskEvents(taskId: string): RoomEvent[] {
  return getDB().prepare(
    "SELECT * FROM room_events WHERE payload_json LIKE ? AND type LIKE 'task-%' ORDER BY seq ASC"
  ).all(`%"task_id":"${taskId}"%`) as RoomEvent[];
}

export function getRoomMembers(roomId: string): string[] {
  const events = getDB().prepare(
    "SELECT type, actor_agent_id FROM room_events WHERE room_id = ? AND type IN ('join', 'leave') ORDER BY seq ASC"
  ).all(roomId) as Array<{ type: string; actor_agent_id: string }>;

  const members = new Set<string>();
  for (const e of events) {
    if (e.type === 'join') members.add(e.actor_agent_id);
    if (e.type === 'leave') members.delete(e.actor_agent_id);
  }
  return [...members];
}

export function isMember(roomId: string, agentId: string): boolean {
  return getRoomMembers(roomId).includes(agentId);
}

export function getAgentRooms(agentId: string, kind?: string, activeOnly?: boolean): Room[] {
  let sql = `
    SELECT DISTINCT r.* FROM rooms r
    JOIN room_events e ON e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?
    WHERE NOT EXISTS (
      SELECT 1 FROM room_events e2
      WHERE e2.room_id = r.id AND e2.type = 'leave' AND e2.actor_agent_id = ?
        AND e2.seq > e.seq
    )
  `;
  const params: any[] = [agentId, agentId];

  if (kind) {
    sql += ' AND r.kind = ?';
    params.push(kind);
  }
  if (activeOnly) {
    sql += ' AND r.closed_at IS NULL';
  }

  return getDB().prepare(sql).all(...params) as Room[];
}
```

- [ ] **Step 2: Build and verify**

```bash
npx tsc
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat: SQLite database layer with agents, rooms, events"
```

---

### Task 4: Auth middleware

**Files:**
- Create: `src/auth.ts`

- [ ] **Step 1: Create src/auth.ts**

```typescript
import { getAgentByToken, touchAgent } from './db.js';
import type { Agent } from './models.js';

/**
 * Extract agent from Bearer token.
 * Returns the agent if valid, null otherwise.
 * Also updates last_seen timestamp.
 */
export function authenticateToken(authHeader: string | undefined): Agent | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;

  const agent = getAgentByToken(match[1]);
  if (!agent) return null;

  touchAgent(agent.id);
  return agent;
}
```

- [ ] **Step 2: Build and commit**

```bash
npx tsc
git add src/auth.ts
git commit -m "feat: token-based auth middleware"
```

---

### Task 5: Tool handlers — hive.start

**Files:**
- Create: `src/tools/start.ts`

- [ ] **Step 1: Create src/tools/start.ts**

```typescript
import { createAgent, getLobby, createRoom, appendEvent, getEvents } from '../db.js';
import type { RoomEvent } from '../models.js';

interface StartInput {
  name?: string;
  roles?: string;
  tool?: string;
  expertise?: string;
}

interface StartOutput {
  agent_id: string;
  token: string;
  display_name: string;
  lobby_room_id: string;
  pending: RoomEvent[];
}

// Random display name generator
const ADJECTIVES = ['Swift', 'Calm', 'Bold', 'Keen', 'Warm', 'Wise', 'Fair', 'True', 'Deft', 'Glad'];
const NOUNS = ['Paw', 'Claw', 'Tail', 'Fang', 'Mane', 'Wing', 'Reef', 'Peak', 'Glen', 'Vale'];

function randomDisplayName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
}

export function handleStart(input: StartInput): StartOutput {
  const displayName = input.name || randomDisplayName();
  const agent = createAgent(
    displayName,
    input.tool ?? '',
    input.roles ?? '',
    input.expertise ?? '',
  );

  // Find or create lobby
  let lobby = getLobby();
  if (!lobby) {
    lobby = createRoom('lobby', null, 'Lobby');
  }

  // Join lobby
  appendEvent(lobby.id, 'join', agent.id, { display_name: agent.display_name });

  // Get pending events in lobby (last 20)
  const pending = getEvents(lobby.id, 0, 20);

  return {
    agent_id: agent.id,
    token: agent.token,
    display_name: agent.display_name,
    lobby_room_id: lobby.id,
    pending,
  };
}
```

- [ ] **Step 2: Build and commit**

```bash
npx tsc
git add src/tools/start.ts
git commit -m "feat: hive.start tool — agent registration + lobby join"
```

---

### Task 6: Tool handlers — hive.dm

**Files:**
- Create: `src/tools/dm.ts`

- [ ] **Step 1: Create src/tools/dm.ts**

```typescript
import { getAgentById, getAgentByName, findDMRoom, createRoom, appendEvent } from '../db.js';

interface DMInput {
  to: string;
  content: string;
}

interface DMOutput {
  room_id: string;
  event_id: number;
}

export function handleDM(actorId: string, input: DMInput): DMOutput {
  // Resolve target agent
  const target = getAgentById(input.to) || getAgentByName(input.to);
  if (!target) {
    throw new Error(`Agent not found: ${input.to}`);
  }
  if (target.id === actorId) {
    throw new Error('Cannot DM yourself');
  }

  // Find or create DM room
  let room = findDMRoom(actorId, target.id);
  if (!room) {
    room = createRoom('dm', actorId, `DM: ${actorId} ↔ ${target.display_name}`);
    appendEvent(room.id, 'join', actorId);
    appendEvent(room.id, 'join', target.id);
  }

  // Post message
  const event = appendEvent(room.id, 'message', actorId, { content: input.content });

  return { room_id: room.id, event_id: event.id };
}
```

- [ ] **Step 2: Build and commit**

```bash
npx tsc
git add src/tools/dm.ts
git commit -m "feat: hive.dm tool — find/create DM room + post message"
```

---

### Task 7: Tool handlers — hive.task + hive.check

**Files:**
- Create: `src/tools/task.ts`

- [ ] **Step 1: Create src/tools/task.ts**

```typescript
import {
  getAgentById, getAgentByName, findAgentByRole,
  createRoom, appendEvent, getTaskEvents, getRoomById,
} from '../db.js';
import { ulid } from '../utils.js';
import { deriveTaskState } from '../state-machine.js';
import type { RoomEvent, TaskState } from '../models.js';

interface TaskInput {
  to?: string;
  title: string;
  input?: object;
}

interface TaskOutput {
  room_id: string;
  task_id: string;
  state: TaskState;
  assignee?: { id: string; display_name: string };
}

export function handleTask(actorId: string, input: TaskInput): TaskOutput {
  let assignee: { id: string; display_name: string } | undefined;

  // Resolve assignee
  if (input.to) {
    if (input.to.startsWith('role:')) {
      const role = input.to.slice(5);
      const agent = findAgentByRole(role);
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    } else {
      const agent = getAgentById(input.to) || getAgentByName(input.to);
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    }
  }

  const taskId = ulid();
  const room = createRoom('task', actorId, input.title, undefined, {
    task_id: taskId,
    title: input.title,
    input: input.input,
  });

  // Join creator
  appendEvent(room.id, 'join', actorId);

  // Task-start event
  appendEvent(room.id, 'task-start', actorId, {
    task_id: taskId,
    title: input.title,
    input: input.input,
    assignee_agent_id: assignee?.id ?? null,
  });

  let state: TaskState = 'submitted';

  // Auto-claim if assignee is known
  if (assignee) {
    appendEvent(room.id, 'join', assignee.id);
    appendEvent(room.id, 'task-claim', assignee.id, { task_id: taskId });
    state = 'working';
  }

  return { room_id: room.id, task_id: taskId, state, assignee };
}

// --- hive.check ---

interface CheckInput {
  task_id: string;
}

interface CheckOutput {
  task_id: string;
  state: TaskState;
  room_id: string;
  recent_events: RoomEvent[];
  assignee?: { id: string; display_name: string };
}

export function handleCheck(input: CheckInput): CheckOutput {
  const events = getTaskEvents(input.task_id);
  if (events.length === 0) {
    throw new Error(`Task not found: ${input.task_id}`);
  }

  const state = deriveTaskState(events);
  const roomId = events[0].room_id;

  // Find assignee from task-claim event
  let assignee: { id: string; display_name: string } | undefined;
  const claimEvent = events.find(e => e.type === 'task-claim');
  if (claimEvent?.actor_agent_id) {
    const agent = getAgentById(claimEvent.actor_agent_id);
    if (agent) assignee = { id: agent.id, display_name: agent.display_name };
  }

  return {
    task_id: input.task_id,
    state,
    room_id: roomId,
    recent_events: events.slice(-10),
    assignee,
  };
}
```

- [ ] **Step 2: Build and commit**

```bash
npx tsc
git add src/tools/task.ts
git commit -m "feat: hive.task + hive.check — task creation, role matching, state derivation"
```

---

### Task 8: Tool handlers — hive.room.*

**Files:**
- Create: `src/tools/room.ts`

- [ ] **Step 1: Create src/tools/room.ts**

```typescript
import {
  getRoomById, getEvents, appendEvent, isMember,
  getAgentRooms, getRoomMembers, getAgentById,
} from '../db.js';
import { nextState, isTaskEvent, deriveTaskState } from '../state-machine.js';
import type { Agent, Room, RoomEvent, EventType, TaskState } from '../models.js';

// --- hive.room.post ---

interface PostInput {
  room_id: string;
  type: EventType;
  content?: string;
  task_id?: string;
  task?: object;
}

interface PostOutput {
  event_id: number;
  seq: number;
}

export function handlePost(actorId: string, input: PostInput): PostOutput {
  const room = getRoomById(input.room_id);
  if (!room) throw new Error(`Room not found: ${input.room_id}`);
  if (!isMember(input.room_id, actorId)) throw new Error('Not a member of this room');
  if (room.closed_at) throw new Error('Room is closed');

  // Validate task state transition if task event
  if (isTaskEvent(input.type) && input.task_id) {
    const taskEvents = getEvents(input.room_id, 0, 10000)
      .filter(e => {
        try {
          const p = JSON.parse(e.payload_json);
          return p.task_id === input.task_id;
        } catch { return false; }
      });
    const currentState = taskEvents.length > 0 ? deriveTaskState(taskEvents) : null;
    const next = nextState(currentState, input.type);
    if (!next) {
      throw new Error(`Invalid task transition: ${currentState} + ${input.type}`);
    }
  }

  const payload: Record<string, unknown> = {};
  if (input.content) payload.content = input.content;
  if (input.task_id) payload.task_id = input.task_id;
  if (input.task) Object.assign(payload, input.task);

  const event = appendEvent(input.room_id, input.type, actorId, payload);

  return { event_id: event.id, seq: event.seq };
}

// --- hive.room.events ---

interface EventsInput {
  room_id: string;
  since?: number;
  limit?: number;
}

interface EventsOutput {
  events: RoomEvent[];
  has_more: boolean;
}

export function handleEvents(actorId: string, input: EventsInput): EventsOutput {
  if (!isMember(input.room_id, actorId)) throw new Error('Not a member of this room');

  const limit = Math.min(input.limit ?? 50, 200);
  const events = getEvents(input.room_id, input.since ?? 0, limit + 1);
  const hasMore = events.length > limit;
  if (hasMore) events.pop();

  return { events, has_more: hasMore };
}

// --- hive.room.list ---

interface ListInput {
  kind?: string;
  active_only?: boolean;
}

interface RoomSummary {
  id: string;
  name: string | null;
  kind: string;
  member_count: number;
  last_event_ts: string | null;
}

export function handleList(actorId: string, input: ListInput): { rooms: RoomSummary[] } {
  const rooms = getAgentRooms(actorId, input.kind, input.active_only ?? true);

  const summaries: RoomSummary[] = rooms.map(r => {
    const members = getRoomMembers(r.id);
    const lastEvents = getEvents(r.id, 0, 1);
    // Get the actual last event by getting events with high since
    const allEvents = getEvents(r.id, 0, 10000);
    const lastTs = allEvents.length > 0 ? allEvents[allEvents.length - 1].ts : null;

    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      member_count: members.length,
      last_event_ts: lastTs,
    };
  });

  return { rooms: summaries };
}

// --- hive.room.info ---

interface InfoInput {
  room_id: string;
}

interface InfoOutput {
  room: Room;
  members: Array<{ id: string; display_name: string; status: string }>;
  latest_events: RoomEvent[];
  task_state?: TaskState;
}

export function handleInfo(actorId: string, input: InfoInput): InfoOutput {
  const room = getRoomById(input.room_id);
  if (!room) throw new Error(`Room not found: ${input.room_id}`);
  if (!isMember(input.room_id, actorId)) throw new Error('Not a member of this room');

  const memberIds = getRoomMembers(input.room_id);
  const members = memberIds.map(id => {
    const agent = getAgentById(id);
    return {
      id,
      display_name: agent?.display_name ?? 'Unknown',
      status: agent?.status ?? 'offline',
    };
  });

  const allEvents = getEvents(input.room_id, 0, 10000);
  const latestEvents = allEvents.slice(-10);

  // Derive task state if task room
  let taskState: TaskState | undefined;
  if (room.kind === 'task') {
    const taskEvents = allEvents.filter(e => isTaskEvent(e.type as EventType));
    if (taskEvents.length > 0) taskState = deriveTaskState(taskEvents);
  }

  return { room, members, latest_events: latestEvents, task_state: taskState };
}
```

- [ ] **Step 2: Build and commit**

```bash
npx tsc
git add src/tools/room.ts
git commit -m "feat: hive.room.post/events/list/info — room interaction tools"
```

---

### Task 9: MCP server with Streamable HTTP

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create src/server.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { authenticateToken } from './auth.js';
import { initDB } from './db.js';
import { handleStart } from './tools/start.js';
import { handleDM } from './tools/dm.js';
import { handleTask, handleCheck } from './tools/task.js';
import { handlePost, handleEvents, handleList, handleInfo } from './tools/room.js';
import { EVENT_TYPES } from './models.js';
import type { Agent } from './models.js';

// Store agent context per transport session
const sessionAgents = new Map<string, Agent>();

export async function startServer(port: number, dbPath?: string): Promise<void> {
  initDB(dbPath);

  const mcp = new McpServer({
    name: 'kitty-hive',
    version: '0.1.0',
  });

  // --- Register tools ---

  mcp.tool(
    'hive.start',
    'Register as an agent and join the lobby. Returns your token for subsequent requests.',
    {
      name: { type: 'string', description: 'Display name (random if omitted)' },
      roles: { type: 'string', description: 'Comma-separated roles: ux,frontend,backend' },
      tool: { type: 'string', description: 'Agent tool: claude, codex, shell' },
      expertise: { type: 'string', description: 'Free-text expertise description' },
    },
    async (params) => {
      const result = handleStart(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.dm',
    'Send a direct message to another agent. Auto-creates a DM room if needed.',
    {
      to: { type: 'string', description: 'Target agent ID or display name' },
      content: { type: 'string', description: 'Message content' },
    },
    async (params, extra) => {
      const agent = getSessionAgent(extra);
      if (!agent) return authError();
      const result = handleDM(agent.id, params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.task',
    'Create a task and delegate to an agent or role. Creates a task room with state tracking.',
    {
      to: { type: 'string', description: 'Target: agent ID, display name, or "role:ux"' },
      title: { type: 'string', description: 'Task title' },
      input: { type: 'object', description: 'Structured task input (optional)' },
    },
    async (params, extra) => {
      const agent = getSessionAgent(extra);
      if (!agent) return authError();
      const result = handleTask(agent.id, { to: params.to, title: params.title, input: params.input as object });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.check',
    'Check the current state of a task by task ID.',
    {
      task_id: { type: 'string', description: 'Task ID to check' },
    },
    async (params) => {
      const result = handleCheck(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.room.post',
    'Post an event to a room (message, task update, etc.).',
    {
      room_id: { type: 'string', description: 'Room ID' },
      type: {
        type: 'string',
        description: `Event type: ${EVENT_TYPES.join(', ')}`,
      },
      content: { type: 'string', description: 'Message content (for type=message)' },
      task_id: { type: 'string', description: 'Task ID (for task-* event types)' },
    },
    async (params, extra) => {
      const agent = getSessionAgent(extra);
      if (!agent) return authError();
      const result = handlePost(agent.id, {
        room_id: params.room_id,
        type: params.type as any,
        content: params.content,
        task_id: params.task_id,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.room.events',
    'Fetch events from a room. Use "since" for incremental polling.',
    {
      room_id: { type: 'string', description: 'Room ID' },
      since: { type: 'number', description: 'Return events after this seq number' },
      limit: { type: 'number', description: 'Max events to return (default 50, max 200)' },
    },
    async (params, extra) => {
      const agent = getSessionAgent(extra);
      if (!agent) return authError();
      const result = handleEvents(agent.id, {
        room_id: params.room_id,
        since: params.since,
        limit: params.limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.room.list',
    'List rooms you are a member of.',
    {
      kind: { type: 'string', description: 'Filter by room kind: dm, team, task, project, lobby' },
      active_only: { type: 'boolean', description: 'Only show active (non-closed) rooms (default true)' },
    },
    async (params, extra) => {
      const agent = getSessionAgent(extra);
      if (!agent) return authError();
      const result = handleList(agent.id, {
        kind: params.kind,
        active_only: params.active_only,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.room.info',
    'Get detailed information about a room including members and recent events.',
    {
      room_id: { type: 'string', description: 'Room ID' },
    },
    async (params, extra) => {
      const agent = getSessionAgent(extra);
      if (!agent) return authError();
      const result = handleInfo(agent.id, params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --- HTTP server ---

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      return;
    }

    // Collect body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();

    // Parse JSON-RPC to check if this is hive.start (no auth needed)
    let isStartCall = false;
    try {
      const parsed = JSON.parse(body);
      if (parsed.method === 'tools/call' && parsed.params?.name === 'hive.start') {
        isStartCall = true;
      }
    } catch { /* not JSON or not tools/call */ }

    // Auth check (skip for hive.start and for initialize/list requests)
    if (!isStartCall) {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const agent = authenticateToken(authHeader);
        if (agent) {
          // Store for tool handlers to access
          // We'll use a request-scoped approach via transport session
        }
      }
    }

    // Create transport per request for stateless mode
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.setHeader('Content-Type', 'application/json');

    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(port, () => {
    console.log(`🐝 kitty-hive listening on http://localhost:${port}/mcp`);
    console.log(`   Database: ${dbPath || '~/.kitty-hive/hive.db'}`);
  });
}

// --- Helpers ---

function getSessionAgent(extra: any): Agent | null {
  // In stateless HTTP mode, extract from auth header
  // The MCP SDK passes transport context in extra
  // For MVP, we extract token from the transport's request headers
  try {
    const authHeader = extra?.authInfo?.token || extra?.requestContext?.headers?.authorization;
    if (authHeader) {
      return authenticateToken(typeof authHeader === 'string' ? authHeader : undefined);
    }
  } catch { /* ignore */ }
  return null;
}

function authError() {
  return {
    content: [{ type: 'text' as const, text: 'Error: Not authenticated. Call hive.start first to get a token, then pass it as Bearer token.' }],
    isError: true,
  };
}
```

- [ ] **Step 2: Update src/index.ts to call startServer**

```typescript
#!/usr/bin/env node

import { startServer } from './server.js';

const args = process.argv.slice(2);
const command = args[0];

if (command !== 'serve') {
  console.log('Usage: kitty-hive serve [--port 4100] [--db path]');
  console.log('');
  console.log('Options:');
  console.log('  --port, -p  Port to listen on (default: 4100)');
  console.log('  --db        SQLite database path (default: ~/.kitty-hive/hive.db)');
  process.exit(0);
}

let port = 4100;
let dbPath: string | undefined;

for (let i = 1; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--db' && args[i + 1]) {
    dbPath = args[i + 1];
    i++;
  }
}

startServer(port, dbPath).catch((err) => {
  console.error('Failed to start kitty-hive:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Build**

```bash
npx tsc
```

- [ ] **Step 4: Test server starts**

```bash
node dist/index.js serve --port 4100
```

Expected: `🐝 kitty-hive listening on http://localhost:4100/mcp`

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/index.ts
git commit -m "feat: MCP Streamable HTTP server with all 8 tools"
```

---

### Task 10: End-to-end manual verification

**Files:** none (testing only)

- [ ] **Step 1: Start the server**

```bash
cd ~/ai-workspace/kitty-hive
node dist/index.js serve
```

- [ ] **Step 2: Add hive MCP to a Claude Code session**

```bash
claude mcp add --transport http hive http://localhost:4100/mcp
```

- [ ] **Step 3: In Claude Code, test hive.start**

Ask Claude to call `hive.start({name: "TestAgent", roles: "ux,frontend"})`. Should return agent_id, token, lobby_room_id.

- [ ] **Step 4: Open a second Claude Code session and register**

```bash
claude mcp add --transport http hive http://localhost:4100/mcp
```

Ask Claude to call `hive.start({name: "BackendBot", roles: "backend"})`.

- [ ] **Step 5: Test DM between agents**

In session A: `hive.dm({to: "BackendBot", content: "你好，帮我看个接口"})`.
In session B: `hive.room.events({room_id: <dm_room_id>})` — should see the message.

- [ ] **Step 6: Test task delegation**

In session A: `hive.task({to: "role:backend", title: "实现登录 API"})`.
Check session B received the task: `hive.room.list({kind: "task"})` → should see the task room.

- [ ] **Step 7: Test task lifecycle**

In session B:
- `hive.room.post({room_id: <task_room>, type: "task-update", task_id: <id>, content: "正在写代码"})`
- `hive.room.post({room_id: <task_room>, type: "task-complete", task_id: <id>, content: "搞定了"})`

In session A: `hive.check({task_id: <id>})` → state should be "completed".

- [ ] **Step 8: Commit final state and create README**

```bash
git add -A
git commit -m "docs: add README with usage instructions"
```

---

### Task 11: Create Apple Reminders for development milestones

- [ ] **Step 1: Create reminders for each milestone**

Use the remind skill to add items to Apple Reminders:
- "kitty-hive: Task 1-2 完成（项目脚手架 + 类型）"
- "kitty-hive: Task 3-4 完成（数据库层 + 鉴权）"
- "kitty-hive: Task 5-7 完成（start/dm/task 工具）"
- "kitty-hive: Task 8-9 完成（room 工具 + HTTP server）"
- "kitty-hive: Task 10 完成（端到端验证通过）"
