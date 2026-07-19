/** Root groups are the only hierarchy level rendered in tmux's status bar. */
export const ROOT_GROUPS_SQL = `
  SELECT id, name
  FROM groups
  WHERE parent_group_id IS NULL
  ORDER BY created_at;
`.trim()

/**
 * Resolve the root group for a tmux session. `tmuxNameSql` is a SQL value
 * expression: use `?` for better-sqlite3 or a quoted shell variable in the
 * generated sqlite3 helper script.
 */
export function rootGroupForTmuxSql(tmuxNameSql: string): string {
  return `
    WITH RECURSIVE ancestors(id, parent_group_id) AS (
      SELECT g.id, g.parent_group_id
      FROM groups g
      WHERE g.id = (
        SELECT group_id FROM sessions WHERE tmux_name = ${tmuxNameSql} LIMIT 1
      )
      UNION ALL
      SELECT parent.id, parent.parent_group_id
      FROM groups parent
      JOIN ancestors child ON child.parent_group_id = parent.id
    )
    SELECT COALESCE(
      (SELECT id FROM ancestors WHERE parent_group_id IS NULL LIMIT 1),
      '__ungrouped__'
    ) AS group_id;
  `.trim()
}

/** Resolve the complete group path for a tmux session, ordered root-first. */
export function groupPathForTmuxSql(tmuxNameSql: string): string {
  return `
    WITH RECURSIVE ancestors(id, name, parent_group_id, depth) AS (
      SELECT g.id, g.name, g.parent_group_id, 0
      FROM groups g
      WHERE g.id = (
        SELECT group_id FROM sessions
        WHERE tmux_name = ${tmuxNameSql} AND COALESCE(hidden, 0) = 0
        LIMIT 1
      )
      UNION ALL
      SELECT parent.id, parent.name, parent.parent_group_id, child.depth + 1
      FROM groups parent
      JOIN ancestors child ON child.parent_group_id = parent.id
    )
    SELECT id, name, COALESCE(parent_group_id, '')
    FROM ancestors
    ORDER BY depth DESC;
  `.trim()
}

/** Number of group levels containing the tmux session (zero when ungrouped). */
export function groupDepthForTmuxSql(tmuxNameSql: string): string {
  return `
    WITH RECURSIVE ancestors(id, parent_group_id) AS (
      SELECT g.id, g.parent_group_id
      FROM groups g
      WHERE g.id = (
        SELECT group_id FROM sessions
        WHERE tmux_name = ${tmuxNameSql} AND COALESCE(hidden, 0) = 0
        LIMIT 1
      )
      UNION ALL
      SELECT parent.id, parent.parent_group_id
      FROM groups parent
      JOIN ancestors child ON child.parent_group_id = parent.id
    )
    SELECT COUNT(*) AS depth FROM ancestors;
  `.trim()
}

/** Tmux sessions contained by any direct child group of the current group. */
export function childGroupTmuxNamesForTmuxSql(tmuxNameSql: string): string {
  return `
    WITH RECURSIVE descendants(id) AS (
      SELECT child.id
      FROM groups child
      WHERE child.parent_group_id = (
        SELECT group_id FROM sessions
        WHERE tmux_name = ${tmuxNameSql} AND COALESCE(hidden, 0) = 0
        LIMIT 1
      )
      UNION ALL
      SELECT child.id
      FROM groups child
      JOIN descendants parent ON child.parent_group_id = parent.id
    )
    SELECT DISTINCT tmux_name
    FROM sessions
    WHERE group_id IN (SELECT id FROM descendants)
      AND COALESCE(hidden, 0) = 0
    ORDER BY tmux_name;
  `.trim()
}

/** Prefix a query with a recursive subtree rooted at `rootGroupSql`. */
export function groupSubtreeCte(rootGroupSql: string): string {
  return `
    WITH RECURSIVE subtree(id) AS (
      SELECT ${rootGroupSql}
      UNION ALL
      SELECT child.id
      FROM groups child
      JOIN subtree parent ON child.parent_group_id = parent.id
    )
  `.trim()
}
