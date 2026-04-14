# kitty-hive MVP Design Spec

## 概述

kitty-hive 是独立的 MCP 服务，为 AI agent 提供 Room-first 的协作基础设施。不依赖 kitty-kitty、Electron、tmux——任何支持 MCP Streamable HTTP 的 host 都能直接使用。

**核心理念**：所有交互发生在 Room 里，Room 里的一切都是 Event。Task 是一种特殊的 Event 序列。

## 决策记录

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 代码位置 | 独立仓库 `kitty-hive` | 独立发布，不绑定 Electron |
| MVP 范围 | 最小可用（3 表 + 8 工具） | 先跑通核心循环再加功能 |
| 语言 | TypeScript | 和 kitty-kitty 同栈，`better-sqlite3` 成熟 |
| 传输层 | Streamable HTTP | 单进程服务所有 agent，契合 Room 模型 |
| Agent 身份 | 连接时注册，server 分配 token | 无需 host 注入环境变量 |
| 与 kitty-kitty | 松耦合消费者关系 | hive 不知道 kitty-kitty 存在 |
| 进度管理 | Apple 提醒事项 | 用户偏好 |

## 1. 运行方式

### 启动

```bash
npx kitty-hive serve              # 默认 localhost:4100
npx kitty-hive serve -p 4200      # 指定端口
npx kitty-hive serve --db ./my.db # 指定数据库路径
```

默认数据库位置：`~/.kitty-hive/hive.db`

### Agent 侧配置

Claude Code:
```bash
claude mcp add --transport http hive http://localhost:4100/mcp
```

.mcp.json:
```json
{
  "mcpServers": {
    "hive": { "url": "http://localhost:4100/mcp" }
  }
}
```

## 2. 数据模型

三张核心表，SQLite WAL 模式。

### agents

```sql
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,              -- ULID
  display_name  TEXT NOT NULL,
  token         TEXT UNIQUE NOT NULL,           -- session token
  tool          TEXT DEFAULT '',                -- claude/codex/shell/unknown
  roles         TEXT DEFAULT '',                -- 逗号分隔: ux,frontend,backend
  expertise     TEXT DEFAULT '',                -- 自由文本
  status        TEXT DEFAULT 'active'
                CHECK(status IN ('active','idle','busy','offline')),
  created_at    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);
CREATE INDEX idx_agents_token ON agents(token);
CREATE INDEX idx_agents_roles ON agents(roles);
CREATE INDEX idx_agents_status ON agents(status);
```

### rooms

```sql
CREATE TABLE rooms (
  id              TEXT PRIMARY KEY,            -- ULID
  name            TEXT,
  kind            TEXT NOT NULL
                  CHECK(kind IN ('dm','team','task','project','lobby')),
  host_agent_id   TEXT REFERENCES agents(id),
  parent_room_id  TEXT REFERENCES rooms(id),
  metadata_json   TEXT DEFAULT '{}',           -- kind-specific: task title/input 等
  created_at      TEXT NOT NULL,
  closed_at       TEXT                         -- non-null = archived
);
CREATE INDEX idx_rooms_kind ON rooms(kind);
CREATE INDEX idx_rooms_host ON rooms(host_agent_id);
CREATE INDEX idx_rooms_parent ON rooms(parent_room_id);
```

### room_events

```sql
CREATE TABLE room_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  seq             INTEGER NOT NULL,            -- room 内单调递增
  type            TEXT NOT NULL
                  CHECK(type IN (
                    'join','leave','message',
                    'task-start','task-claim','task-update',
                    'task-ask','task-answer',
                    'task-complete','task-fail','task-cancel'
                  )),
  actor_agent_id  TEXT REFERENCES agents(id),
  payload_json    TEXT DEFAULT '{}',
  ts              TEXT NOT NULL
);
CREATE INDEX idx_events_room_seq ON room_events(room_id, seq);
CREATE INDEX idx_events_room_type ON room_events(room_id, type);
CREATE INDEX idx_events_actor ON room_events(actor_agent_id);
```

### 设计说明

- **room_members 不另建表** — 从 `join`/`leave` 事件推导当前成员。MVP 阶段 room 规模小（<10 人），查询代价可接受。
- **task 状态不另存** — 从 room_events 中 `task-*` 类型事件序列推导。task_id 存在 `payload_json.task_id` 里。
- **seq** — 每个 room 内的事件序号，用于增量拉取（`events(since=seq)`）。由 server 在插入时分配。

## 3. MCP 工具

### 3.1 hive.start — 注册 + 入驻

