# Kitty Kitty

桌面宠物 + AI 会话管理器。一只住在屏幕上的像素宠物，帮你管理多个 AI agent 会话。

基于 Electron + React + tmux 构建，同组会话合并为 tmux 分屏窗口。

多 agent 协作通讯请使用 [**kitty-hive**](https://github.com/seangx/kitty-hive) — 独立的多 agent 协作服务器，支持 DM、任务分配、工作流审批和联邦节点。kitty-kitty 会自动把会话身份同步给 hive，详见 [hive 协作](#hive-协作)。

## 功能

- **像素宠物** — 像素风桌宠常驻屏幕，多种动画（idle/walk/think/talk/happy/sneak/roll/jump/stretch/dance），三套皮肤可换装（三花、绵悠悠、皮皮鸡）
- **贴边吸附** — 拖桌宠到屏幕左/右/上边缘自动吸附成探头，只露一小截猫，点击唤回；多屏环境自动识别边界，切换显示器后自动归位
- **会话管理** — 创建、切换、分组管理多个 AI agent 会话；每个 claude 会话预分配 `--session-id`，同一目录多会话历史不串
- **Pane 分组** — 同组会话自动合并为一个 tmux 窗口的多个 pane：主 pane 占左 35%，其余右侧均分；右键气泡"设为主窗口"调整
- **组归档** — 右键组头「归档」把整组从主界面收起、结束组内 tmux 会话但保留全部记录；设置面板「已归档」区一键恢复
- **状态栏** — 顶部 tmux 状态栏显示分组 tab；未分组会话拆开成独立 tab（每个会话一个 slot）
- **一键重启** — 右键会话气泡或组头，重启单个 / 整组 / 全部会话，基于 `claude --resume <id>` 精确恢复（jsonl 未落盘时自动降级）
- **会话设置** — 每个会话独立配置环境变量 + CLI 启动参数（如 `--model opus`），焊进 launch script 本体，重启/自动恢复都不丢
- **推送通知** — 订阅 ntfy.sh topic，部署状态等消息直接推送到桌宠气泡
- **技能管理** — 搜索、安装、按分类批量部署 superpowers 技能到会话
- **Hive 协作** — 会话身份自动同步到 [kitty-hive](https://github.com/seangx/kitty-hive)，改名/删除实时对齐，可选

## 前置依赖

| 依赖 | 说明 | 安装 |
|------|------|------|
| **Node.js** >= 18 | 运行时 | [nodejs.org](https://nodejs.org) |
| **tmux** | 会话管理核心 | macOS: `brew install tmux` / Ubuntu: `sudo apt install tmux` |
| **Ghostty** (可选) | 推荐终端模拟器 | [ghostty.org](https://ghostty.org) |
| **skillsmgr** (可选) | 技能管理 CLI | [skills-manager](https://github.com/jtianling/skills-manager) |

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

### 首次打开被系统拦截

本项目**没做苹果签名和公证**，首次打开 `.app` 会弹「无法打开，来自身份不明的开发者」或「已损坏」。绕过方式：

- **右键 → 打开** 两次，在弹窗里选「打开」，之后双击就正常了
- 或打开「系统设置 → 隐私与安全性」，滚到最下面点「仍要打开」
- 如果仍打不开（常见于从浏览器下载的 dmg），终端跑：
  ```bash
  xattr -cr /Applications/Kitty\ Kitty.app
  ```

### 自动发布

打 tag 以 `v` 开头（例如 `v0.1.1`）push 到 GitHub 会自动触发 `.github/workflows/release.yml`：macOS runner 跑 `npm run dist`，产出 x64/arm64 两份 dmg 并创建 GitHub Release。流程里关掉了证书自动发现（`CSC_IDENTITY_AUTO_DISCOVERY=false`），仍然是未签名包，用户首次打开按上节绕过。

## 使用

- **单击** 桌宠 — 互动
- **双击** 桌宠 — 打开输入框，创建新会话
- **右键** 桌宠 — 菜单（新对话、在目录中开始、新建分组、重启全部、换装、设置）
- **拖拽** 桌宠 — 移动位置；拖到屏幕左/右/上边缘松手自动吸附成探头，点击探头唤回
- **点击** 会话气泡 — attach 到该会话的 tmux 窗口
- **悬停** 会话气泡 — 显示「重启」快捷按钮
- **右键** 会话气泡 — 重命名、重启会话、打开目录、技能、会话设置（env + 启动参数）、设为主窗口、退出、退出并删除
- **右键** 组头 — 在此组创建会话、重启组内会话、重命名、设置颜色、📦 归档
- **拖拽** 会话气泡 — 到分组头入组；到隐藏栏隐藏；从隐藏栏拖出取消隐藏

### 快捷键（tmux session 内）

| 快捷键 | 功能 |
|--------|------|
| **Alt+1~9** | 切换到第 N 个分组（或第 N 个独立未分组会话） |
| **prefix+1~9** | 同上（prefix 默认 Ctrl+B） |
| **Alt+←** | 关闭当前 pane |
| **Alt+→** | 水平拆分新 pane |
| **Alt+↓** | 垂直拆分新 pane |
| **Ctrl+B → 方向键** | 切换 pane 焦点 |

### Pane 分组

同组的所有会话自动合并到一个 tmux 窗口的多个 pane 中：

- **布局** — 主 pane 占左 35%，其余 pane 在右侧上下均分
- **主 pane** — 右键会话气泡 → "设为主窗口" 指定
- **创建会话** — 右键组头 → "在此组创建会话"，自动 split 到组内
- **pane 标签** — 每个 pane 顶部显示目录名，活跃 pane 紫色高亮

### ntfy.sh 推送通知

订阅 ntfy.sh topic 接收 CI/部署通知等消息：

- 在设置面板输入 topic 名（不带 `ntfy.sh/` 前缀）
- 主进程 SSE 订阅（`since=now` 不拉历史）
- 消息以卡片形式显示在屏幕右上角，最多保留 3 条
- 支持 `title`、`message`、`tags`（`success` / `fail` 等影响色标）、`click` URL（点击卡片跳转）

示例：
```bash
curl -H "Title: Deploy" -H "Tags: white_check_mark" \
     -d "Production deployed" ntfy.sh/your-topic
```

### 会话重启

右键会话气泡或悬停气泡点「重启」。重启走 `tmux respawn-pane -k`，直接在同一个 pane 内启动新进程，无需轮询等待：

- 有 claude session ID 且 jsonl 已落盘 → `claude --resume <id>` 精确恢复
- 有 session ID 但 jsonl 从未落盘（新会话没发消息就重启）→ 降级为 `claude --session-id <同一个id>` 起新对话，保持 id 绑定不破
- 没有 session ID → fallback 到 `claude -c` continue 模式
- 组级：右键组头 → 「重启组内会话」
- 全局：右键桌宠 → 「重启全部」

### 会话设置

每个会话独立配置环境变量 + CLI 启动参数，右键气泡 → 「⚙️ 会话设置」：

- **环境变量** — `KEY=VALUE` 每行一条，非法 shell 变量名自动过滤
- **启动参数** — 追加在全局 `toolArgs` 之后（后者覆盖前者），例如 `--model opus --dangerously-skip-permissions`
- 存储在 DB 的 session 行里
- **焊进 launch script 本体**（紧跟 `PATH` 之后），无论 respawn / app 重启自动恢复 / 手动重跑脚本都不丢；重启会话生效

### 组归档

用完的组可以整个收起来，需要时再拉回：

- 右键组头 → 「📦 归档（结束组内会话）」— 组从主界面消失，组内 tmux 会话被结束（`claude --resume` 需要的 jsonl 保留）
- 设置面板「📦 已归档」区列出所有归档组（名字 + 会话数），点「恢复」拉回主界面
- 恢复后组内会话是 detached 态，点击某会话时走现有 attach 逻辑重建 tmux
- 归档状态跨重启保持，不会自动复活

### 技能管理

通过 skillsmgr CLI 集成，在技能面板中管理 superpowers 技能：

- **搜索** — 按名称搜索可用技能
- **安装** — 从 registry 安装技能
- **部署** — 将已安装技能部署到当前会话的 `.mcp.json`
- **分类批量操作** — 按 category / group 一键全部部署或移除
- 技能面板通过独立窗口展示（会话气泡右键 → 技能）

### Hive 协作

和 [**kitty-hive**](https://github.com/seangx/kitty-hive) (>= v0.6.2) 的轻量集成，让 kitty 里的每个会话在 hive 上自动有个对应 agent，DM / 任务分派直接点名即可。

**工作原理**：

- 创建/重启会话时，kitty 把两个环境变量**焊进 launch script 本体**（紧跟 `PATH` 之后 `export`）：
  - `HIVE_AGENT_KEY` = kitty 里的 session id（稳定不变，重启不换）
  - `HIVE_AGENT_NAME` = 会话标题
  - 焊进脚本而非依赖 `tmux -e`（后者是 ephemeral 环境，app 重启原地恢复、`exec $SHELL` 后重跑脚本、手动 split 都会丢 key，导致同 cwd 多会话在 hive 上错绑串号）
- [kitty-hive channel plugin](https://github.com/seangx/kitty-hive) 启动时读这两个变量，按 key 在 hive 上 upsert 出 agent，同 key 永远映射到同一 agent_id。
- 会话**改名** → kitty 立刻调 `kitty-hive agent register --key ... --display-name ...` 同步新名字到 hive。
- 会话**删除** → 调 `kitty-hive agent remove --key ... --yes`，hive agent 一起清掉。

**零依赖**：kitty-hive 没装、server 没启动、网络不通——三条 CLI 调用全部静默失败，kitty 正常跑。

**注意**：更新前的老 launch script 里没写身份 `export`，需要右键"重启会话"一次才会重新生成带身份的脚本、首次同步到 hive。新建的会话开箱即用。

## 项目结构

```
src/
  main/        # Electron 主进程
    db/        #   SQLite 数据库
    ipc/       #   IPC 处理器
    tmux/      #   tmux 会话管理 + CLI wrapper
    skills/    #   skillsmgr CLI 集成
    windows/   #   窗口管理 + 位置持久化
    ntfy.ts    #   ntfy.sh SSE 订阅
  renderer/    # React 渲染进程
    pet/       #   桌宠 UI 组件（TagCloud、SkinPicker、SettingsPanel…）
    store/     #   Zustand 状态管理
  shared/      # 共享类型定义
  preload/     # Electron preload
```

## 相关项目

- [**kitty-hive**](https://github.com/seangx/kitty-hive) — 多 agent 协作服务器（DM / 任务 / 工作流 / 联邦）

## License

MIT
