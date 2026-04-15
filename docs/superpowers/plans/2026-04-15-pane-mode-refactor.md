# Pane 模式重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 pane 模式的架构缺陷（pane ID 持久化、可靠匹配、原子操作），移除 kitty-talk，清理代码质量问题。

**Architecture:** sessions 表新增 `pane_id` 字段存储 tmux pane ID，所有 pane 操作改为精确匹配。迁移逻辑重写为原子操作（先 tmux 后 DB）。kitty-talk 相关的 collab-manager、inbox-watcher、server-script 全部移除，保留 session-mcp-manager（kitty-session 编排功能）。

**Tech Stack:** TypeScript, Electron IPC, tmux, SQLite, React

---

## File Structure

```
删除:
  src/main/mcp/collab-manager.ts     # kitty-talk 核心，整个删除
  src/main/mcp/inbox-watcher.ts      # kitty-talk inbox，整个删除
  src/main/mcp/server-script.ts      # kitty-talk MCP 脚本，整个删除

修改:
  src/main/db/database.ts            # sessions 表加 pane_id 列
  src/main/db/session-repo.ts        # 新增 updateSessionPaneId()
  src/main/tmux/session-manager.ts   # createPaneInSession 加 cwd 参数; 修复裸 tmux; 清理死代码
  src/main/ipc/session-handlers.ts   # 重写 pane 操作用 pane_id; 移除 collab 引用; 修复 require
  src/main/mcp/session-server-script.ts  # 移除 kitty-talk 注入
  src/main/mcp/session-mcp-manager.ts    # 移除 kitty-talk 相关调用
  src/main/index.ts                  # 移除 collab 启动/停止
```

---

### Task 1: sessions 表新增 pane_id + repo 方法

**Files:**
- Modify: `src/main/db/database.ts`
- Modify: `src/main/db/session-repo.ts`

- [ ] **Step 1: 在 database.ts 的 runMigrations 中新增 pane_id 列**

在现有 migration 末尾添加：

```typescript
    try {
      database.exec("ALTER TABLE sessions ADD COLUMN pane_id TEXT DEFAULT ''")
    } catch { /* column already exists */ }
```

- [ ] **Step 2: 在 session-repo.ts 中新增 updateSessionPaneId**

```typescript
export function updateSessionPaneId(id: string, paneId: string): void {
  const db = getDB()
  db.prepare("UPDATE sessions SET pane_id = ?, updated_at = datetime('now') WHERE id = ?").run(paneId, id)
}
```

- [ ] **Step 3: SessionRow 接口加 paneId**

在 `SessionRow` 中添加 `paneId: string`。

在 `listSessions()` 和 `listSessionsByGroup()` 的 SELECT 中添加 `s.pane_id as paneId`。

- [ ] **Step 4: shared 类型 SessionInfo 加 paneId**

在 `src/shared/types/session.ts` 的 `SessionInfo` 中添加 `paneId?: string`。

