# 合并 Pane 模式设计

## 概述

新增全局开关「合并 pane 模式」。启用后，每个 group 的所有会话作为 pane 共存于一个 tmux session，主 pane 占左侧 35%，其余 pane 在右侧上下均分。底栏变为只切换分组。

## 决策记录

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 模式关系 | 与独立 session 模式共存 | 不同场景有不同需求 |
| 切换粒度 | 全局开关 | 简单直观 |
| 新建会话 | 右键组 → 创建会话 → 加为 pane | 默认仍是独立 session |
| 布局 | 主从：主 pane 左 35%，其余右侧均分 | 主会话需要更多空间 |
| 主 pane 选择 | 用户右键手动指定 | 灵活 |
| CLI 工具 | 仅支持 claude | 当前唯一活跃工具 |

## 1. 全局开关

### 配置

`~/.kitty-kitty/config.json`：

```json
{
  "paneMode": false,
  "toolArgs": { "claude": "..." }
}
```

- `paneMode: false`（默认）→ 独立 session 模式（现有行为）
- `paneMode: true` → 合并 pane 模式

### 读取

复用现有 `cli-wrapper.ts` 的 `loadConfig()` 机制，新增 `getPaneMode(): boolean`。

## 2. 两种模式对比

| | 独立 session 模式 | 合并 pane 模式 |
|---|---|---|
| tmux 结构 | 每个 agent 一个 tmux session | 每个 group 一个 tmux session，agent 是 pane |
| 底栏上层 | 组 tab（prefix+数字切组） | 组 tab（Alt+数字切组） |
| 底栏下层 | 组内 session 列表（Alt+数字切 session） | 当前组信息摘要（pane 数量等） |
| 导航 | Alt+数字切 session | tmux 原生 pane 切换 |
| 新建 | 创建独立 tmux session | 右键组 → 创建会话 → split-window 加 pane |

## 3. 布局

### 主从布局

```
┌──────────────────────┬────────────┐
│                      │  Agent B   │
│                      │            │
│     主 Pane (35%)    ├────────────┤
│     Agent A          │  Agent C   │
│                      │            │
│                      ├────────────┤
│                      │  Agent D   │
└──────────────────────┴────────────┘
```

- 主 pane 固定占左侧约 35% 宽度
- 其余 pane 在右侧 65% 区域上下均分
- 新增 pane 时：在右侧区域 `split-window -v`（垂直拆分）

### 主 pane 选择

- 默认：组内第一个创建的会话
- 用户可通过右键菜单指定某个会话为主 pane
- 存储：`groups` 表新增 `main_session_id TEXT REFERENCES sessions(id)`
- 切换主 pane 时重新排列布局（`swap-pane`）

## 4. tmux 结构

### 合并 pane 模式下的 tmux session 命名

每个 group 对应一个 tmux session，命名规则：`kitty_grp_<group_id_prefix>`

### 创建会话（右键组 → 创建会话）

1. 在 DB 中创建 session 记录，设置 `group_id`
2. 找到该 group 的 tmux session
3. 如果是组内第一个会话：直接创建 tmux session，启动 claude
4. 如果组内已有会话：在现有 tmux session 中 `split-window -h -p 65`（第二个 pane 时水平分割，右侧 65%），后续 pane 在右侧 `split-window -v`（上下均分）
5. 启动 claude（通过 `cli-wrapper.ts` 的 launch script）

### 关闭 pane

- 关闭某个 pane 时，更新 DB session 状态
- 如果关闭的是主 pane，自动将下一个 pane 提升为主 pane 并重排布局
- 如果关闭了组内最后一个 pane，整个 tmux session 销毁

## 5. 底栏行为

### pane 模式下

- **上层（组栏）**：不变，显示所有有活跃会话的组
- **下层（信息栏）**：显示当前组名 + pane 数量 + 各 pane 状态点，或隐藏（pane 已可见，无需重复显示）
- **Alt+数字**：切换分组（不再切 session，因为 pane 可见）
- **prefix+数字**：同样切换分组

### session 模式下

不变，保持现有双层底栏行为。

## 6. 模式切换迁移

### 开启 pane 模式（session → pane）

对每个 group：
1. 选定主 session（`main_session_id` 或第一个）
2. 其余 session 通过 `tmux join-pane -s <source> -t <target>` 合并到主 session
3. 重新排列布局：`select-layout main-vertical`，调整主 pane 为 35%
4. 删除被合并的空 tmux session
5. 重命名主 session 为 `kitty_grp_<group_id_prefix>`

### 关闭 pane 模式（pane → session）

对每个 group session：
1. 遍历所有 pane（除主 pane 外）
2. `tmux break-pane -s <pane_id>` 拆为独立 session
3. 重命名回 `kitty_<id>` 格式
4. 更新 DB

### 未分组会话

未分组的会话在 pane 模式下保持独立 session，不参与合并。

## 7. 数据库变更

### groups 表新增字段

```sql
ALTER TABLE groups ADD COLUMN main_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
```

### sessions 表

无新增字段。`group_id` 已有，用于关联。pane 在 tmux 中的 pane_id 是运行时状态，不持久化。

## 8. 右键菜单变更

### 组级右键菜单（TagCloud 中的 group header）

新增：
- "在此组创建会话" — 在该组的 tmux session 中 split-window + 启动 claude

### 会话级右键菜单

新增（仅 pane 模式下显示）：
- "设为主窗口" — 将该 pane swap 到主 pane 位置，更新 `main_session_id`

## 9. 不在范围内

| 功能 | 原因 |
|------|------|
| 自定义布局比例 | YAGNI，35% 固定即可 |
| pane 拖拽排序 | 用 tmux 原生操作 |
| 每组独立选择模式 | 用户选择了全局开关 |
| 多 CLI 工具支持 | 当前仅 claude |
| 自动创建 pane | 用户选择了手动右键创建 |
