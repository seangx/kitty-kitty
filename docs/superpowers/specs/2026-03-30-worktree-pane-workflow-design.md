# Worktree-as-Pane Workflow Design

Kitty-kitty 的 worktree 工作流：每个 worktree 作为 session 内的 tmux pane，支持个人多分支并行和多 agent 协作。

## 核心模型

```
Session (tmux session: kitty_abc)
  ├── mainPane 0.0: claude @ /project (main)
  ├── worktree pane 0.1: claude @ .worktrees/feat-api
  └── worktree pane 0.2: codex  @ .worktrees/feat-ui

Group: "前后端联调" (collab enabled)
→ 所有 pane 的 agent 通过 MCP collab 互相感知
```

- 一个 session 可有 N 个 worktree pane
- worktree pane 的生命周期跟随 session
- agent 间通讯复用现有 Group Collaboration（MCP collab），不发明新机制

## 数据模型

### 新增 `worktree_panes` 表

```sql
CREATE TABLE worktree_panes (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pane_id      TEXT NOT NULL,         -- tmux pane 标识，如 "0.1" 或 "%5"
  branch       TEXT NOT NULL,
  path         TEXT NOT NULL,         -- worktree 绝对路径（不限于 .worktrees/）
  base_branch  TEXT DEFAULT 'main',
  tool         TEXT DEFAULT 'claude',
  merge_state  TEXT DEFAULT 'unknown', -- clean | conflict | behind | merged
  status       TEXT DEFAULT 'active',  -- active | done | stale
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(session_id, pane_id)
);
```

### `sessions` 表

不修改。session 代表一个 tmux session，worktree 信息全在 `worktree_panes` 表。

## 模块架构

```
src/main/worktree/
  ├── worktree-manager.ts   -- worktree 的 CRUD + pane 操作
  └── worktree-monitor.ts   -- 状态轮询 + 智能建议
src/main/db/
  └── worktree-pane-repo.ts -- DB 读写
src/main/ipc/
  └── worktree-handlers.ts  -- IPC 接口
```

### worktree-manager.ts

```typescript
// 在 session 内创建 worktree pane
// 1. git worktree add  2. tmux split-window  3. 启动 agent  4. 写 DB
createWorktreePane(sessionId, branch, baseBranch?, tool?): WorktreePane

// 关闭 worktree pane
// 1. kill pane  2. 可选 git worktree remove  3. 删 DB 记录
removeWorktreePane(paneId, opts?: { keepWorktree?: boolean }): void

// 发现项目中已有的 worktree（git worktree list + .worktrees/ 扫描）
// 过滤掉 DB 中已追踪的
discoverWorktrees(projectRoot): DiscoveredWorktree[]

// 将发现的 worktree 挂载为 session 的 pane
attachWorktrees(sessionId, worktrees: DiscoveredWorktree[], tool?): WorktreePane[]

// 清理 session 下所有已 merged 的 worktree pane
pruneMerged(sessionId): RemovedPane[]

// session 恢复时重建 worktree panes
restorePanes(sessionId): void
```

现有 `session-handlers.ts` 中 `session:create-worktree`（L153-226）的 git worktree 操作 + symlink 逻辑迁移到 `worktree-manager.ts`，session-handlers 改为调用 manager。

### worktree-monitor.ts

后台定时器（30s interval），对所有 active worktree pane 执行：

```typescript
interface WorktreeStatus {
  mergeState: 'clean' | 'conflict' | 'behind' | 'merged'
  aheadBehind: { ahead: number; behind: number }
  lastCommitAge: number  // 秒
  hasUncommitted: boolean
}

// 检测逻辑：
// - git merge-base --is-ancestor → merged 检测
// - git rev-list --left-right --count → ahead/behind
// - git status --porcelain → uncommitted
// - git merge-tree 预检 → conflict 检测
// - 跨 pane 修改同一文件 → 冲突预警
// - 最后 commit > 7 天 → stale

// 智能建议类型：
type Advice =
  | { type: 'suggest-cleanup'; paneId: string; reason: string }
  | { type: 'suggest-rebase'; paneId: string; behind: number }
  | { type: 'warn-conflict'; paneIds: string[]; files: string[] }
  | { type: 'warn-stale'; paneId: string; staleDays: number }
  | { type: 'suggest-worktree'; reason: string; suggestedBranch: string }

// 同类建议 24h 去重
```