- [ ] **Step 5: Build 验证**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: sessions 表新增 pane_id 字段"
```

---

### Task 2: createPaneInSession 加 cwd 参数 + 返回 paneId 持久化

**Files:**
- Modify: `src/main/tmux/session-manager.ts`
- Modify: `src/main/ipc/session-handlers.ts`

- [ ] **Step 1: createPaneInSession 加 cwd 参数**

```typescript
export function createPaneInSession(tmuxName: string, command: string, isFirstSplit: boolean, cwd?: string): string {
  const cwdFlag = cwd ? `-c ${shellQuote(cwd)}` : ''
  let paneId: string
  if (isFirstSplit) {
    paneId = execSync(
      `${TMUX} split-window -t ${shellQuote(tmuxName)} -h -p 65 ${cwdFlag} -P -F '#{pane_id}' ${shellQuote(command)}`,
      { encoding: 'utf-8', env: { ...process.env, TERM: 'xterm-256color' } }
    ).trim()
  } else {
    const panes = execSync(
      `${TMUX} list-panes -t ${shellQuote(tmuxName)} -F '#{pane_id}'`,
      { encoding: 'utf-8' }
    ).trim().split('\n')
    const lastPane = panes[panes.length - 1]
    paneId = execSync(
      `${TMUX} split-window -t ${lastPane} -v ${cwdFlag} -P -F '#{pane_id}' ${shellQuote(command)}`,
      { encoding: 'utf-8', env: { ...process.env, TERM: 'xterm-256color' } }
    ).trim()
  }
  return paneId
}
```

- [ ] **Step 2: SESSION_CREATE_IN_GROUP 保存 paneId**

在 pane 模式分支中，`createPaneInSession` 返回的 paneId 保存到 DB：

```typescript
const paneId = tmux.createPaneInSession(hostTmuxName, script, isFirstSplit, freshCwd)
// ... 创建 session 记录后
sessionRepo.updateSessionPaneId(freshId, paneId)
```

- [ ] **Step 3: migrateToPane 中 join 后记录 paneId**

join-pane 后查询新 pane 的 ID 并存入 DB：

```typescript
tmux.joinSessionAsPane(other.tmuxName, mainSession.tmuxName, false)
// 查 join 后最新的 pane ID
const newPanes = execSync(
  `${tmux.TMUX} list-panes -t "${mainSession.tmuxName}" -F '#{pane_id}'`,
  { encoding: 'utf-8' }
).trim().split('\n')
const joinedPaneId = newPanes[newPanes.length - 1]
sessionRepo.updateSessionPaneId(other.id, joinedPaneId)
```

主 session 也记录自己的 pane_id（第一个 pane）：

```typescript
const mainPaneId = execSync(
  `${tmux.TMUX} list-panes -t "${mainSession.tmuxName}" -F '#{pane_id}'`,
  { encoding: 'utf-8' }
).trim().split('\n')[0]
sessionRepo.updateSessionPaneId(mainSession.id, mainPaneId)
```

- [ ] **Step 4: Build 验证 + Commit**

---

### Task 3: 所有 pane 操作改用 pane_id 精确匹配

**Files:**
- Modify: `src/main/ipc/session-handlers.ts`

将以下三处 `basename(cwd) + includes` 匹配替换为直接用 `session.paneId`：

- [ ] **Step 1: session:set-group 中的 pane 查找**

替换 cwd 匹配逻辑为：

```typescript
const sourcePaneId = session.paneId || ''
if (!sourcePaneId) { /* 无 pane_id，跳过 tmux 操作 */ }
```

不再需要 `list-panes` + `basename` 匹配。

- [ ] **Step 2: session:set-hidden 中的 pane 查找**

隐藏时直接用 `session.paneId`：

```typescript
if (session.paneId) {
  execSync(`${tmux.TMUX} kill-pane -t ${session.paneId}`, { stdio: 'ignore' })
}
```

取消隐藏时保存新的 paneId。

- [ ] **Step 3: GROUP_SET_MAIN_SESSION 中的 pane 查找**

```typescript
if (session.paneId) {
  tmux.swapMainPane(hostTmux, session.paneId)
  tmux.applyMainVerticalLayout(hostTmux)
}
```

- [ ] **Step 4: session:set-group 改为先 tmux 后 DB**

将 `sessionRepo.updateSessionGroup(sessionId, groupId)` 移到 tmux 操作成功之后，保证原子性。

- [ ] **Step 5: Build 验证 + Commit**

---

### Task 4: 移除 kitty-talk

**Files:**
- Delete: `src/main/mcp/collab-manager.ts`
- Delete: `src/main/mcp/inbox-watcher.ts`
- Delete: `src/main/mcp/server-script.ts`
- Modify: `src/main/mcp/session-server-script.ts`
- Modify: `src/main/mcp/session-mcp-manager.ts`
- Modify: `src/main/ipc/session-handlers.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 删除三个文件**

```bash
rm src/main/mcp/collab-manager.ts src/main/mcp/inbox-watcher.ts src/main/mcp/server-script.ts
```

- [ ] **Step 2: session-server-script.ts 移除 kitty-talk 注入**

