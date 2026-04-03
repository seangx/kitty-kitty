# 通信系统重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 kitty-talk 从 Group 协作开关控制改为全局注入，实现任意 session 间点对点通信。

**Architecture:** session-mcp-manager 统一注入 kitty-session + kitty-talk。server-script 中的 talk/peers/findTarget 去掉 GROUP_ID 硬性限制，peers 默认按组过滤、支持 --all。collab-manager 简化为 InboxWatcher 管理 + 运行时脚本维护。

**Tech Stack:** Electron IPC, Node.js MCP server script, tmux, file-based message bus

---

### Task 1: server-script.ts — talk 去掉 GROUP_ID 限制 + 组播 + 冲突处理

**Files:**
- Modify: `src/main/mcp/server-script.ts`

- [ ] **Step 1: 修改 findTargetEntry 去掉 GROUP_ID 过滤**

将 `findTargetEntry` 函数中的 `v.groupId !== GROUP_ID` 条件移除，改为搜索全部 agents：

```javascript
function findTargetEntry(agents, targetKey) {
  const wanted = String(targetKey || '').toLowerCase();
  return Object.entries(agents).find(([id, v]) => {
    if (!v) return false;
    return String(v.name || '').toLowerCase() === wanted || String(id || '').toLowerCase() === wanted;
  });
}
```

- [ ] **Step 2: 修改 talk handler 添加同名冲突处理**

在 `handleToolCall` 的 `talk` case 中，将 `findTargetEntry` 替换为支持冲突检测的逻辑：

```javascript
case 'talk': {
  const { to, message, done } = args;
  const agents = readAgents();
  const targetKey = normalizeTarget(String(to || ''));
  const messageText = String(message || '').trim();
  if (!targetKey) {
    return { content: [{ type: 'text', text: 'Missing target. Use talk({ to: "@name", message: "..." }).' }], isError: true };
  }
  if (!messageText) {
    return { content: [{ type: 'text', text: 'Missing message body.' }], isError: true };
  }

  // Check for @groupName broadcast
  if (targetKey.startsWith('@')) {
    const groupName = targetKey.slice(1);
    return handleGroupBroadcast(agents, groupName, messageText, done);
  }

  const matches = findAllMatches(agents, targetKey);
  if (matches.length === 0) {
    return { content: [{ type: 'text', text: 'Agent "' + to + '" not found. Use peers() to see available agents.' }], isError: true };
  }
  if (matches.length > 1) {
    const list = matches.map(([id, v]) => v.name + ' [' + id + '] (cwd: ' + (v.cwd || 'unknown') + ')').join('\\n');
    return { content: [{ type: 'text', text: 'Multiple agents match "' + to + '". Please specify by id:\\n' + list }] };
  }
  const [targetId, targetV] = matches[0];
  const targetName = targetV.name || targetId;
  const targetInbox = path.join(BUS_DIR, targetId + '.inbox.jsonl');
  const msg = JSON.stringify({ from: AGENT_NAME, fromId: AGENT_ID, message: messageText, done: !!done, ts: Date.now() }) + '\\n';
  fs.appendFileSync(targetInbox, msg);
  return { content: [{ type: 'text', text: 'Delivered to ' + targetName + ' [' + targetId + ']' + (done ? ' (marked as done)' : '') }] };
}
```

- [ ] **Step 3: 添加 findAllMatches 和 handleGroupBroadcast 函数**

```javascript
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
```

- [ ] **Step 4: 修改 registerAgent 添加元信息**

```javascript
function registerAgent() {
  let agents = {};
  try { agents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8')); } catch {}
  agents[AGENT_ID] = {
    id: AGENT_ID,
    name: AGENT_NAME,
    groupId: GROUP_ID,
    groupName: process.env.KITTY_GROUP_NAME || '',
    tool: process.env.KITTY_TOOL || '',
    cwd: process.env.KITTY_CWD || '',
    lastSeen: Date.now()
  };
  fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
}
```

- [ ] **Step 5: 修改 parseSlashTalk 和 buildSlashTargetSuggestions 去掉 GROUP_ID 过滤**

在 `parseSlashTalk` 中，将 `if (id === AGENT_ID || !v || v.groupId !== GROUP_ID) continue;` 改为 `if (id === AGENT_ID || !v) continue;`。

