# Group 归档功能

日期:2026-07-03
状态:已批准,实现中

## 背景 / 目标

会话可以按 group 分组,但用完的 group 一直堆在主界面。加一个"归档":把整个 group 从主界面收起、结束其后台会话,但数据全部保留,需要时可一键恢复。

## 已定决策

- **归档语义**:从主界面收起、数据全保留(group + 会话记录都不删)。
- **组内 tmux 会话**:归档时 **kill 掉 tmux,只留 DB 记录**(status→dead)。
- **查看/恢复**:单独「已归档」列表 + 一键取消归档拉回主界面。
- **入口**:「已归档」列表放**设置面板**(SettingsPanel);「归档」动作放 group 右键菜单。

## 数据层

`groups` 表加一列(本地 sqlite,启动自动迁移;`try/catch` 兜住已存在):

```sql
ALTER TABLE groups ADD COLUMN archived INTEGER NOT NULL DEFAULT 0
```

`session-repo.ts`:
- `GroupRow` 加 `archived: number`
- `listGroups()` 默认只返回 `archived = 0`(主界面自动过滤掉归档的,TagCloud 渲染逻辑不用改)
- 新增 `listArchivedGroups()` → 返回 `archived = 1`
- 新增 `setGroupArchived(id, archived: boolean)`

## 主进程 IPC(session-handlers.ts)

| IPC | 行为 |
|---|---|
| `group:archive(groupId)` | 遍历 `listSessionsByGroup(groupId)`:对每个会话 `killSessionTmux(session)`(复用现有,kill tmux 不删记录) + `updateSessionStatus(id, 'dead')`;最后 `setGroupArchived(groupId, true)` |
| `group:unarchive(groupId)` | `setGroupArchived(groupId, false)` + 组内 `dead → detached` |
| `group:list-archived` | 返回归档 group,每个附带会话数(`listSessionsByGroup(id).length`) |
| `group:list` | 不变(内部走 `listGroups()`,已只返回未归档) |

### 实现中发现的两处修正(2026-07-06)

1. **重启防复活**:`syncAndList` 首次 sync 的 auto-restore 循环不检查 status,归档的 dead 行会被 `tryRestoreSession` 复活(现有代码没暴露是因为 kill 即删记录,dead 行从不长存;归档首次引入长期 dead 行)。→ restore 循环跳过归档组的会话(`listArchivedGroups` 建 Set 过滤)。
2. **unarchive 改为 dead→detached**:renderer 的 `alive` 过滤掉 dead,若"保持 dead"则恢复后的会话永远不渲染、无法点击。detached 可见,tmux 不存在时常规 sync "keep as-is",点击时走现有 attach 的 on-the-fly restore 重建 —— 正是"点击时重建"的原意。

## renderer

**TagCloud.tsx** — group 右键菜单(`groupCtxMenu`)加一项 **「📦 归档」** → `invoke('group:archive', id)` → `loadGroups()` 刷新,group 从主界面消失。

**SettingsPanel.tsx** — 加「已归档 group」区块:
- 打开时 `invoke('group:list-archived')` 拉列表
- 每行显示 group 名(带颜色点)+ 会话数 + **「取消归档」**按钮 → `invoke('group:unarchive', id)` → 刷新;提示用户去主界面查看

## 关键点

- 归档**不删任何 DB 记录**,只 kill tmux + 标记 → 完整可恢复。
- 复用现有 `killSessionTmux(session)`(session-handlers.ts:83,只 kill tmux 不删记录),不新造 kill 逻辑。
- 恢复后组内会话是 `dead` 态,点击某会话时走现有 attach/restore 重建 tmux(与现在点击 dead 会话一致),归档功能本身不负责重启会话。
- 主界面过滤靠 `listGroups()` 默认排除 archived,`TagCloud` 渲染不变。

## 不做(YAGNI)

- 归档时自动重启/恢复会话(恢复后按需点击重建即可)
- 归档 group 的搜索/排序/批量操作
- 归档单个会话(只归档整个 group)
- 归档导出/跨设备同步

## 验证

项目无单测套件 → `npm run build` 必过 + 手动回归:
1. 建 group + 几个会话 → group 右键「归档」→ group 从主界面消失,组内 tmux 会话被 kill(status dead)。
2. 设置面板「已归档」区看到该 group + 正确会话数。
3. 点「取消归档」→ group 回主界面,组内会话仍在(dead 态)。
4. 点归档恢复后的某会话 → 正常 attach/重建 tmux。
5. 归档后重启 kitty → 归档态保持(仍不在主界面,仍在已归档区)。
6. 删除某归档 group(若走 group:delete)→ 记录清除,不残留。
