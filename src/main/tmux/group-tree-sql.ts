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