在 `buildSlashTargetSuggestions` 中，将 `.filter(([id, v]) => id !== AGENT_ID && v && v.groupId === GROUP_ID)` 改为 `.filter(([id, v]) => id !== AGENT_ID && v)`。

- [ ] **Step 6: 构建验证**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 7: 提交**

```bash
git add src/main/mcp/server-script.ts
git commit -m "refactor: talk/peers remove GROUP_ID restriction, add broadcast and conflict handling"
```

---

### Task 2: server-script.ts — peers 默认同组 + --all + 元信息

**Files:**
- Modify: `src/main/mcp/server-script.ts`

- [ ] **Step 1: 修改 peers tool schema 添加 --all 参数**

```javascript
{
  name: 'peers',
  description: 'List available agents. By default lists agents in your group. Use all=true to list all agents.',
  inputSchema: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: 'List all agents across all groups', default: false }
    },
    additionalProperties: false
  }
},
```

- [ ] **Step 2: 修改 peers handler**

```javascript
case 'peers': {
  const agents = readAgents();
  const showAll = Boolean(args?.all);
  const entries = Object.entries(agents)
    .filter(([id, v]) => id !== AGENT_ID && v)
    .filter(([id, v]) => showAll || !GROUP_ID || GROUP_ID === '__ungrouped__' || v.groupId === GROUP_ID);

  if (entries.length === 0) {
    const hint = showAll ? 'No other agents online.' : 'No agents in your group. Try peers({ all: true }) to see all agents.';
    return { content: [{ type: 'text', text: hint }] };
  }

  // Group by groupName for display
  const byGroup = new Map();
  for (const [id, v] of entries) {
    const gName = v.groupName || v.groupId || 'ungrouped';
    if (!byGroup.has(gName)) byGroup.set(gName, []);
    byGroup.get(gName).push([id, v]);
  }

  let output = '';
  for (const [gName, members] of byGroup) {
    if (showAll && byGroup.size > 1) output += '── ' + gName + ' ──\\n';
    for (const [id, v] of members) {
      const ago = Math.round((Date.now() - (v.lastSeen || 0)) / 1000);
      const label = ago < 60 ? 'active' : ago < 300 ? Math.round(ago / 60) + 'm ago' : 'idle';
      const meta = [v.tool ? 'tool: ' + v.tool : '', v.cwd ? 'cwd: ' + v.cwd : ''].filter(Boolean).join(', ');
      output += v.name + ' [' + id + '] (' + (meta ? meta + ', ' : '') + label + ')\\n';
    }
  }
  output += '\\nMessages are queued — you can send to any agent even if they appear idle.';
  return { content: [{ type: 'text', text: output.trim() }] };
}
```

- [ ] **Step 3: 修改 slash handler 支持 /@peers --all**

在 `case 'slash'` 中，将 `if (raw === '/@peers') return handleToolCall('peers', {});` 改为：

```javascript
if (raw === '/@peers') return handleToolCall('peers', {});
if (raw === '/@peers --all' || raw === '/@peers -a') return handleToolCall('peers', { all: true });
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add src/main/mcp/server-script.ts
git commit -m "feat: peers default to group view, support --all with metadata"
```

---

### Task 3: session-mcp-manager.ts — 统一注入 kitty-talk + kitty-session

**Files:**
- Modify: `src/main/mcp/session-mcp-manager.ts`
- Modify: `src/main/mcp/collab-manager.ts`（读取 ensureRuntimeArtifacts）

- [ ] **Step 1: 给 injectSessionMcp 添加 kitty-talk 注入**

修改 `injectSessionMcp` 函数，在注入 kitty-session 的同时注入 kitty-talk：

