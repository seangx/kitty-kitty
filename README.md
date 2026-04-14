# Kitty Kitty

桌面宠物 + AI 会话管理器。一只住在屏幕上的猫咪，帮你管理多个 AI agent 会话。

基于 Electron + React + tmux 构建，支持 Claude AI 工具的多会话并行管理、分组协作和 git worktree 工作流。

## 功能

- **桌面宠物** — ASCII 猫咪常驻屏幕，多种动画（roll/lick/jump/sneak/dance），5 套皮肤可换装
- **会话管理** — 创建、切换、分组管理多个 AI agent 会话
- **Pane 模式** — 同组会话合并为分屏窗口，主 pane 占左 35%，其余右侧均分，Alt+数字切组
- **双层底栏** — 上层组 tab，下层组内会话（session 模式）；pane 模式下简化为单行组栏
- **MCP 通讯** — 所有会话自动注入 kitty-talk MCP，跨组消息、语义发现、角色标签
- **MCP 编排** — kitty-session MCP 提供 pane 拆分、worktree 创建、会话 fork
- **技能管理** — 搜索、安装、按分类批量部署 superpowers 技能到会话
- **Worktree** — Alt+F 一键 fork 会话到 git worktree，带完整对话历史
- **自动发现** — 自动检测 `.worktrees/` 下的 worktree 并注册管理
- **冲突预警** — 后台监控 worktree 状态，合并冲突 / 分支过期自动提醒

## 前置依赖

| 依赖 | 说明 | 安装 |
|------|------|------|
| **Node.js** >= 18 | 运行时 | [nodejs.org](https://nodejs.org) |
| **tmux** | 会话管理核心 | macOS: `brew install tmux` / Ubuntu: `sudo apt install tmux` |
| **Git** | worktree 功能依赖 | 一般系统自带 |
| **Ghostty** (可选) | 推荐终端模拟器 | [ghostty.org](https://ghostty.org) |
| **skillsmgr** (可选) | 技能管理 CLI | 内部工具 |

> 启动时会自动检测 tmux，未安装会弹窗提示。
> 从 `/Applications` 启动时会自动查找 `/opt/homebrew/bin/tmux` 等常见路径，无需额外配置 PATH。

## 安装与运行

```bash
# 克隆仓库
git clone https://github.com/seangx/kitty-kitty.git
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
- **右键** 猫咪 — 菜单（新对话、在目录中开始、导入已有会话、换装、设置）
- **拖拽** 猫咪 — 移动位置
- **点击** 会话气泡 — attach 到该会话的 tmux 窗口
- **右键** 会话气泡 — 重命名、重启、打开目录、分组、技能、设置角色/专长、设为主窗口（pane 模式）、退出
- **右键** 组头 — 组颜色设置、在此组创建会话

### 快捷键（tmux session 内）

| 快捷键 | Session 模式 | Pane 模式 |
|--------|-------------|----------|
| **Alt+1~9** | 切换组内第 N 个会话 | 切换到第 N 个分组 |
| **prefix+1~9** | 切换到第 N 个分组 | 同左 |
| **Alt+F** | Fork 到 git worktree | 同左 |
| **Alt+←** | 关闭当前 pane | 同左 |
| **Alt+→** | 水平拆分新 pane | 同左 |
| **Alt+↓** | 垂直拆分新 pane | 同左 |
| **Ctrl+B → 方向键** | — | 切换 pane 焦点 |

> prefix 默认为 Ctrl+B

### Pane 模式

通过设置面板开启。启用后同组的所有会话合并为一个 tmux 窗口的多个 pane：

- **布局** — 主 pane 占左 35%，其余 pane 在右侧上下均分
- **主 pane** — 右键会话气泡 → "设为主窗口" 指定
- **创建会话** — 右键组头 → "在此组创建会话"，自动 split 到组内
- **底栏** — 简化为单行组栏，Alt+数字切组
- **pane 标签** — 每个 pane 顶部显示目录名，活跃 pane 紫色高亮
- **模式切换** — 设置面板 toggle 开关，自动迁移 tmux 布局（合并/拆分）

### MCP 通讯系统（kitty-talk）

所有会话自动注入 kitty-talk MCP 服务，提供 agent 间通讯和语义发现能力：

- `talk(to, message)` — 向 agent 发送消息，支持 `role:ux` 按角色路由
- `peers(role?, keyword?, all?)` — 按角色 / 关键字 / 专长搜索 agent
- `listen()` — 查看未读消息（基于持久化 offset，重启不丢消息）

**角色与专长**：右键会话气泡 → "设置角色/专长"，为 agent 标注角色标签（如 `ux, frontend`）和专长描述。其他 agent 可通过 `peers(role: "ux")` 或 `peers(keyword: "设计")` 发现并协作。

在输入框中也可用 `/@` 快捷语法：`/@agent_name 消息内容`

### MCP 会话编排（kitty-session）

agent 可通过 kitty-session MCP 拆分子 pane 和管理 worktree：

- `create_pane(tool, cwd, message)` — 开新 pane 并启动 agent
- `fork_session(branch)` — 创建 git worktree + fork 当前 claude 会话
- `create_worktree(branch)` — 创建 git worktree（不 fork 会话）
- `list_panes()` — 查看当前 session 的所有 pane
- `close_pane(pane_id, cleanup?)` — 关闭 pane，可选清理 worktree + 数据

### 技能管理

通过 skillsmgr CLI 集成，在技能面板中管理 superpowers 技能：

- **搜索** — 按名称搜索可用技能
- **安装** — 从 registry 安装技能
- **部署** — 将已安装技能部署到当前会话的 `.mcp.json`
- **分类批量操作** — 按 category / group 一键全部部署或移除
- 技能面板通过独立窗口展示（点击会话气泡右键 → 技能）

### Worktree 工作流

**方式一：Alt+F 快捷键（推荐）**

1. 在任意 kitty tmux session 中按 Alt+F
2. 输入分支名（如 `feat/user-auth`）
3. 自动创建 git worktree + hardlink claude 会话 + 在新 pane 中 `claude -c --fork-session`
4. 新 pane 继承当前对话上下文，在独立分支上工作
5. 完成后 Alt+← 关闭 pane，自动清理 worktree + claude 项目数据 + `git worktree prune`

**方式二：UI 面板**

1. 点击会话气泡上的 🌿 图标展开 worktree 面板
2. 输入分支名，点击 GO 创建 worktree pane
3. 每个 worktree pane 独立运行 agent，共享同一 tmux session

**方式三：MCP 工具**

agent 可直接调用 `fork_session(branch)` 或 `create_worktree(branch)` + `create_pane(cwd)`。

## 项目结构

```
src/
  main/        # Electron 主进程
    db/        #   SQLite 数据库
    ipc/       #   IPC 处理器
    mcp/       #   MCP 通讯 (kitty-talk) + 会话编排 (kitty-session)
    tmux/      #   tmux 会话管理 + CLI wrapper + fork/close 脚本
    skills/    #   skillsmgr CLI 集成
    worktree/  #   git worktree 管理 + 冲突监控
    windows/   #   窗口管理 + 位置持久化
  renderer/    # React 渲染进程
    pet/       #   宠物 UI 组件（TagCloud、SkillsPanel、AgentMetadataPopup）
    store/     #   Zustand 状态管理
  shared/      # 共享类型定义
  preload/     # Electron preload
```

## License

MIT