## IPC 接口

```typescript
// worktree-handlers.ts
'worktree:discover'       (projectRoot) => DiscoveredWorktree[]
'worktree:create-pane'    (sessionId, branch, baseBranch?, tool?) => WorktreePane
'worktree:attach-panes'   (sessionId, worktrees[], tool?) => WorktreePane[]
'worktree:remove-pane'    (paneId, opts?) => void
'worktree:prune-merged'   (sessionId) => RemovedPane[]
'worktree:list-panes'     (sessionId) => WorktreePane[]

// 事件（main → renderer）
'worktree:pane-status-changed'  (paneId, mergeState, aheadBehind)
'worktree:pane-lost'            (paneId)  // pane 消失，触发保留/清理选择
'worktree:advice'               (advice)
```

## Session 创建流程

```
选目录
  │
  ├─ 非 git → 创建普通 session
  │
  └─ 是 git → discoverWorktrees()
       │
       ├─ 无 worktree → 现有流程（选 claude session 或新建）
       │    └─ 额外选项："新建 worktree" 按钮
       │
       └─ 有 worktree → Worktree Picker
            ├─ 选主分支/某个 worktree 作为主 pane
            ├─ 勾选其他 worktree 作为附加 pane
            └─ 确认 → 创建 session + split panes
```

## Pane 关闭处理

```
用户关闭 worktree pane（UI / tmux kill-pane / exit）
  │
  ├─ monitor 检测到 pane 消失
  │
  └─ 弹轻量确认：
       ○ 保留 worktree（删 DB 记录，worktree 目录保留，下次可重新 attach）
       ○ 清理 worktree（git worktree remove + 可选删分支 + 删记录）

  默认行为：保留（安全优先）
```

## Session 恢复

```
App 启动 → syncAndList()
  └── 对每个有 worktree_panes 记录的 session：
       │
       ├─ tmux session 还活着
       │    └─ 检查每个 pane：
       │         ├─ pane 在 → 不动
       │         └─ pane 消失 → split + 重启 agent
       │
       └─ tmux session 已死
            └─ 重建主 session → 逐个 split worktree pane
```

## Worktree Pane 生命周期

```
active ──→ done    (用户关闭 pane，选择保留 worktree)
  │          └──→ 下次打开项目可重新 attach
  │
  ├────→ stale   (>7 天无 commit) → 建议清理
  │
  └────→ merged  (分支已合并到 base) → 建议清理 + 删分支
```

## Session Kill 行为

kill 整个 session 时：
- CASCADE 删除 `worktree_panes` 记录
- **不**自动删除 worktree 目录（可能有未推送代码）
- 下次打开同一项目时 `discoverWorktrees()` 还能发现

## UI 变化

### Session 卡片

现有布局不改，有 worktree pane 时显示展开箭头：

```
┌─────────────────────────────────┐
│  重构认证模块             claude  │
│  /project  main                  │
│ ▸ 2 worktree panes               │
└─────────────────────────────────┘

展开：
│  ├ feat-api  ●green  ↑2 ↓0  claude │
│  └ feat-ui   ●yellow ↑1 ↓5  codex  │
│    [+ 新建 worktree pane]            │
```

操作：点击 → focus pane，右键 → 关闭 / 切换 tool

### 通知气泡

宠物上方弹出，复用现有机制：
- "feat-api 已合并到 main，要清理吗？"
- "feat-api 和 feat-ui 都改了 auth.ts，注意冲突"
- 同类建议 24h 去重

### tmux 状态栏

不改。worktree pane 在 tmux 内属于同一 session，每个 pane 内部 shell prompt 自然显示各自 git branch。

## 清理策略

```typescript
// 单个 pane 清理
removeWorktreePane(paneId, { keepWorktree: false })
  → tmux kill-pane
  → git worktree remove <path>
  → git branch -d <branch>  // 仅已合并分支，未合并需 -D + 二次确认
  → 删 DB 记录

// 批量清理
pruneMerged(sessionId)
  → 找所有 merge_state='merged' 的 pane
  → 逐个 removeWorktreePane({ keepWorktree: false })
```
