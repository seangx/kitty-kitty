# 底栏分组改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 tmux 底栏从单行平铺改为双层分组结构，上层显示组 tab（Ctrl+数字切换），下层显示当前组内会话（Alt+数字切换）。

**Architecture:** 利用 tmux 3.4+ 的 `status 2` 多行 status bar 能力。上层用 `status-format[0]` 渲染组栏脚本，下层用 `status-format[1]` 渲染当前组内会话脚本。当前活跃组 ID 存储在 tmux server 级环境变量 `KITTY_ACTIVE_GROUP` 中。未分组会话归入隐式「未分组」组（group_id = `__ungrouped__`）。空组不显示。

**Tech Stack:** TypeScript (Electron main process), bash (tmux status scripts), SQLite (groups/sessions 表)

---

## File Structure

```
src/main/tmux/session-manager.ts   # 修改: applyKittyStatusBar, bindNumberKeys, refreshAllStatusBars, ensureTabScript
                                    #       → 拆为 ensureGroupBarScript + ensureSessionBarScript
                                    #       → 新增 bindGroupKeys, switchGroup, ensureSwitchGroupScript
```

单文件改动，所有变更集中在 `session-manager.ts` 的 status bar 相关函数。

---

### Task 1: 启用 tmux 双行 status bar + 组栏脚本

**Files:**
- Modify: `src/main/tmux/session-manager.ts:340-498` (applyKittyStatusBar + ensureTabScript)

- [ ] **Step 1: 新增 `ensureGroupBarScript()` 函数**

在 `session-manager.ts` 中 `ensureTabScript()` 之后添加新函数，生成上层组栏的 bash 脚本：

```typescript
function ensureGroupBarScript(): string {
  const { homedir } = require('os')
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_group_bar.sh')
  writeFileSync(scriptPath, `#!/bin/bash
TMUX_BIN="${TMUX}"
DB="${dbPath}"
ACTIVE_GROUP=$($TMUX_BIN show-environment -g KITTY_ACTIVE_GROUP 2>/dev/null | sed 's/^KITTY_ACTIVE_GROUP=//')
[ -z "$ACTIVE_GROUP" ] && ACTIVE_GROUP="__ungrouped__"

BG="#2a2a45"
N=0

# Collect groups that have at least one visible (non-hidden) session
if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  # Named groups with active sessions
  sqlite3 "$DB" "
    SELECT g.id, g.name FROM groups g
    WHERE EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.group_id = g.id AND s.hidden = 0
        AND EXISTS (
          SELECT 1 FROM (SELECT session_name FROM (SELECT '$(echo "\`$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null\`")'))
        )
    )
    ORDER BY g.created_at;
  " 2>/dev/null | while IFS='|' read -r GID GNAME; do
    N=$((N+1))
    # Count sessions in this group
    COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sessions WHERE group_id='$GID' AND hidden=0;" 2>/dev/null)
    if [ "$GID" = "$ACTIVE_GROUP" ]; then
      printf '#[fg=#06b6d4,bg=%s,bold] %d:%s(%d) #[nobold]' "$BG" "$N" "$GNAME" "$COUNT"
    else
      printf '#[fg=#aaa8c3,bg=%s] %d:%s(%d) ' "$BG" "$N" "$GNAME" "$COUNT"
    fi
  done

  # Ungrouped sessions
  UNGROUPED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sessions WHERE (group_id IS NULL OR group_id = '') AND hidden = 0;" 2>/dev/null)
  if [ "$UNGROUPED" -gt 0 ] 2>/dev/null; then
    N=$((N+1))
    if [ "$ACTIVE_GROUP" = "__ungrouped__" ]; then
      printf '#[fg=#06b6d4,bg=%s,bold] %d:未分组(%d) #[nobold]' "$BG" "$N" "$UNGROUPED"
    else
      printf '#[fg=#aaa8c3,bg=%s] %d:未分组(%d) ' "$BG" "$N" "$UNGROUPED"
    fi
  fi
