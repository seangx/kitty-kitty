# Kitty Kitty

桌面宠物 + AI 会话管理器，基于 Electron + React + tmux。

## 项目结构

- `src/main/` — Electron 主进程（IPC、tmux 管理、数据库）
- `src/renderer/` — React 渲染进程（宠物界面、会话 UI）
- `src/shared/` — 共享类型定义
- `src/preload/` — Electron preload 脚本

## 开发命令

- `npm run dev` — 开发模式启动
- `npm run build` — 编译
- `npm run pack` — 打包为目录（不生成安装包）
- `npm run dist` — 打包为 dmg 安装包

## 规则

### 通用执行规则（与当前项目代理规则对齐）

1. 默认直接落地执行，不只停留在分析；除非用户明确只要方案。
2. 搜索文件/文本优先使用 `rg` / `rg --files`。
3. 不要回滚或覆盖与当前任务无关的现有改动。
4. 禁止使用破坏性命令（如 `git reset --hard`、`git checkout --`）除非用户明确要求。
5. 改代码前先阅读相关调用链，改完后必须做验证再宣称完成。
6. 默认验证命令：`npm run test:mcp`、`npm run build`（若某项无法执行，需明确说明原因）。
7. 报告结果时优先给结论与风险，再给细节；不要只贴命令，不解释结果。
8. 涉及 review 请求时，优先输出按严重级别排序的问题清单（含文件位置），总结放最后。
9. 在现有设计系统或 UI 语言内改动时，保持现有风格与结构一致，避免无关重设计。

### publish

当用户输入 "publish" 时，执行以下步骤：

1. 杀掉所有 kitty-kitty Electron 进程：`ps aux | grep '[E]lectron.app.*kitty-kitty' | awk '{print $2}' | xargs kill 2>/dev/null; pkill -f 'Kitty Kitty' 2>/dev/null`
2. `npm run build` 编译项目
3. `npm run pack` 打包
4. 找到打包产物中的 .app，复制到 /Applications/ 覆盖安装
5. 启动安装后的应用：`open /Applications/Kitty\ Kitty.app`
6. 报告结果

### debug

当用户输入 "debug" 时，执行以下步骤：

1. 杀掉所有 kitty-kitty Electron 进程：`ps aux | grep '[E]lectron.app.*kitty-kitty' | awk '{print $2}' | xargs kill 2>/dev/null; pkill -f 'Kitty Kitty' 2>/dev/null`
2. 在项目根目录执行 `npm run dev`
3. 保持该开发进程运行，并报告启动结果（成功/失败）

### 协作消息（@提及）

当用户输入中包含 `@目标` 且带有要转发的消息内容时，必须执行以下行为：

1. 优先调用 MCP `talk` 工具发送消息，不允许只做普通文本代发
2. `to` 参数允许直接使用 `@目标`（不要要求用户先手动跑 `peers`）
3. 发送后必须返回投递回执（例如：`Delivered to <name> [<id>]`）
4. 如果未找到目标，明确返回失败原因，并提示可用 `peers()` 查看成员
