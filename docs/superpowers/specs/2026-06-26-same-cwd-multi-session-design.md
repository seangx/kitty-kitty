# 同一目录下多 claude 会话隔离

日期:2026-06-26
状态:已批准,实现中

## 背景 / 问题

kitty-kitty 把磁盘上的 claude transcript(`~/.claude/projects/<encode(cwd)>/<uuid>.jsonl`)认领给某个会话时,依赖 **cwd 近似唯一**。运行时靠 per-pane 注入的 `HIVE_AGENT_KEY`(= kitty session id)精确区分,但所有「离线/新建窗口期/兜底回填」路径只有 cwd 可用:

- `syncExternalSessionIds()`(`session-handlers.ts`)对未绑定会话按 `findUnclaimedSessionId(cwd, claimed)` 取「最新未认领 jsonl」,纯按 mtime + claimed 盲配,与真实归属无关。

因此**同一 cwd 开两个 claude 会话**时,在「启动到第一次 wakeup hook」窗口期若发生重启/扫描,两会话的对话历史会张冠李戴(详见调查结论)。

需求:允许同一目录开多个 claude 会话各做各的事;memory 共享可接受。

## 方案(已批准:方案 3 = 根治 + 兜底)

### 改动 A —— claude 新建会话预指定 session-id(根治)

claude CLI(已确认 2.1.187)支持 `--session-id <uuid>`。新建 claude 会话时由 kitty 预生成完整 v4 uuid,用 `claude --session-id <uuid>` 启动,并**在创建当刻写入 DB 的 `externalSessionId`**。

- jsonl 必然以该 uuid 命名,kitty 从第一秒就知道归属,**不再事后按 cwd 猜**。
- 重启后 `syncExternalSessionIds` 见 `externalSessionId` 已存在 → 跳过,不进盲配。
- jsonl 懒创建也无妨,认领不再依赖扫盘。
- 同 cwd 多会话各拿不同 uuid,天然隔离。

实现:
- `cli-wrapper.ts`:`ToolConfig` 增 `sessionIdFlag?`;claude 配 `sessionIdFlag: '--session-id'`;`generateLaunchScript` 增第 5 参 `sessionId?`;`buildNewScript(config, sessionId?)` 在 `sessionId && config.sessionIdFlag` 时追加 flag(codex 无此字段 → 不注入)。
- `session-handlers.ts` 三个新建入口的 claude 分支:`const sid = uuid()`(完整 uuid,非 `.slice(0,8)` 短 id)→ 传入 `generateLaunchScript` → 落库 `updateSessionExternalId(session.id, sid)`。入口 3(create-in-dir-confirm)仅 `mode==='new'` 时生成。

### 改动 B —— 盲配兜底(防御保险)

`syncExternalSessionIds`:先统计每个 cwd 下 `needsSync` 会话数,**某 cwd >1 个未绑定就跳过该 cwd 的全部盲配**(宁可不绑,等 hook 用 header 精确回填)。兜住老会话、codex、hook 失败等一切遗漏路径,使「宁可不绑也不错绑」成为系统底线。

## 不变项

清空对话(`/clear` → claude 自滚新 id → markCleared 期间禁盲配 → wakeup Stop hook 用 header 精确回填);resume/restart(用已存 `externalSessionId`);codex bridge;memory 共享。

## 边界

- `--session-id` 仅 new 注入;resume/restore 用 resumeId,不冲突。
- 老会话(已有 externalSessionId)不受影响。
- codex 不支持预指定 → 维持现状,由改动 B 兜底。
- claude 版本:直接用 `--session-id`(kitty 本就要求装 claude),不做版本探测(YAGNI)。
- uuid v4 碰撞:忽略。

## 验证

项目无单测套件 → `npm run build` 必过 + 手动回归:
1. 同目录连开 2 个 claude,各发不同消息 → 历史不串。
2. 重启 kitty → 两会话各自恢复正确历史。
3. 其一清空对话 → 另一个不受影响,清空者拿到新历史。
4. 升级前老会话仍能正常 resume。
5. codex(bridge on)不受影响。