删除 `injectSessionMcp` 中写入 `config.mcpServers['kitty-talk']` 的代码块。
删除 `updateGroupId` 中更新 `kitty-talk` env 的代码。
删除 `removeSessionMcp` 中删除 `kitty-talk` 的代码。

- [ ] **Step 3: session-mcp-manager.ts 移除 collab 相关调用**

`injectSessionMcp` 的签名中移除 `busDir` 等 kitty-talk 参数。
移除对 `collab-manager` 的引用。

- [ ] **Step 4: session-handlers.ts 移除 collab 引用**

删除 `import * as collab from '../mcp/collab-manager'`。
删除所有 `collab.watchInbox(...)` 调用。
删除所有 `collab.ensureRuntimeArtifacts()` 调用。
删除所有 `collab.cleanupStaleAgents(...)` 调用。
删除 `session:restart-agent` handler 中的 `collab.restartSessionAgent(...)` 调用。
删除 `session:set-agent-metadata` 中更新 `agents.json` 的代码块。

- [ ] **Step 5: index.ts 移除 collab 启动/停止**

删除 `import * as collab from './mcp/collab-manager'`。
删除 `collab.startAppMcpService()` 和 `collab.stopAppMcpService()` 调用。

- [ ] **Step 6: 清理 injectSessionMcp 调用签名**

全文搜索 `injectSessionMcp(`，将所有调用更新为新签名（移除 busDir、groupId/Name 等 kitty-talk 参数）。

- [ ] **Step 7: Build 验证 + Commit**

---

### Task 5: 代码质量清理

**Files:**
- Modify: `src/main/tmux/session-manager.ts`
- Modify: `src/main/ipc/session-handlers.ts`

- [ ] **Step 1: 修复裸 tmux 调用**

`isSessionAttached`（session-manager.ts）和 `syncAndList` 恢复逻辑（session-handlers.ts）中的裸 `tmux` 改为 `${TMUX}`（或 `tmux.TMUX`）。

- [ ] **Step 2: 动态 require 改为静态 import**

session-handlers.ts 顶部补齐 import：
- `import { v4 as uuid } from 'uuid'`
- `import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs'`（已部分导入，补齐）
- `import { getDB } from '../db/database'`（已有 sessionRepo，通过它访问）

删除所有内联 `const { v4: uuid } = require('uuid')`、`const fs = require('fs')` 等。

session-manager.ts 中删除 `const { homedir } = require('os')` 等（已在顶部 import）。

- [ ] **Step 3: 删除死代码**

- `joinSessionAsPane` 的 `_isFirstJoin` 参数删除
- `breakPaneToSession` 如果未使用则删除
- `tr '|' '|'` 空操作删除
- fork 脚本中未转义的 `$()` 修复

- [ ] **Step 4: toSessionInfo 中包含 paneId**

```typescript
function toSessionInfo(s: tmux.TmuxSession & { paneId?: string }): SessionInfo {
  return {
    ...existing fields,
    paneId: s.paneId || '',
  }
}
```

`syncAndList` 返回结果中也加 `paneId`。

- [ ] **Step 5: Build 验证 + Commit**

---

### Task 6: 端到端验证

- [ ] **Step 1: pane 模式验证**
  - 启动 → 同组 session 合并为 pane → pane_id 在 DB 中有值
  - Alt+数字切组
  - 右键创建会话 → 新 pane 出现在右侧
  - 右键设为主窗口 → pane 交换到左侧
  - 拖拽换组 → pane 移动
  - 隐藏 → pane 消失，取消隐藏 → pane 恢复

- [ ] **Step 2: session 模式验证**
  - 关闭 pane 模式 → 底栏恢复双层
  - Alt+数字切 session
  - 所有 session 独立运行

- [ ] **Step 3: kitty-talk 已移除确认**
  - `.mcp.json` 中无 kitty-talk 配置
  - `grep -r 'kitty-talk' src/` 无结果
  - 新建 session 不再注入 kitty-talk MCP