fi
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}
```

**注意**：上面的 shell 脚本中通过 sqlite3 内嵌 tmux list-sessions 来做交叉验证过于复杂。简化方案：只依赖 DB 中 sessions 的 hidden 字段来判断是否有活跃会话，不交叉检查 tmux session 是否真的存活（status bar 5 秒刷新一次，短暂不一致可接受）。

实际简化版：

```typescript
function ensureGroupBarScript(): string {
  const { homedir } = require('os')
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_group_bar.sh')
  writeFileSync(scriptPath, `#!/bin/bash
TMUX_BIN="${TMUX}"
DB="${dbPath}"
ACTIVE_GROUP=$($TMUX_BIN show-environment -g KITTY_ACTIVE_GROUP 2>/dev/null | sed 's/^KITTY_ACTIVE_GROUP=//')
[ -z "$ACTIVE_GROUP" ] && ACTIVE_GROUP="__ungrouped__"

BG="#2a2a45"

if ! [ -f "$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  printf '#[fg=#aaa8c3,bg=%s] (no db) ' "$BG"
  exit 0
fi

# Build group list: id|name|count
# Named groups first, then ungrouped
GROUPS=$(sqlite3 "$DB" "
  SELECT g.id, g.name, COUNT(s.id) as cnt
  FROM groups g
  JOIN sessions s ON s.group_id = g.id AND s.hidden = 0
  GROUP BY g.id
  HAVING cnt > 0
  ORDER BY g.created_at;
" 2>/dev/null)

UNGROUPED_CNT=$(sqlite3 "$DB" "
  SELECT COUNT(*) FROM sessions
  WHERE (group_id IS NULL OR group_id = '') AND hidden = 0;
" 2>/dev/null)

N=0
echo "$GROUPS" | while IFS='|' read -r GID GNAME CNT; do
  [ -z "$GID" ] && continue
  N=$((N+1))
  if [ "$GID" = "$ACTIVE_GROUP" ]; then
    printf '#[fg=#06b6d4,bg=%s,bold] %d:%s(%d) #[nobold]' "$BG" "$N" "$GNAME" "$CNT"
  else
    printf '#[fg=#aaa8c3,bg=%s] %d:%s(%d) ' "$BG" "$N" "$GNAME" "$CNT"
  fi
done

if [ "$UNGROUPED_CNT" -gt 0 ] 2>/dev/null; then
  # N was in subshell, recount
  NAMED_CNT=$(echo "$GROUPS" | grep -c '|')
  UN=$((NAMED_CNT + 1))
  if [ "$ACTIVE_GROUP" = "__ungrouped__" ]; then
    printf '#[fg=#06b6d4,bg=%s,bold] %d:未分组(%d) #[nobold]' "$BG" "$UN" "$UNGROUPED_CNT"
  else
    printf '#[fg=#aaa8c3,bg=%s] %d:未分组(%d) ' "$BG" "$UN" "$UNGROUPED_CNT"
  fi
fi
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}
```

**问题**：bash `while read` 在管道里是子 shell，`N` 递增不会带回父 shell。需要用 process substitution 或改写。最终版本：

```typescript
function ensureGroupBarScript(): string {
  const { homedir } = require('os')
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_group_bar.sh')
  writeFileSync(scriptPath, `#!/bin/bash
TMUX_BIN="${TMUX}"
DB="${dbPath}"
ACTIVE_GROUP=$($TMUX_BIN show-environment -g KITTY_ACTIVE_GROUP 2>/dev/null | sed 's/^KITTY_ACTIVE_GROUP=//')
[ -z "$ACTIVE_GROUP" ] && ACTIVE_GROUP="__ungrouped__"

BG="#2a2a45"

if ! [ -f "$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  printf '#[fg=#aaa8c3,bg=%s] (no db) ' "$BG"
  exit 0
fi

N=0
while IFS='|' read -r GID GNAME CNT; do
  [ -z "$GID" ] && continue
  N=$((N+1))
  if [ "$GID" = "$ACTIVE_GROUP" ]; then
    printf '#[fg=#06b6d4,bg=%s,bold] %d:%s(%d) #[nobold]' "$BG" "$N" "$GNAME" "$CNT"
  else
    printf '#[fg=#aaa8c3,bg=%s] %d:%s(%d) ' "$BG" "$N" "$GNAME" "$CNT"
  fi
done < <(sqlite3 "$DB" "
  SELECT g.id, g.name, COUNT(s.id) as cnt
  FROM groups g
  JOIN sessions s ON s.group_id = g.id AND s.hidden = 0
  GROUP BY g.id
  HAVING cnt > 0
  ORDER BY g.created_at;
" 2>/dev/null)

UNGROUPED_CNT=$(sqlite3 "$DB" "
  SELECT COUNT(*) FROM sessions
  WHERE (group_id IS NULL OR group_id = '') AND hidden = 0;
" 2>/dev/null)

if [ "\${UNGROUPED_CNT:-0}" -gt 0 ] 2>/dev/null; then
  N=$((N+1))
  if [ "$ACTIVE_GROUP" = "__ungrouped__" ]; then
    printf '#[fg=#06b6d4,bg=%s,bold] %d:未分组(%d) #[nobold]' "$BG" "$N" "$UNGROUPED_CNT"
  else
    printf '#[fg=#aaa8c3,bg=%s] %d:未分组(%d) ' "$BG" "$N" "$UNGROUPED_CNT"
  fi
fi
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}
```

- [ ] **Step 2: 改造 `ensureTabScript()` 为 `ensureSessionBarScript()` — 只显示当前组内会话**

将现有 `ensureTabScript()` 重命名为 `ensureSessionBarScript()`，核心变化是加入 group 过滤：

```typescript
function ensureSessionBarScript(): string {
  const { homedir } = require('os')
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_session_bar.sh')
  writeFileSync(scriptPath, `#!/bin/bash
TMUX_BIN="${TMUX}"
CURRENT=$($TMUX_BIN display-message -p '#S')
DB="${dbPath}"
ACTIVE_GROUP=$($TMUX_BIN show-environment -g KITTY_ACTIVE_GROUP 2>/dev/null | sed 's/^KITTY_ACTIVE_GROUP=//')
[ -z "$ACTIVE_GROUP" ] && ACTIVE_GROUP="__ungrouped__"

N=0
$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null | grep '^${SESSION_PREFIX}' | while read -r S; do
  TITLE="$S"
  TOOL=""
  HIDDEN=0
  GROUP_ID=""
  if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
    ROW=$(sqlite3 "$DB" "SELECT title, tool, COALESCE(hidden,0), COALESCE(group_id,'') FROM sessions WHERE tmux_name='$S' LIMIT 1;" 2>/dev/null)
    IFS='|' read -r T TL H GI <<< "$ROW"
    [ -n "$T" ] && TITLE="$T"
    TOOL="$TL"
    HIDDEN="$H"
    GROUP_ID="$GI"
  fi
  [ "$HIDDEN" = "1" ] && continue

  # Filter by active group
  if [ "$ACTIVE_GROUP" = "__ungrouped__" ]; then
    [ -n "$GROUP_ID" ] && continue
  else
    [ "$GROUP_ID" != "$ACTIVE_GROUP" ] && continue
  fi

  N=$((N+1))
  # Status dot
  PANE_CMD=$($TMUX_BIN list-panes -t "$S" -F '#{pane_current_command}' 2>/dev/null | head -1)
  case "$PANE_CMD" in
    bash|zsh|sh|fish|"") DOTCOLOR="#06d6a0" ;;
    *)                   DOTCOLOR="#ffb148" ;;
  esac
  # Git branch
  BRANCH=""
  CWD=""
  if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
    CWD=$(sqlite3 "$DB" "SELECT cwd FROM sessions WHERE tmux_name='$S' LIMIT 1;" 2>/dev/null)
  fi
  if [ -n "$CWD" ] && [ -d "$CWD" ]; then
    B=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -n "$B" ]; then
      case "$B" in
        release*) BCOLOR="#e11d48" ;;
        main|master) BCOLOR="#d97706" ;;
        feature*) BCOLOR="#10b981" ;;
        *) BCOLOR="#8b5cf6" ;;
      esac
      BRANCH="$BCOLOR|$B"
    fi
  fi
  BG="#2a2a45"
  if [ "$S" = "$CURRENT" ]; then
    FG="#06b6d4"
  else
    FG="#aaa8c3"
  fi
  if [ -n "$BRANCH" ]; then
    BCOLOR=$(echo "$BRANCH" | cut -d'|' -f1)
    BNAME=$(echo "$BRANCH" | cut -d'|' -f2)
    printf '#[fg=%s,bg=%s,bold] %d:%s #[fg=%s,bg=%s,nobold]%s #[fg=%s,bg=%s]● #[fg=#46465c,bg=%s,nobold] | ' \\
      "$FG" "$BG" "$N" "$TITLE" "$BCOLOR" "$BG" "$BNAME" "$DOTCOLOR" "$BG" "$BG"
  else
    printf '#[fg=%s,bg=%s,bold] %d:%s #[fg=%s,bg=%s]● #[fg=#46465c,bg=%s,nobold] | ' \\
      "$FG" "$BG" "$N" "$TITLE" "$DOTCOLOR" "$BG" "$BG"
  fi
done
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}
```

- [ ] **Step 3: 修改 `applyKittyStatusBar()` 启用双行**

替换当前的 status 配置为双行模式：

```typescript
export function applyKittyStatusBar(tmuxName: string): void {
  try {
    const groupBarScript = ensureGroupBarScript()
    const sessionBarScript = ensureSessionBarScript()
    const sq = shellQuote(tmuxName)

    // Initialize active group if not set
    try {
      const envOut = execSync(`${TMUX} show-environment -g KITTY_ACTIVE_GROUP`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!envOut || envOut.startsWith('-')) {
        execSync(`${TMUX} set-environment -g KITTY_ACTIVE_GROUP __ungrouped__`, { stdio: 'ignore' })
      }
    } catch {
      execSync(`${TMUX} set-environment -g KITTY_ACTIVE_GROUP __ungrouped__`, { stdio: 'ignore' })
    }

    const opts: string[] = [
      `set-option -t ${sq} status on`,
      `set-option -t ${sq} status-position bottom`,
      `set-option -t ${sq} status 2`,
      // Line 0 (top): group bar
      `set-option -t ${sq} status-format[0] "#[bg=#2a2a45]#(${groupBarScript})#[fill=#2a2a45]"`,
      // Line 1 (bottom): session bar
      `set-option -t ${sq} status-format[1] "#[bg=#2a2a45]#(${sessionBarScript})#[fill=#2a2a45,align=right]#[fg=#aaa8c3] %H:%M "`,
      // No window list — everything is in status-format
      `set-window-option -t ${sq} window-status-format ""`,
      `set-window-option -t ${sq} window-status-current-format ""`,
      `set-option -t ${sq} status-interval 5`,
      `set-option -t ${sq} mouse on`,
    ]

    for (const cmd of opts) {
      try { execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }

    // Keybindings (unchanged except group keys)
    const forkScript = ensureForkScript()
    const closeScript = ensureCloseScript()
    const binds = [
      'bind-key n switch-client -n',
      'bind-key p switch-client -p',
      `bind-key k choose-tree -sZ -F "#{session_name}"`,
      'bind-key -n M-Right split-window -h',
      'bind-key -n M-Down split-window -v',
      `bind-key -n M-Left run-shell -b "${closeScript} '#{pane_id}'"`,
      `bind-key -n M-f command-prompt -p "Fork branch:" "run-shell -b '${forkScript} \\\"%%\\\"'"`,
    ]
    for (const cmd of binds) {
      try { execSync(`${TMUX} ${cmd}`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }

    bindGroupKeys()
    bindSessionKeys()
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: 验证 build**

```bash
cd ~/ai-workspace/kitty-kitty && npm run build
```

Expected: 编译通过，无错误。

- [ ] **Step 5: Commit**

```bash
git add src/main/tmux/session-manager.ts
git commit -m "feat: 双层 status bar — 上层组栏 + 下层会话栏"
```

---

### Task 2: Ctrl+数字切组 + 自动跳转

**Files:**
- Modify: `src/main/tmux/session-manager.ts` (新增 bindGroupKeys, ensureSwitchGroupScript, switchGroup)

- [ ] **Step 1: 新增 `ensureSwitchGroupScript()` — 切组脚本**

该脚本接收目标组的序号，从 DB 查出对应的 group_id，设置 `KITTY_ACTIVE_GROUP` 环境变量，然后 switch-client 到该组最近活跃的会话：

```typescript
function ensureSwitchGroupScript(): string {
  const { homedir } = require('os')
  const dbPath = join(homedir(), 'Library', 'Application Support', 'kitty-kitty', 'kitty-kitty.db')
  const scriptPath = join(tmpdir(), 'kitty_switch_group.sh')
  writeFileSync(scriptPath, `#!/bin/bash
# Usage: kitty_switch_group.sh <group_index>
TMUX_BIN="${TMUX}"
DB="${dbPath}"
TARGET_N="$1"

if ! [ -f "$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# Build ordered group list: same order as group bar script
GROUPS=$(sqlite3 "$DB" "
  SELECT g.id FROM groups g
  JOIN sessions s ON s.group_id = g.id AND s.hidden = 0
  GROUP BY g.id
  HAVING COUNT(s.id) > 0
  ORDER BY g.created_at;
" 2>/dev/null)

UNGROUPED_CNT=$(sqlite3 "$DB" "
  SELECT COUNT(*) FROM sessions
  WHERE (group_id IS NULL OR group_id = '') AND hidden = 0;
" 2>/dev/null)

# Find the Nth group
N=0
TARGET_GID=""
while IFS= read -r GID; do
  [ -z "$GID" ] && continue
  N=$((N+1))
  if [ "$N" = "$TARGET_N" ]; then
    TARGET_GID="$GID"
    break
  fi
done <<< "$GROUPS"

# Check if target is ungrouped
if [ -z "$TARGET_GID" ]; then
  N=$((N+1))
  if [ "$N" = "$TARGET_N" ] && [ "\${UNGROUPED_CNT:-0}" -gt 0 ]; then
    TARGET_GID="__ungrouped__"
  else
    exit 0
  fi
fi

# Set active group
$TMUX_BIN set-environment -g KITTY_ACTIVE_GROUP "$TARGET_GID"

# Find the most recently updated session in this group and switch to it
if [ "$TARGET_GID" = "__ungrouped__" ]; then
  BEST_SESSION=$(sqlite3 "$DB" "
    SELECT tmux_name FROM sessions
    WHERE (group_id IS NULL OR group_id = '') AND hidden = 0
    ORDER BY updated_at DESC LIMIT 1;
  " 2>/dev/null)
else
  BEST_SESSION=$(sqlite3 "$DB" "
    SELECT tmux_name FROM sessions
    WHERE group_id = '$TARGET_GID' AND hidden = 0
    ORDER BY updated_at DESC LIMIT 1;
  " 2>/dev/null)
fi

if [ -n "$BEST_SESSION" ]; then
  $TMUX_BIN switch-client -t "$BEST_SESSION" 2>/dev/null
fi

# Force refresh
$TMUX_BIN refresh-client -S 2>/dev/null
`)
  chmodSync(scriptPath, '755')
  return scriptPath
}
```

- [ ] **Step 2: 新增 `bindGroupKeys()` — 绑 Ctrl+1~9 到切组脚本**

```typescript
function bindGroupKeys(): void {
  const switchScript = ensureSwitchGroupScript()
  for (let i = 1; i <= 9; i++) {
    try {
      execSync(`${TMUX} bind-key -n C-${i} run-shell -b '${switchScript} ${i}'`, { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
}
```

- [ ] **Step 3: 重命名 `bindNumberKeys()` 为 `bindSessionKeys()` — Alt+数字只切当前组内会话**

改造现有 `bindNumberKeys()` 为 `bindSessionKeys()`，使其只绑定当前组内的会话：

```typescript
function bindSessionKeys(): void {
  // Read active group from tmux env
  let activeGroup = '__ungrouped__'
  try {
    const envOut = execSync(`${TMUX} show-environment -g KITTY_ACTIVE_GROUP`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const match = envOut.match(/^KITTY_ACTIVE_GROUP=(.+)$/)
    if (match) activeGroup = match[1]
  } catch { /* use default */ }

  let hiddenNames: Set<string> = new Set()
  try {
    const rows = getDB().prepare("SELECT tmux_name FROM sessions WHERE hidden = 1").all() as Array<{ tmux_name: string }>
    for (const r of rows) hiddenNames.add(r.tmux_name)
  } catch { /* DB may not be ready */ }

  // Get sessions filtered by active group
  let sessions: string[]
  try {
    let query: string
    if (activeGroup === '__ungrouped__') {
      query = "SELECT tmux_name FROM sessions WHERE (group_id IS NULL OR group_id = '') AND hidden = 0 ORDER BY updated_at DESC"
    } else {
      query = `SELECT tmux_name FROM sessions WHERE group_id = '${activeGroup}' AND hidden = 0 ORDER BY updated_at DESC`
    }
    const rows = getDB().prepare(query).all() as Array<{ tmux_name: string }>
    sessions = rows.map(r => r.tmux_name)
  } catch {
    // Fallback: all visible sessions
    sessions = listTmuxSessions().map(s => s.name).filter(n => !hiddenNames.has(n))
  }

  for (let i = 0; i < 9; i++) {
    const target = sessions[i]
    if (target) {
      try {
        execSync(`${TMUX} bind-key -n M-${i + 1} switch-client -t ${shellQuote(target)}`, { stdio: 'ignore' })
      } catch { /* ignore */ }
    } else {
      try {
        execSync(`${TMUX} unbind-key -n M-${i + 1}`, { stdio: 'ignore' })
      } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 4: 更新 `refreshAllStatusBars()` 使用新函数名**

```typescript
export function refreshAllStatusBars(): void {
  const groupBarScript = ensureGroupBarScript()
  const sessionBarScript = ensureSessionBarScript()
  const sessions = listTmuxSessions()
  for (const s of sessions) {
    try {
      const sq = shellQuote(s.name)
      execSync(`${TMUX} set-option -t ${sq} status-format[0] "#[bg=#2a2a45]#(${groupBarScript})#[fill=#2a2a45]"`, { stdio: 'ignore' })
      execSync(`${TMUX} set-option -t ${sq} status-format[1] "#[bg=#2a2a45]#(${sessionBarScript})#[fill=#2a2a45,align=right]#[fg=#aaa8c3] %H:%M "`, { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
  try {
    execSync(`${TMUX} refresh-client -S`, { stdio: 'ignore' })
  } catch { /* ignore */ }
  bindGroupKeys()
  bindSessionKeys()
}
```

- [ ] **Step 5: 删除旧的 `ensureTabScript()` 和 `bindNumberKeys()`**

移除这两个旧函数，确保没有其他地方引用它们。全文搜索 `ensureTabScript` 和 `bindNumberKeys`，将所有调用替换为新函数名。

- [ ] **Step 6: 验证 build**

```bash
cd ~/ai-workspace/kitty-kitty && npm run build
```

Expected: 编译通过，无错误。

- [ ] **Step 7: Commit**

```bash
git add src/main/tmux/session-manager.ts
git commit -m "feat: Ctrl+数字切组 + Alt+数字组内切会话"
```

---

### Task 3: 切组时同步刷新 session bar 的 Alt 键绑定

**Files:**
- Modify: `src/main/tmux/session-manager.ts` (ensureSwitchGroupScript)

切组脚本目前只做了 `switch-client` 和 `refresh-client`，但 Alt+数字的键绑定还停留在旧组的会话列表上。需要在切组后让 Electron 侧刷新 Alt 键绑定。

两个方案：
- A) 切组脚本直接内联重新绑定 Alt 键（纯 bash，不依赖 Electron）
- B) 切组脚本写一个 flag 文件，Electron 侧轮询检测后调 bindSessionKeys

选 A，因为不需要 Electron 参与，响应更快。

- [ ] **Step 1: 在 `ensureSwitchGroupScript()` 末尾追加 Alt 键重绑定逻辑**

在切组脚本的 `refresh-client` 之后，追加从 DB 查当前组会话并绑定 Alt+1~9 的逻辑：

```bash
# Rebind Alt+1~9 to sessions in the new active group
if [ "$TARGET_GID" = "__ungrouped__" ]; then
  SESS_LIST=$(sqlite3 "$DB" "
    SELECT tmux_name FROM sessions
    WHERE (group_id IS NULL OR group_id = '') AND hidden = 0
    ORDER BY updated_at DESC LIMIT 9;
  " 2>/dev/null)
else
  SESS_LIST=$(sqlite3 "$DB" "
    SELECT tmux_name FROM sessions
    WHERE group_id = '$TARGET_GID' AND hidden = 0
    ORDER BY updated_at DESC LIMIT 9;
  " 2>/dev/null)
fi

IDX=0
while IFS= read -r SNAME; do
  [ -z "$SNAME" ] && continue
  IDX=$((IDX+1))
  $TMUX_BIN bind-key -n M-$IDX switch-client -t "$SNAME" 2>/dev/null
done <<< "$SESS_LIST"

# Unbind remaining Alt keys
for i in $(seq $((IDX+1)) 9); do
  $TMUX_BIN unbind-key -n M-$i 2>/dev/null
done
```

将此段追加到 `ensureSwitchGroupScript()` 生成的脚本末尾（在 `refresh-client` 之后）。

- [ ] **Step 2: 验证 build**

```bash
cd ~/ai-workspace/kitty-kitty && npm run build
```

Expected: 编译通过。

- [ ] **Step 3: Commit**

```bash
git add src/main/tmux/session-manager.ts
git commit -m "fix: 切组时同步刷新 Alt+数字键绑定"
```

---

### Task 4: 功能验证

**Files:** 无代码变更，纯测试

- [ ] **Step 1: 启动开发模式**

```bash
cd ~/ai-workspace/kitty-kitty
# 杀掉已有进程
ps aux | grep '[E]lectron.app.*kitty-kitty' | awk '{print $2}' | xargs kill 2>/dev/null; pkill -f 'Kitty Kitty' 2>/dev/null
npm run dev
```

- [ ] **Step 2: 验证无分组时的默认行为**

1. 打开终端查看 tmux status bar
2. 应该看到双层：上层显示 `1:未分组(N)`（加粗），下层显示当前所有非 hidden 会话
3. Alt+1~N 应能切换会话（和之前行为一致）

- [ ] **Step 3: 创建分组并验证切组**

1. 在 kitty-kitty 的 UI 中创建一个分组（或直接 DB 插入测试数据）
2. 将一些会话分配到新组
3. 上层应出现两个组 tab
4. Ctrl+1 / Ctrl+2 切换组，观察：
   - 上层的加粗高亮跟随
   - 下层只显示当前组的会话
   - 自动跳转到该组最近活跃的会话
5. Alt+数字只切换当前组内的会话

- [ ] **Step 4: 验证边界情况**

1. 空组（所有会话都 hidden）不在上层显示
2. 所有会话都未分组时，只显示「未分组」
3. 会话变更（新建/删除/改组）后 5 秒内 status bar 自动刷新

- [ ] **Step 5: Commit 最终状态（如有修复）**

```bash
git add -A
git commit -m "fix: 底栏分组改造 — 修复验证中发现的问题"
```