```typescript
export function injectSessionMcp(
  sessionId: string,
  cwd: string,
  tmuxName: string,
  sessionTitle: string,
  groupId?: string,
  groupName?: string,
  tool?: string
): void {
  if (!cwd) return
  if (injectedSessions.has(sessionId)) return

  try {
    const scriptPath = ensureScript()
    const nodePath = resolveNodePath()
    const configPath = join(cwd, '.mcp.json')

    let config: any = {}
    try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
    if (!config.mcpServers) config.mcpServers = {}

    // kitty-session (pane management)
    config.mcpServers['kitty-session'] = {
      command: nodePath,
      args: [scriptPath],
      env: {
        KITTY_AGENT_ID: sessionId,
        KITTY_TMUX_NAME: tmuxName,
        KITTY_PROJECT_ROOT: cwd,
        KITTY_IS_GIT_REPO: isGitRepo(cwd) ? '1' : '0',
      }
    }

    // kitty-talk (communication)
    const { ensureRuntimeArtifacts } = require('./collab-manager')
    const { scriptPath: talkScriptPath, busDir } = ensureRuntimeArtifacts()
    config.mcpServers['kitty-talk'] = {
      command: nodePath,
      args: [talkScriptPath],
      env: {
        KITTY_AGENT_ID: sessionId,
        KITTY_AGENT_NAME: sessionTitle,
        KITTY_BUS_DIR: busDir,
        KITTY_GROUP_ID: groupId || '',
        KITTY_GROUP_NAME: groupName || '',
        KITTY_TOOL: tool || '',
        KITTY_CWD: cwd,
      }
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2))
    injectedSessions.add(sessionId)
    log('session-mcp', `injected session=${sessionId} cwd=${cwd}`)
  } catch (err) {
    log('session-mcp', `inject failed session=${sessionId}:`, err)
  }
}
```

- [ ] **Step 2: 添加 updateGroupId 函数**

用于 session 加入/退出 Group 时更新 .mcp.json 中的 GROUP_ID，不重启 agent：

```typescript
export function updateGroupId(sessionId: string, cwd: string, groupId: string, groupName: string): void {
  if (!cwd) return
  try {
    const configPath = join(cwd, '.mcp.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (config?.mcpServers?.['kitty-talk']?.env) {
      config.mcpServers['kitty-talk'].env.KITTY_GROUP_ID = groupId || ''
      config.mcpServers['kitty-talk'].env.KITTY_GROUP_NAME = groupName || ''
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      log('session-mcp', `updated groupId=${groupId} for session=${sessionId}`)
    }
  } catch (err) {
    log('session-mcp', `updateGroupId failed session=${sessionId}:`, err)
  }
}
```

- [ ] **Step 3: 修改 removeSessionMcp 同时清除 kitty-talk**

```typescript
export function removeSessionMcp(sessionId: string, cwd: string): void {
  if (!cwd) return
  try {
    const configPath = join(cwd, '.mcp.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    delete config?.mcpServers?.['kitty-session']
    delete config?.mcpServers?.['kitty-talk']
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      unlinkSync(configPath)
    } else {
      writeFileSync(configPath, JSON.stringify(config, null, 2))
    }
  } catch { /* ignore */ }
  injectedSessions.delete(sessionId)
}
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add src/main/mcp/session-mcp-manager.ts
git commit -m "feat: inject kitty-talk alongside kitty-session for all sessions"
```

---

### Task 4: session-handlers.ts — 更新注入调用 + 简化 Group 协作逻辑

**Files:**
- Modify: `src/main/ipc/session-handlers.ts`

- [ ] **Step 1: 更新所有 injectSessionMcp 调用，传入新参数**

在 `session:create`、`session:create-in-dir-confirm`、`session:create-worktree`、`syncAndList` 中，将：
```typescript
sessionMcp.injectSessionMcp(session.id, session.cwd, session.tmuxName)
```
改为：
```typescript
const group = session.groupId ? sessionRepo.getGroupById(session.groupId) : undefined
sessionMcp.injectSessionMcp(session.id, session.cwd, session.tmuxName, session.title, session.groupId || '', group?.name || '', session.tool)
```

- [ ] **Step 2: 修改 session:set-group handler**

加入/退出 Group 时调用 `updateGroupId` 而非 `startCollaboration`/`stopCollaboration`：

```typescript
ipcMain.handle('session:set-group', (_event, sessionId: string, groupId: string | null) => {
  const rows = sessionRepo.listSessions()
  const session = rows.find((s) => s.id === sessionId)
  if (!session) throw new Error('Session not found')

  sessionRepo.updateSessionGroup(sessionId, groupId)

  const nextGroup = groupId ? sessionRepo.getGroupById(groupId) : undefined
  sessionMcp.updateGroupId(sessionId, session.cwd, groupId || '', nextGroup?.name || '')
})
```

- [ ] **Step 3: 移除 group:collab:set-enabled handler**

将 `ipcMain.handle('group:collab:set-enabled', ...)` 整个块删除。

- [ ] **Step 4: 移除 collab:start 和 collab:stop handlers**

将 `ipcMain.handle('collab:start', ...)` 和 `ipcMain.handle('collab:stop', ...)` 整个块删除。

