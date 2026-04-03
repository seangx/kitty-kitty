# Worktree Pane 功能交接文档

## 功能概述

kitty-kitty 新增了 worktree-as-pane 工作流：git worktree 作为 tmux session 内的 pane 管理，支持个人多分支并行和多 agent 协作。

## 架构

```
Session (tmux session: kitty_abc)
  ├── mainPane 0.0: claude @ /project (main)
  ├── worktree pane 0.1: claude @ .worktrees/feat-api
  └── worktree pane 0.2: codex  @ .worktrees/feat-ui

Agent 间通讯复用 Group Collaboration（MCP kitty-talk）
```

## 新增文件

| 文件 | 职责 |
|------|------|
| `src/shared/types/worktree.ts` | 共享类型：WorktreePaneInfo, DiscoveredWorktree, WorktreeAdvice |
| `src/main/db/worktree-pane-repo.ts` | worktree_panes 表 CRUD |
| `src/main/worktree/worktree-manager.ts` | worktree 创建/删除/发现/恢复/自动注册 |
| `src/main/worktree/worktree-monitor.ts` | 30s 轮询：merge state 检测、冲突预警、stale 检测 |
| `src/main/ipc/worktree-handlers.ts` | worktree IPC 接口（discover/create/remove/prune/list） |
| `src/main/mcp/session-server-script.ts` | kitty-session MCP server（worktree_pane/list_panes/close_pane） |
| `src/main/mcp/session-mcp-manager.ts` | 自动为 git repo session 注入 kitty-session MCP |

## 修改文件

| 文件 | 改动 |
|------|------|
| `src/main/db/database.ts` | 新增 worktree_panes 表迁移 |
| `src/main/ipc/session-handlers.ts` | syncAndList 加 worktree pane 恢复 + 自动发现 + session MCP 注入 |
| `src/main/ipc/handlers.ts` | 注册 worktree handlers |
| `src/main/index.ts` | 启动 monitor + session MCP cleanup |
| `src/shared/types/ipc.ts` | 6 个 worktree IPC 常量 |
| `src/shared/types/session.ts` | SessionInfo 新增 isGitRepo + worktreePanes |
| `src/renderer/lib/ipc.ts` | worktree IPC wrappers |
| `src/renderer/store/session-store.ts` | createWorktreePane + removeWorktreePane actions |
| `src/renderer/pet/TagCloud.tsx` | 可展开 worktree pane 子项 + 内联输入创建 |
| `src/renderer/pet/SessionPicker.tsx` | worktree 发现 + 多选挂载 |
| `src/renderer/pet/PetCanvas.tsx` | 串联 worktree props + advice 通知 + discover |

## 两条创建路径

### 路径 1：UI 创建（用户操作）
1. session 气泡上点 🌿+ → 展开面板 → 输入分支名 → GO
2. 或：📂 在目录中开始 → SessionPicker → 🌿 Worktree 分支 → 输入分支名
3. 调用链：renderer → IPC `worktree:create-pane` → `worktree-manager.createWorktreePane()` → git worktree add + tmux split-window + DB

### 路径 2：Agent 创建（MCP tool）
1. Agent 调用 `worktree_pane({ branch: "feat/xxx", message: "任务描述" })`
2. kitty-session MCP server 直接执行 git + tmux + symlink + 写 .mcp.json 到 worktree
3. kitty-kitty 10s 内通过 auto-discovery 注册到 DB

### 路径 3：Agent 自行 git 创建（被动发现）
1. Agent 按 CLAUDE.md 规范执行 `git worktree add`
2. syncAndList 10s 轮询发现 `.worktrees/` 下新增目录
3. `autoRegisterWorktree()` 注册 DB + 创建 symlink（但不开 pane）

## Session MCP（kitty-session）

### 注入条件
- session 的 cwd 是 git 仓库
- 自动注入，不依赖 collab 开关
- 写入 `<cwd>/.mcp.json` 的 `kitty-session` 条目

### 提供的 tools
| Tool | 描述 |
|------|------|
| `worktree_pane` | 创建 worktree + split pane + 启动 agent + 发送初始消息 |
| `list_panes` | 列出 tmux session 中所有 pane |
| `close_pane` | 关闭 pane，可选 cleanup（删 worktree + 已合并分支） |

### worktree pane 的 .mcp.json
创建 worktree pane 时，会复制主仓库的 `.mcp.json` 到 worktree 目录，但覆盖 agent ID：
- kitty-session: agent ID = `主ID-分支名`，project root = worktree 路径
- kitty-talk: agent ID = `主ID-分支名`，agent name = 分支名

## 自动清理

- `listPanes()` 每次调用时检查路径是否存在，不存在直接删 DB 记录
- worktree-monitor 检测 merged 分支 → 建议清理（advice 通知）
- worktree-monitor 检测 >7 天无 commit → 标记 stale
- session kill 时 CASCADE 删 worktree_panes 记录（worktree 目录保留）

## UI 行为

- 只有 `isGitRepo && cwd 不在 .worktrees/ 下` 的 session 才显示 🌿+
- 展开面板显示每个 pane 的分支名 + merge state 色点 + ✕ 关闭按钮
- `+ worktree pane` 按钮触发内联输入框（非 window.prompt）
- advice 通知通过宠物气泡显示（suggest-cleanup/warn-conflict/warn-stale/suggest-rebase）

## 待完成 / 已知问题

1. **worktree pane 恢复时的 tmux split** — app 重启时会尝试恢复 worktree pane（split-window），但如果 tmux session 不存在则标记 done
2. **auto-discovery 只发现 `.worktrees/` 下的** — 外部路径的 worktree 不会被自动追踪
3. **session MCP 只支持 Claude** — Codex 的 MCP 注入走 TOML 格式，当前 session-mcp-manager 只写 .mcp.json
4. **close_pane 的 cleanup 只删已合并分支** — 未合并的分支需要用 `git branch -D` 手动删除

## 设计文档

- Spec: `docs/superpowers/specs/2026-03-30-worktree-pane-workflow-design.md`
- Plan: `docs/superpowers/plans/2026-03-30-worktree-pane-workflow.md`