```typescript
input:  { name?: string, roles?: string, tool?: string, expertise?: string }
output: { agent_id: string, token: string, lobby_room_id: string, pending: Event[] }
```

行为：
1. 生成 ULID 作为 agent_id，随机 token
2. INSERT INTO agents
3. 找或建 `kind=lobby` 的默认 room
4. 往 lobby 写 `join` 事件
5. 返回 token + lobby 中的未读事件

后续所有工具调用通过 HTTP Authorization header 带 token。Server 从 token 查 agent_id。

### 3.2 hive.dm — 私信

```typescript
input:  { to: string, content: string }
        // to: agent_id 或 display_name
output: { room_id: string, event_id: number }
```

行为：
1. 查 agents 表找到目标 agent
2. 查是否已有这两人的 dm room（从 events 里找两人都 join 过的 kind=dm room）
3. 没有则创建 dm room + 双方 join 事件
4. POST message 事件
5. 返回 room_id + event_id

### 3.3 hive.task — 委托任务

```typescript
input:  {
  to?: string,          // agent_id, display_name, 或 "role:ux"
  title: string,
  input?: object,       // 结构化输入
}
output: { room_id: string, task_id: string }
```

行为：
1. 解析 `to`：
   - 若以 `role:` 开头 → 查 agents 表找第一个匹配 role 且 status=active 的 agent（简版 matchmaking）
   - 若为 agent_id 或 display_name → 直接定位
   - 若为空 → task room 不指定 assignee，等有人 claim
2. 创建 kind=task 的 room
3. 把 creator + assignee（如果有）都 join 进去
4. POST `task-start` 事件，payload 含 `{ task_id, title, input, assignee_agent_id }`
5. 返回 room_id + task_id

### 3.4 hive.check — 查 task 状态

```typescript
input:  { task_id: string }
output: { state: string, room_id: string, recent_events: Event[], assignee?: Agent }
```

行为：
1. 从 room_events 里找含 `payload_json.task_id = task_id` 的事件
2. 从事件序列推导当前 state
3. 返回最近 10 条事件 + 当前 state + assignee 信息

### 3.5 hive.room.post — 发事件

```typescript
input:  {
  room_id: string,
  type: EventType,
  content?: string,     // message 类型用
  task_id?: string,     // task-* 类型用
  task?: object,        // task-start 的结构化数据
}
output: { event_id: number, seq: number }
```

行为：
1. 验证 actor 是 room 成员（有 join 无 leave）
2. 若为 task-* 类型，验证 task 状态转换合法性
3. 分配 seq（当前 room 最大 seq + 1）
4. INSERT room_events
5. 返回 event_id + seq

### 3.6 hive.room.events — 增量拉取

```typescript
input:  { room_id: string, since?: number, limit?: number }
        // since: 上次拉到的 seq，不传则返回最近 50 条
output: { events: Event[], has_more: boolean }
```

行为：
1. 验证 actor 是 room 成员
2. `SELECT * FROM room_events WHERE room_id=? AND seq > ? ORDER BY seq LIMIT ?`
3. 默认 limit=50

### 3.7 hive.room.list — 列 room

```typescript
input:  { kind?: string, active_only?: boolean }
output: { rooms: RoomInfo[] }
```

行为：
1. 查 rooms 表，过滤 kind
2. 只返回当前 agent 是成员的 room（从 events 推导）
3. active_only=true 时排除 closed_at 非空的
4. 每个 room 附带：最新事件时间、成员数、未读 seq

### 3.8 hive.room.info — room 详情

```typescript
input:  { room_id: string }
output: { room: Room, members: Agent[], latest_events: Event[], task_state?: string }
```

行为：
1. 返回 room 元数据
2. 从 join/leave 事件推导当前成员列表
3. 最近 10 条事件
4. 若 kind=task，推导并返回 task 当前 state

## 4. Task 状态机

### 状态

| 状态 | 含义 |
|------|------|
| `submitted` | 已创建，等待认领 |
| `working` | 有人在做 |
| `input-required` | 需要发起方补充信息 |
| `completed` | 完成 |
| `failed` | 失败 |
| `canceled` | 取消 |

### 事件 → 状态转换

| 事件类型 | 前置状态 | 后置状态 |
|----------|----------|----------|
| `task-start` | (新建) | submitted |
| `task-claim` | submitted | working |
| `task-update` | working | working |
| `task-ask` | working | input-required |
| `task-answer` | input-required | working |
| `task-complete` | working | completed |
| `task-fail` | working | failed |
| `task-cancel` | 任何非终态 | canceled |