- [ ] **Step 5: 移除 collab:status handler 中的 collabEnabled 依赖**

将 `collab:status` handler 简化：session 有 kitty-talk 就是 active。

- [ ] **Step 6: 简化 syncAndList 中的 collab rehydration**

将首次 sync 中的 collab rehydration 逻辑（L551-563）替换为：所有有 cwd 的 session 都注入 kitty-talk（已通过 injectSessionMcp 覆盖），启动 InboxWatcher：

```typescript
// Start inbox watcher for all live sessions
for (const row of sessionRepo.listSessions()) {
  if (liveNames.has(row.tmuxName) && row.cwd) {
    const group = row.groupId ? sessionRepo.getGroupById(row.groupId) : undefined
    sessionMcp.injectSessionMcp(row.id, row.cwd, row.tmuxName, row.title, row.groupId || '', group?.name || '', row.tool)
    collab.watchInbox(row.id, row.tmuxName, row.tool)
  }
}
```

- [ ] **Step 7: 修改 session:set-tool handler 中的 collab 逻辑**

将 set-tool 中的 `startCollaboration`/`stopCollaboration` 调用替换为重新注入 + InboxWatcher 更新。

- [ ] **Step 8: 构建验证**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 9: 提交**

```bash
git add src/main/ipc/session-handlers.ts
git commit -m "refactor: session handlers use unified injection, remove collab toggle"
```

---

### Task 5: collab-manager.ts — 简化为 InboxWatcher 管理

**Files:**
- Modify: `src/main/mcp/collab-manager.ts`

- [ ] **Step 1: 导出 watchInbox 和 unwatchInbox 函数**

```typescript
export function watchInbox(sessionId: string, tmuxName: string, tool: string): void {
  getInboxWatcher().watch(sessionId, tmuxName, tool)
}

export function unwatchInbox(sessionId: string): void {
  getInboxWatcher().unwatch(sessionId)
}
```

- [ ] **Step 2: 保留 ensureRuntimeArtifacts 和 cleanupAll**

这两个函数被 session-mcp-manager 和 index.ts 使用，保持不变。

- [ ] **Step 3: startCollaboration 和 stopCollaboration 标记 deprecated**

不立即删除（避免遗漏调用处报错），加注释标记 deprecated，后续清理：

```typescript
/** @deprecated Use session-mcp-manager.injectSessionMcp + collab.watchInbox instead */
export function startCollaboration(...) { ... }
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add src/main/mcp/collab-manager.ts
git commit -m "refactor: expose watchInbox/unwatchInbox, deprecate startCollaboration"
```

---

### Task 6: TagCloud.tsx — 去掉群聊开关

**Files:**
- Modify: `src/renderer/pet/TagCloud.tsx`

- [ ] **Step 1: 移除 groupCollabMap 状态和 handleToggleGroupCollab**

删除以下代码：
- `const [groupCollabMap, setGroupCollabMap] = useState<Record<string, boolean>>({})`
- `const handleToggleGroupCollab = ...`
- `loadGroups` 中设置 `groupCollabMap` 的逻辑

- [ ] **Step 2: 移除群聊开关按钮**

在 group header 行中，删除群聊开/关按钮：

```tsx
<button
  onClick={(e) => { e.stopPropagation(); handleToggleGroupCollab(groupId, !groupCollabMap[groupId]) }}
  ...
>
  {groupCollabMap[groupId] ? '群聊开' : '群聊关'}
</button>
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 4: 提交**

```bash
git add src/renderer/pet/TagCloud.tsx
git commit -m "ui: remove group collab toggle, all sessions have communication by default"
```

---

### Task 7: 集成验证

**Files:** 无新增

- [ ] **Step 1: 完整构建**

Run: `npm run build`
Expected: 全部通过

- [ ] **Step 2: 启动 dev 模式验证**

Run: `npm run dev`

验证：
1. 新建 session → 检查 `.mcp.json` 同时包含 `kitty-session` 和 `kitty-talk`
2. 不加 Group 的 session → 应有 kitty-talk（GROUP_ID 为空）
3. 加入 Group → `.mcp.json` 中 GROUP_ID 更新为 group id
4. Group header 行无「群聊开/关」按钮

- [ ] **Step 3: 提交最终状态**

```bash
git add -A
git commit -m "feat: communication redesign — global kitty-talk injection, group as default peers view"
```
