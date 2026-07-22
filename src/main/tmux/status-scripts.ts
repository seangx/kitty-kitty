import {
  groupPathForTmuxSql,
  groupSubtreeCte,
  ROOT_GROUPS_SQL,
  rootGroupForTmuxSql,
} from './group-tree-sql.ts'

export interface StatusScriptOptions {
  tmuxBin: string
  dbPath: string
  sessionPrefix: string
}

const shellDoubleQuoted = (value: string): string => value
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\$/g, '\\$')
  .replace(/`/g, '\\`')

/**
 * Tmux supports at most five status rows. One row is always the root bar;
 * the current group's own row only exists when it has navigable child groups.
 */
export function statusLineCountForDepth(depth: number, showCurrentGroupRow = true): number {
  const normalizedDepth = Math.max(0, Math.floor(depth))
  const groupRows = Math.max(0, normalizedDepth - 1) + (showCurrentGroupRow && normalizedDepth > 0 ? 1 : 0)
  return Math.max(1, Math.min(5, groupRows + 1))
}

/** tmux spells a single status row as `on`; numeric row counts start at 2. */
export function statusOptionValueForLineCount(lineCount: number): string {
  return lineCount <= 1 ? 'on' : String(lineCount)
}

/**
 * Dynamic renderer for one tmux status row.
 *
 * The bottom row contains root groups. Every group in the current tmux
 * session's ancestor path adds a row above it. Each added row is padded to the
 * cell where its parent group starts, then clamped against the client width.
 */
export function buildStatusRowScript(options: StatusScriptOptions): string {
  const tmuxBin = shellDoubleQuoted(options.tmuxBin)
  const dbPath = shellDoubleQuoted(options.dbPath)

  return `#!/bin/bash
ROW_INDEX="\$1"
RENDER_SESSION="\$2"
ACTIVE_PANE="\$3"
CLIENT_WIDTH="\$4"
TMUX_BIN="${tmuxBin}"
DB="${dbPath}"
SESSION_PREFIX="${options.sessionPrefix}"
GBG="#1e1e36"
SEP=$'\\037'

case "\$ROW_INDEX" in *[!0-9]*|'') exit 0 ;; esac
case "\$CLIENT_WIDTH" in *[!0-9]*|'') CLIENT_WIDTH=200 ;; esac

if ! [ -f "\$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  printf '#[fg=#aaa8c3,bg=%s]  (no db)  ' "\$GBG"
  exit 0
fi

clean_text() {
  printf '%s' "\$1" | tr '\\r\\n' '  '
}

escape_status_text() {
  clean_text "\$1" | sed 's/#/##/g'
}

display_width() {
  local SAFE WIDTH
  SAFE=\$(clean_text "\$1" | tr '#}' '??')
  WIDTH=\$(\$TMUX_BIN display-message -p "#{w:#{l:\$SAFE}}" 2>/dev/null)
  case "\$WIDTH" in *[!0-9]*|'') WIDTH=\${#SAFE} ;; esac
  printf '%s' "\$WIDTH"
}

ALIVE=""
while read -r TNAME; do
  [ -z "\$TNAME" ] && continue
  ALIVE="\$ALIVE|\$TNAME|"
done < <(\$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null | grep "^\$SESSION_PREFIX")

tmux_is_alive() {
  case "\$ALIVE" in *"|\$1|"*) return 0 ;; *) return 1 ;; esac
}

group_has_alive() {
  local GID="\$1" TNAME
  while read -r TNAME; do
    [ -z "\$TNAME" ] && continue
    if tmux_is_alive "\$TNAME"; then return 0; fi
  done < <(sqlite3 "\$DB" "${groupSubtreeCte("'\$GID'")} SELECT DISTINCT tmux_name FROM sessions WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden,0)=0;" 2>/dev/null)
  return 1
}

group_count() {
  local GID="\$1"
  sqlite3 "\$DB" "${groupSubtreeCte("'\$GID'")} SELECT COUNT(*) FROM sessions WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden,0)=0;" 2>/dev/null
}

ITEMS_PLAIN=""
ITEMS_FORMAT=""
TARGET_PREFIX=""
ANCHOR_TARGET=""
ITEM_NO=0

add_item() {
  local KIND="\$1" ID="\$2" NAME="\$3" COUNT="\$4" ACTIVE="\$5" RANGE="\$6"
  local LABEL SAFE_LABEL SEP_TEXT STYLE
  ITEM_NO=\$((ITEM_NO+1))
  NAME=\$(clean_text "\$NAME")
  if [ "\$KIND" = "group" ]; then
    LABEL="  \$ITEM_NO  \$NAME (\${COUNT:-0})  "
  else
    LABEL="  \$ITEM_NO  \$NAME  "
  fi
  SEP_TEXT=""
  [ -n "\$ITEMS_PLAIN" ] && SEP_TEXT=" "
  if [ -n "\$ANCHOR_TARGET" ] && [ "\$ID" = "\$ANCHOR_TARGET" ]; then
    TARGET_PREFIX="\$ITEMS_PLAIN\$SEP_TEXT"
  fi
  ITEMS_PLAIN="\$ITEMS_PLAIN\$SEP_TEXT\$LABEL"
  SAFE_LABEL=\$(escape_status_text "\$LABEL")
  if [ "\$ACTIVE" = "1" ]; then
    # Per-session colors let navigation pulse the selected hierarchy without
    # rebuilding a row or bringing back tmux's asynchronous command cache.
    STYLE='#[fg=#{@kitty_active_fg},bg=#{@kitty_active_bg},bold]'
  else
    STYLE='#[fg=#706f8a,bg=#1e1e36]'
  fi
  [ -n "\$ITEMS_FORMAT" ] && ITEMS_FORMAT="\$ITEMS_FORMAT#[fg=#3a3a5c,bg=\$GBG] "
  ITEMS_FORMAT="\$ITEMS_FORMAT#[range=user|\$RANGE]\$STYLE\$SAFE_LABEL#[norange]#[bg=\$GBG]"
}

build_root_items() {
  local ACTIVE_ROOT="\$1" GID GNAME COUNT ACTIVE TNAME SID TITLE RANGE_INDEX
  ITEMS_PLAIN=""
  ITEMS_FORMAT=""
  TARGET_PREFIX=""
  ITEM_NO=0

  while IFS="\$SEP" read -r GID GNAME; do
    [ -z "\$GID" ] && continue
    group_has_alive "\$GID" || continue
    COUNT=\$(group_count "\$GID")
    ACTIVE=0
    [ "\$GID" = "\$ACTIVE_ROOT" ] && ACTIVE=1
    RANGE_INDEX=\$((ITEM_NO+1))
    add_item group "\$GID" "\$GNAME" "\$COUNT" "\$ACTIVE" "kr:\$RANGE_INDEX"
  done < <(sqlite3 -separator "\$SEP" "\$DB" "${ROOT_GROUPS_SQL}" 2>/dev/null)

  while IFS="\$SEP" read -r SID TNAME TITLE; do
    [ -z "\$SID" ] && continue
    tmux_is_alive "\$TNAME" || continue
    ACTIVE=0
    [ "\$TNAME" = "\$RENDER_SESSION" ] && ACTIVE=1
    RANGE_INDEX=\$((ITEM_NO+1))
    add_item session "\$SID" "\${TITLE:-\$TNAME}" "" "\$ACTIVE" "kr:\$RANGE_INDEX"
  done < <(sqlite3 -separator "\$SEP" "\$DB" "SELECT id, tmux_name, title FROM sessions WHERE (group_id IS NULL OR group_id='') AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;" 2>/dev/null)
}

build_group_items() {
  local GID="\$1" GNAME="\$2" ACTIVE_CHILD="\$3"
  local TNAME ACTIVE CHILD_ID CHILD_NAME COUNT GROUP_LABEL HAS_ALIVE
  GROUP_LABEL="  \$(clean_text "\$GNAME") ›"
  ITEMS_PLAIN="\$GROUP_LABEL"
  ITEMS_FORMAT="#[fg=#aaa8c3,bg=\$GBG]\$(escape_status_text "\$GROUP_LABEL")"
  TARGET_PREFIX=""
  ITEM_NO=0

  COUNT=\$(sqlite3 "\$DB" "SELECT COUNT(*) FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0;" 2>/dev/null)
  HAS_ALIVE=0
  while read -r TNAME; do
    [ -z "\$TNAME" ] && continue
    if tmux_is_alive "\$TNAME"; then HAS_ALIVE=1; break; fi
  done < <(sqlite3 "\$DB" "SELECT DISTINCT tmux_name FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0;" 2>/dev/null)
  if [ "\$HAS_ALIVE" -eq 1 ] && [ "\${COUNT:-0}" -gt 0 ]; then
    ACTIVE=0
    [ -z "\$ACTIVE_CHILD" ] && ACTIVE=1
    add_item group "direct:\$GID" "未分组" "\$COUNT" "\$ACTIVE" "kd:\$GID"
  fi

  while IFS="\$SEP" read -r CHILD_ID CHILD_NAME; do
    [ -z "\$CHILD_ID" ] && continue
    group_has_alive "\$CHILD_ID" || continue
    COUNT=\$(group_count "\$CHILD_ID")
    ACTIVE=0
    [ "\$CHILD_ID" = "\$ACTIVE_CHILD" ] && ACTIVE=1
    add_item group "\$CHILD_ID" "\$CHILD_NAME" "\$COUNT" "\$ACTIVE" "kg:\$CHILD_ID"
  done < <(sqlite3 -separator "\$SEP" "\$DB" "SELECT id, name FROM groups WHERE parent_group_id='\$GID' ORDER BY created_at;" 2>/dev/null)
}

PATH_IDS=()
PATH_NAMES=()
while IFS="\$SEP" read -r GID GNAME _PARENT; do
  [ -z "\$GID" ] && continue
  PATH_IDS[\${#PATH_IDS[@]}]="\$GID"
  PATH_NAMES[\${#PATH_NAMES[@]}]="\$GNAME"
done < <(sqlite3 -separator "\$SEP" "\$DB" "${groupPathForTmuxSql("'\$RENDER_SESSION'")}" 2>/dev/null)

PATH_DEPTH=\${#PATH_IDS[@]}
SHOW_CURRENT_ROW=0
if [ "\$PATH_DEPTH" -gt 0 ]; then
  CURRENT_GID="\${PATH_IDS[\$((PATH_DEPTH-1))]}"
  while read -r CHILD_ID; do
    [ -z "\$CHILD_ID" ] && continue
    if group_has_alive "\$CHILD_ID"; then SHOW_CURRENT_ROW=1; break; fi
  done < <(sqlite3 "\$DB" "SELECT id FROM groups WHERE parent_group_id='\$CURRENT_GID' ORDER BY created_at;" 2>/dev/null)
fi

MAX_TARGET_INDEX=\$((PATH_DEPTH-2+SHOW_CURRENT_ROW))
VISIBLE_GROUP_ROWS=\$((MAX_TARGET_INDEX+1))
[ "\$VISIBLE_GROUP_ROWS" -lt 0 ] && VISIBLE_GROUP_ROWS=0
[ "\$VISIBLE_GROUP_ROWS" -gt 4 ] && VISIBLE_GROUP_ROWS=4
ROOT_ROW=\$VISIBLE_GROUP_ROWS

if [ "\$ROW_INDEX" -eq "\$ROOT_ROW" ]; then
  ACTIVE_ROOT="__ungrouped__"
  [ "\$PATH_DEPTH" -gt 0 ] && ACTIVE_ROOT="\${PATH_IDS[0]}"
  ANCHOR_TARGET=""
  build_root_items "\$ACTIVE_ROOT"
  printf '%s' "\$ITEMS_FORMAT"
  exit 0
fi

if [ "\$ROW_INDEX" -gt "\$ROOT_ROW" ] || [ "\$PATH_DEPTH" -eq 0 ]; then exit 0; fi

TARGET_INDEX=\$((MAX_TARGET_INDEX-ROW_INDEX))
INDENT=0

# Root group anchor.
ANCHOR_TARGET="\${PATH_IDS[0]}"
build_root_items "\${PATH_IDS[0]}"
STEP=\$(display_width "\$TARGET_PREFIX")
INDENT=\$((INDENT+STEP))

# Every deeper group is anchored to its button in the parent group's row.
LEVEL=1
while [ "\$LEVEL" -le "\$TARGET_INDEX" ]; do
  PARENT_INDEX=\$((LEVEL-1))
  ANCHOR_TARGET="\${PATH_IDS[\$LEVEL]}"
  build_group_items "\${PATH_IDS[\$PARENT_INDEX]}" "\${PATH_NAMES[\$PARENT_INDEX]}" "\${PATH_IDS[\$LEVEL]}"
  STEP=\$(display_width "\$TARGET_PREFIX")
  INDENT=\$((INDENT+STEP))
  LEVEL=\$((LEVEL+1))
done

NEXT_INDEX=\$((TARGET_INDEX+1))
ACTIVE_CHILD=""
[ "\$NEXT_INDEX" -lt "\$PATH_DEPTH" ] && ACTIVE_CHILD="\${PATH_IDS[\$NEXT_INDEX]}"
ANCHOR_TARGET=""
build_group_items "\${PATH_IDS[\$TARGET_INDEX]}" "\${PATH_NAMES[\$TARGET_INDEX]}" "\$ACTIVE_CHILD"

ROW_WIDTH=\$(display_width "\$ITEMS_PLAIN")
MAX_INDENT=\$((CLIENT_WIDTH-ROW_WIDTH))
[ "\$MAX_INDENT" -lt 0 ] && MAX_INDENT=0
[ "\$INDENT" -gt "\$MAX_INDENT" ] && INDENT="\$MAX_INDENT"
printf '#[bg=%s]%*s%s' "\$GBG" "\$INDENT" '' "\$ITEMS_FORMAT"
`
}

/** Script used by clicks and Alt+number for items inside the current group. */
export function buildStatusNavigateScript(options: StatusScriptOptions): string {
  const tmuxBin = shellDoubleQuoted(options.tmuxBin)
  const dbPath = shellDoubleQuoted(options.dbPath)

  return `#!/bin/bash
ACTION="\$1"
VALUE="\$2"
RENDER_SESSION="\$3"
CLIENT="\$4"
TMUX_BIN="${tmuxBin}"
DB="${dbPath}"
SESSION_PREFIX="${options.sessionPrefix}"
SEP=$'\\037'

if ! [ -f "\$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then exit 0; fi
case "\$ACTION" in group|direct|level-index) ;; *) exit 0 ;; esac
case "\$ACTION" in
  level-index) case "\$VALUE" in *[!0-9]*|'') exit 0 ;; esac ;;
  *) case "\$VALUE" in *[!A-Za-z0-9_-]*|'') exit 0 ;; esac ;;
esac

ALIVE=""
while read -r TNAME; do
  [ -z "\$TNAME" ] && continue
  ALIVE="\$ALIVE|\$TNAME|"
done < <(\$TMUX_BIN list-sessions -F '#{session_name}' 2>/dev/null | grep "^\$SESSION_PREFIX")

tmux_is_alive() {
  case "\$ALIVE" in *"|\$1|"*) return 0 ;; *) return 1 ;; esac
}

ensure_client() {
  if [ -n "\$CLIENT" ]; then
    if \$TMUX_BIN list-clients -F '#{client_name}' 2>/dev/null | grep -Fxq "\$CLIENT"; then return; fi
  fi
  CLIENT=\$(\$TMUX_BIN list-clients -F '#{client_name}' 2>/dev/null | head -1)
}

finish_navigation() {
  local TARGET_TMUX="\$1" TARGET_PANE="\$2" ROOT_GID
  [ -z "\$TARGET_TMUX" ] && exit 0
  tmux_is_alive "\$TARGET_TMUX" || exit 0
  if [ -n "\$TARGET_PANE" ]; then \$TMUX_BIN select-pane -t "\$TARGET_PANE" 2>/dev/null || true; fi
  ensure_client
  if [ -n "\$CLIENT" ]; then
    # Prime the target before switching so the first visible destination frame
    # is already the pressed state. Two short color steps settle to normal.
    \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_fg '#cffafe' 2>/dev/null || true
    \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_bg '#155e75' 2>/dev/null || true
    if ! \$TMUX_BIN switch-client -c "\$CLIENT" -t "\$TARGET_TMUX" 2>/dev/null; then
      \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_fg '#06b6d4' 2>/dev/null || true
      \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_bg '#3a3a5c' 2>/dev/null || true
      exit 0
    fi
  fi
  ROOT_GID=\$(sqlite3 "\$DB" "${rootGroupForTmuxSql("'\$TARGET_TMUX'")}" 2>/dev/null)
  [ -z "\$ROOT_GID" ] && ROOT_GID="__ungrouped__"
  \$TMUX_BIN set-environment -g KITTY_ACTIVE_GROUP "\$ROOT_GID" 2>/dev/null || true
  \$TMUX_BIN refresh-client -S 2>/dev/null || true
  if [ -n "\$CLIENT" ]; then
    sleep 0.045
    \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_fg '#67e8f9' 2>/dev/null || true
    \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_bg '#334155' 2>/dev/null || true
    \$TMUX_BIN refresh-client -S 2>/dev/null || true
    sleep 0.045
    \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_fg '#06b6d4' 2>/dev/null || true
    \$TMUX_BIN set-option -t "\$TARGET_TMUX" @kitty_active_bg '#3a3a5c' 2>/dev/null || true
    \$TMUX_BIN refresh-client -S 2>/dev/null || true
  fi
  exit 0
}

navigate_group() {
  local GID="\$1" TARGET_TMUX CANDIDATE
  # Prefer this group's own tmux so opening a group stops at that hierarchy
  # level instead of jumping straight into the most recently used descendant.
  while read -r CANDIDATE; do
    [ -z "\$CANDIDATE" ] && continue
    if tmux_is_alive "\$CANDIDATE"; then TARGET_TMUX="\$CANDIDATE"; break; fi
  done < <(sqlite3 "\$DB" "SELECT tmux_name FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;" 2>/dev/null)
  if [ -z "\$TARGET_TMUX" ]; then
    while read -r CANDIDATE; do
      [ -z "\$CANDIDATE" ] && continue
      if tmux_is_alive "\$CANDIDATE"; then TARGET_TMUX="\$CANDIDATE"; break; fi
    done < <(sqlite3 "\$DB" "${groupSubtreeCte("'\$GID'")} SELECT tmux_name FROM sessions WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;" 2>/dev/null)
  fi
  finish_navigation "\$TARGET_TMUX" ""
}

navigate_direct() {
  local GID="\$1" TARGET_TMUX CANDIDATE
  while read -r CANDIDATE; do
    [ -z "\$CANDIDATE" ] && continue
    if tmux_is_alive "\$CANDIDATE"; then TARGET_TMUX="\$CANDIDATE"; break; fi
  done < <(sqlite3 "\$DB" "SELECT tmux_name FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;" 2>/dev/null)
  finish_navigation "\$TARGET_TMUX" ""
}

navigate_level_index() {
  local IDX="\$1" GID N TNAME CHILD_ID CHILD_NAME HAS_DIRECT HAS_CHILD TARGET
  GID=\$(sqlite3 "\$DB" "SELECT COALESCE(group_id,'') FROM sessions WHERE tmux_name='\$RENDER_SESSION' AND COALESCE(hidden,0)=0 LIMIT 1;" 2>/dev/null)
  [ -z "\$GID" ] && exit 0
  HAS_CHILD=0
  while read -r CHILD_ID; do
    [ -z "\$CHILD_ID" ] && continue
    TARGET=""
    while read -r TNAME; do
      [ -z "\$TNAME" ] && continue
      if tmux_is_alive "\$TNAME"; then TARGET="\$TNAME"; break; fi
    done < <(sqlite3 "\$DB" "${groupSubtreeCte("'\$CHILD_ID'")} SELECT DISTINCT tmux_name FROM sessions WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden,0)=0;" 2>/dev/null)
    if [ -n "\$TARGET" ]; then HAS_CHILD=1; break; fi
  done < <(sqlite3 "\$DB" "SELECT id FROM groups WHERE parent_group_id='\$GID' ORDER BY created_at;" 2>/dev/null)
  [ "\$HAS_CHILD" -eq 0 ] && exit 0

  N=0
  HAS_DIRECT=0
  while read -r TNAME; do
    [ -z "\$TNAME" ] && continue
    if tmux_is_alive "\$TNAME"; then HAS_DIRECT=1; break; fi
  done < <(sqlite3 "\$DB" "SELECT DISTINCT tmux_name FROM sessions WHERE group_id='\$GID' AND COALESCE(hidden,0)=0;" 2>/dev/null)
  if [ "\$HAS_DIRECT" -eq 1 ]; then
    N=\$((N+1))
    if [ "\$N" -eq "\$IDX" ]; then exec "\$0" direct "\$GID" "\$RENDER_SESSION" "\$CLIENT"; fi
  fi

  while IFS="\$SEP" read -r CHILD_ID CHILD_NAME; do
    [ -z "\$CHILD_ID" ] && continue
    TARGET=""
    while read -r TNAME; do
      [ -z "\$TNAME" ] && continue
      if tmux_is_alive "\$TNAME"; then TARGET="\$TNAME"; break; fi
    done < <(sqlite3 "\$DB" "${groupSubtreeCte("'\$CHILD_ID'")} SELECT DISTINCT tmux_name FROM sessions WHERE group_id IN (SELECT id FROM subtree) AND COALESCE(hidden,0)=0 ORDER BY updated_at DESC;" 2>/dev/null)
    [ -z "\$TARGET" ] && continue
    N=\$((N+1))
    if [ "\$N" -eq "\$IDX" ]; then exec "\$0" group "\$CHILD_ID" "\$RENDER_SESSION" "\$CLIENT"; fi
  done < <(sqlite3 -separator "\$SEP" "\$DB" "SELECT id, name FROM groups WHERE parent_group_id='\$GID' ORDER BY created_at;" 2>/dev/null)
}

case "\$ACTION" in
  group) navigate_group "\$VALUE" ;;
  direct) navigate_direct "\$VALUE" ;;
  level-index) navigate_level_index "\$VALUE" ;;
esac
`
}
