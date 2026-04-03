# 通信系统重构设计

将 kitty-talk 从「Group 协作开关控制」改为「全局注入 + Group 作为默认视角」，实现任意 session 间点对点通信。

## 现状问题

1. kitty-talk 只在 Group 开启协作时注入，未加组的 session 无法通信
2. `talk` 和 `peers` 受 GROUP_ID 限制，跨组不可见不可联系
3. Group 同时承担 UI 分组和通信域两个职责，概念耦合
4. 「协作开/关」开关语义不清，用户需要「建组 → 加 session → 开协作」三步才能通信

## 目标

- 任何 session 都能联系任何 session（点对点）
- Group 是默认通信视角，不是通信壁垒
- 去掉「协作开/关」开关，加入 Group 即可互相发现
- 简化注入流程，session 创建时自动获得通信能力

## 设计

### 注入策略

kitty-talk 在 session 创建时与 kitty-session 一起注入到 `.mcp.json`。

环境变量：
- `KITTY_AGENT_ID` — session id
- `KITTY_AGENT_NAME` — session title
- `KITTY_BUS_DIR` — 消息总线目录
- `KITTY_GROUP_ID` — 所属 group id（无组时为空）

注入时机：
- `session:create` — 新建 session 时
- `session:create-in-dir-confirm` — 在目录中创建时
- `session:set-group` — 加入/退出 Group 时更新 GROUP_ID
- `session:sync`（首次启动） — 恢复已有 session 时

### talk 工具

去掉 GROUP_ID 限制。查找目标时搜索全部 agents，不再 filter by groupId。

新增组播语法：`talk(to: "@groupName")` 向组内所有成员逐个发送消息。

目标处理：
- 精确匹配 name 或 id → 直接发送
- 同名冲突 → 返回候选列表（含 id 和 cwd），让 agent 选择
- 目标不在线（agents.json 中无记录或 inbox 无人消费）→ 消息仍写入 inbox，返回提示「消息已暂存，对方恢复后可通过 listen 查看」

### peers 工具

默认行为按 GROUP_ID 决定：
- 有 GROUP_ID → 列同组成员
- 无 GROUP_ID → 列全部在线 session

支持 `--all` flag 列全部，按 group 分段展示。

输出格式增加元信息：
```
agent-name [id] (tool: claude, group: registry, cwd: /path/to/project) active
```

### Group 职责变化

| 之前 | 之后 |
|------|------|
| UI 分组 + 通信域 | UI 分组 + 默认 peers 视角 |
| 协作开/关控制注入 | 加入 Group 自动更新 GROUP_ID |
| startCollaboration 注入 + 重启 | 写 .mcp.json 更新 GROUP_ID（不重启） |
| stopCollaboration 移除 + 重启 | 清除 GROUP_ID（不重启） |

去掉 `collabEnabled` 字段和「群聊开/关」UI 开关。

### InboxWatcher

所有注入了 kitty-talk 的 session 自动被 watch。逻辑不变，只是覆盖范围从「协作组内 session」扩大到「所有有 cwd 的 session」。

### 气泡展示

所有 session 默认有通信能力，不需要额外状态标识。Group 归属沿用现有 UI。

## 文件变更

| 文件 | 变更 |
|------|------|
| `src/main/mcp/session-mcp-manager.ts` | 注入 kitty-talk（与 kitty-session 合并），支持 GROUP_ID 更新 |
| `src/main/mcp/server-script.ts` | `talk` 去 GROUP_ID 限制 + 组播 + 冲突处理；`peers` 默认同组/`--all` 全部 + 元信息 |
| `src/main/mcp/collab-manager.ts` | 简化：去掉 startCollaboration/stopCollaboration 中的注入逻辑，保留 InboxWatcher 管理 |
| `src/main/ipc/session-handlers.ts` | session 创建时注入 kitty-talk；set-group 时更新 GROUP_ID；去掉 `group:collab:set-enabled` |
| `src/main/db/session-repo.ts` | 去掉 `collabEnabled` 相关查询（或忽略该字段） |
| `src/renderer/pet/TagCloud.tsx` | 去掉「群聊开/关」按钮 |

## 迁移

- `collabEnabled` 字段保留在 DB 但不再使用，不做数据迁移
- 现有已注入 kitty-talk 的 session 不受影响（.mcp.json 格式不变）
- 首次 sync 时为所有有 cwd 的 session 补注入 kitty-talk

## 命名唯一性

session name（title）可能重复。`talk` 查找目标时：
1. 先按 name 精确匹配
2. 多个匹配 → 返回候选列表（name + id + cwd）
3. agent 用 id 重新 `talk`

不强制全局唯一，通过交互式消歧解决。
