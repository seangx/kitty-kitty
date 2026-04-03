# Kitty Kitty

桌面宠物 + AI 会话管理器。一只住在屏幕上的猫咪，帮你管理多个 AI agent 会话。

基于 Electron + React + tmux 构建，支持 Claude、Codex 等 AI 工具的多会话并行管理、分组协作和 git worktree 工作流。

## 功能

- **桌面宠物** — ASCII 猫咪常驻屏幕，拖拽、点击有互动动画
- **会话管理** — 创建、切换、分组管理多个 AI agent 会话（Claude / Codex / Shell）
- **分组协作** — 同组 agent 之间可通过 MCP 互发消息（`@agent 消息`）
- **Worktree Pane** — git worktree 作为 tmux pane，支持多分支并行开发
- **自动发现** — 自动检测 `.worktrees/` 下的 worktree 并注册管理
- **冲突预警** — 后台监控 worktree 状态，合并冲突 / 分支过期自动提醒

## 前置依赖

| 依赖 | 说明 | 安装 |
|------|------|------|
| **Node.js** >= 18 | 运行时 | [nodejs.org](https://nodejs.org) |
| **tmux** | 会话管理核心 | macOS: `brew install tmux` / Ubuntu: `sudo apt install tmux` |
| **Git** | worktree 功能依赖 | 一般系统自带 |

> 启动时会自动检测 tmux，未安装会弹窗提示。

## 安装与运行

```bash
# 克隆仓库
git clone https://github.com/anthropics/kitty-kitty.git
cd kitty-kitty

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 打包（目录）
npm run pack

# 打包（dmg 安装包）
npm run dist
```

## 使用

- **单击** 猫咪 — 互动
- **双击** 猫咪 — 打开输入框，创建新会话
- **右键** 猫咪 — 菜单（新对话、在目录中开始、导入已有会话、设置）
- **拖拽** 猫咪 — 移动位置
- **点击** 会话气泡 — attach 到该会话的 tmux 窗口
- **右键** 会话气泡 — 重命名、切换工具、重启、分组、退出

### 协作命令

在输入框中使用 `/@` 前缀发送协作消息：

- `/@peers` — 查看当前所有 agent
- `/@listen` — 查看未读消息
- `/@agent_name 消息内容` — 向指定 agent 发送消息

### Worktree 工作流

1. 点击会话气泡上的 `🌿+` 展开 worktree 面板
2. 输入分支名，点击 GO 创建 worktree pane
3. 每个 worktree pane 独立运行 agent，共享同一 tmux session

## 项目结构

```
src/
  main/        # Electron 主进程
    db/        #   SQLite 数据库
    ipc/       #   IPC 处理器
    mcp/       #   MCP 协作通信
    tmux/      #   tmux 会话管理
    worktree/  #   git worktree 管理
    windows/   #   窗口管理
  renderer/    # React 渲染进程
    pet/       #   宠物 UI 组件
    store/     #   Zustand 状态管理
  shared/      # 共享类型定义
  preload/     # Electron preload
```

## License

MIT
