# Kitty Kitty 交接文档（给 Claude）

更新时间：2026-03-30（下午）

## 一句话状态

项目已完成 group 级协作基础设施、统一 `slash` 协作命令层、`session:set-tool` 运行中切换 CLI、`"/@"` 输入下拉目标补全，以及 **Inbox Watcher Push Notifications**（agent 收到消息后自动推送到 tmux pane）。
当前可进入体验打磨阶段。

## 已完成

1. 会话管理基础能力
- Electron + React + tmux 会话管理
- 会话持久化与恢复（restore）
- worktree 创建与会话启动

2. Group 级协作模型
- `groups.collab_enabled` 生效
- 协作开关按 group 统一控制，不再按单 session 独立开关
- session 移组时会自动同步协作状态

3. MCP 协作工程化
- `src/main/mcp/server-script.ts` 提供工具：`talk` / `listen` / `peers` / `slash`
- 消息总线：`/tmp/kitty-bus`
- `talk` 支持 `@目标` 规范化
- `slash` 统一命令路由（CLI 无关层）：
  - `"/@"`：列可联系目标建议
  - `"/@ <前缀>"`：按前缀过滤建议
  - `"/@ <目标> <消息>"`：直发消息
  - `"/@peers"` / `"/@listen"`：直达 peers/listen

4. 正在运行 session 切换 CLI（`session:set-tool`）
- 可在 `claude` / `codex` / `shell` 之间切换
- 切换流程：停止旧进程 -> 等 pane 回到 shell -> 启动新工具
- 协作中的 session 切换时会先停协作再恢复协作（best effort rollback）

5. tmux 稳定性修复
- 重启/切换操作不再盯 session 默认 pane，而是盯主 pane target（避免多 pane 误判超时）
- shell 检测补充 `login`，减少“已回到 shell 但误判超时”

6. UI 输入补全（`InputPopup`）
- 输入 `"/@"` 时出现可交互模板与目标建议
- 可点选 `"/@peers"`、`"/@listen"`，或点选目标自动填充 `"/@ <目标> "`

8. Inbox Watcher Push Notifications
- `src/main/mcp/inbox-watcher.ts`：新建，`InboxWatcher` 类
- 监听 `busDir` 目录（非单文件），天然支持 inbox 文件新建触发
- macOS 返回空 filename 时 fallback 扫描所有 session
- 消息 ≤100 字全量推送，>100 字截断提示调 `listen`
- throttle 2秒/sender，仅 agent 进程运行时注入
- 已接入 `collab-manager.ts` 的 start/stop/cleanupAll 生命周期

9. 回归与构建
- `scripts/mcp-regression.js` 已覆盖：
  - MCP framing
  - `talk @mention`
  - `slash` 路由与目标建议
- `npm run verify` 通过

## 当前实现要点（代码入口）

1. MCP 协作核心
- `src/main/mcp/server-script.ts`
- `src/main/mcp/collab-manager.ts`
- `src/main/mcp/inbox-watcher.ts`（push 通知）

2. IPC 与会话逻辑
- `src/main/ipc/session-handlers.ts`

3. 数据层
- `src/main/db/database.ts`
- `src/main/db/session-repo.ts`

4. 前端
- `src/renderer/pet/InputPopup.tsx`
- `src/renderer/pet/PetCanvas.tsx`
- `src/renderer/pet/TagCloud.tsx`

5. 验证脚本
- `scripts/mcp-regression.js`

## 开发与验证命令

```bash
# 开发
npm run dev

# MCP 协议/行为回归
npm run test:mcp

# 发布前统一验证
npm run verify
```

## 运行规则（已写入 CLAUDE.md）

1. `debug`
- 杀掉正在运行的 kitty-kitty/electron 进程
- 执行 `npm run dev`
- 保持 dev 进程运行并回报结果

2. `publish`
- 杀进程 -> build -> pack -> 覆盖 `/Applications/Kitty Kitty.app` -> 启动

## 已知限制

1. `InputPopup` 的 `"/@"` 下拉候选目前来自本地 session 列表标题，不是实时总线 peers。
- 若要“严格等于当前 group 在线 agent 列表”，需新增前端 IPC 获取 `peers` 的实时结果。

2. 外部 CLI（Claude/Codex）中的自然语言 `@xxx` 仍可能不触发工具调用。
- 目前推荐使用显式 `slash` 语义（`/@ ...`）获得确定性行为。

3. 点击穿透仍未重做，当前维持禁用状态。

## 下一步建议（优先级）

1. 做实时 peers 下拉数据源（前端通过 IPC 拉取 MCP peers）
- 目标：输入 `”/@”` 时展示”当前 group 实时可联系 agent”

2. 增加协作回执可视化
- 在 UI 显示”已投递/失败/目标不存在/不在同组”等状态，而不只依赖 terminal 输出

3. 增加端到端联调脚本（可选）
- 自动起两个测试 agent，验证 `”/@”` -> `listen` -> push 全链路