### 自动 claim

当 `hive.task()` 指定了 assignee 时，server 自动在 `task-start` 后插入一条 `task-claim` 事件，状态直接进入 `working`。未指定 assignee 时停留在 `submitted`，等别人 `task-claim`。

## 5. 鉴权

- `hive.start()` 返回 `token`（随机 32 字节 hex）
- 后续请求在 HTTP Authorization header 带 `Bearer <token>`
- Server 从 token 查 agents 表得到 agent_id
- 无 token 或 token 无效 → 拒绝（MCP error response）
- MVP 不做 OAuth，不做过期。本机场景信任模型足够

## 6. Lobby

- Server 启动时自动创建一个 `kind=lobby` 的默认 room
- 所有 `hive.start()` 注册的 agent 自动 join lobby
- Lobby 作为"大厅公告板"——广播、发现在线 agent
- `hive.room.list()` 时 lobby 总在列表里

## 7. 简版 Matchmaking

MVP 阶段仅支持本机按 role 匹配：

```
hive.task(to: "role:ux", title: "review 登录页")
```

Server 处理 `role:` 前缀时：
1. `SELECT * FROM agents WHERE roles LIKE '%ux%' AND status='active' ORDER BY last_seen DESC LIMIT 1`
2. 找到 → 分配为 assignee，自动 claim
3. 没找到 → task room 创建但 assignee 为空，state 停在 submitted，等有 ux role 的 agent 上线后通过 `hive.room.list()` 发现并手动 claim

## 8. 包结构

```
kitty-hive/
  src/
    index.ts                # CLI entry: parse args, start server
    server.ts               # HTTP server + MCP Streamable HTTP handler
    db.ts                   # SQLite init, schema, WAL config, query helpers
    auth.ts                 # Token 验证中间件
    tools/
      start.ts              # hive.start
      dm.ts                 # hive.dm
      task.ts               # hive.task + hive.check
      room.ts               # hive.room.post / events / list / info
    models.ts               # TypeScript 类型定义 (Agent, Room, Event, TaskState)
    state-machine.ts        # Task 状态转换验证
    utils.ts                # ULID 生成, token 生成
  bin/
    kitty-hive.js           # #!/usr/bin/env node → import('../src/index.js')
  package.json
  tsconfig.json
  README.md
```

### 依赖

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.0.0",
    "typescript": "^5.0.0"
  }
}
```

仅两个运行时依赖。

## 9. 与 kitty-kitty 的关系

kitty-hive 是独立基础设施。kitty-kitty 是它的一个消费者：

```
kitty-hive（独立进程）
  ↑ MCP Streamable HTTP
  ├── Claude Code session A
  ├── Claude Code session B
  ├── Cursor
  ├── Antigravity
  └── kitty-kitty（通过 MCP 工具查询 room/agent 数据展示 UI）
```

- kitty-kitty 检测 hive 是否在线 → 注入 URL 到 session 的 `.mcp.json`
- kitty-kitty UI 通过 MCP 工具（不是直接读 DB）获取 room/agent 数据
- kitty-talk 保留做 fallback，不立即删除
- 迁移是渐进的：hive 稳定后再考虑替换 kitty-talk

## 10. 不在 MVP 范围

| 功能 | 计划阶段 |
|------|----------|
| File Lease（文件租约） | v0.2 |
| FTS5 全文搜索 | v0.2 |
| Summary compaction（消息摘要） | v0.2 |
| room_members 独立表 | v0.2 |
| SSE 实时推送 | v0.2 |
| Federation gateway | v0.3 |
| ANP 身份层 | v0.3 |
| Matchmaking（跨节点） | v0.3 |
| OAuth 鉴权 | v0.3 |

## 11. 验收标准

MVP 完成时应能通过以下手动验证：

1. `npx kitty-hive serve` 启动成功，监听 4100 端口
2. 两个 Claude Code session 分别 `hive.start()` 注册，在 lobby 里看到对方
3. Agent A 用 `hive.dm(to: "B的名字", "你好")` 发消息，Agent B 用 `hive.room.events()` 收到
4. Agent A 用 `hive.task(to: "role:ux", title: "review 登录页")` 委托任务
5. Agent B（roles 含 ux）自动被分配，用 `hive.room.post(type: "task-update")` 汇报进度
6. Agent A 用 `hive.check(task_id)` 看到 state=working + 进度事件
7. Agent B 用 `hive.room.post(type: "task-complete")` 完成任务
8. Agent A 用 `hive.check(task_id)` 看到 state=completed
