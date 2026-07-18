import type { GroupInfo, SessionInfo } from '@shared/types/session'

export type DeckAxis = 'vertical' | 'horizontal'
export type DeckEdge = 'left' | 'right'
export type VerticalDirection = 'up' | 'down'

export interface DeckGroupNode {
  group: GroupInfo
  sessions: SessionInfo[]
  children: DeckGroupNode[]
}

function hasAncestor(groupId: string, ancestorId: string, groups: Map<string, GroupInfo>): boolean {
  let cursor = groups.get(groupId)
  const visited = new Set<string>()
  while (cursor?.parentGroupId) {
    if (cursor.parentGroupId === ancestorId) return true
    if (visited.has(cursor.parentGroupId)) return false
    visited.add(cursor.parentGroupId)
    cursor = groups.get(cursor.parentGroupId)
  }
  return false
}

export function buildDeckForest(groups: GroupInfo[], sessions: SessionInfo[]): DeckGroupNode[] {
  const groupMap = new Map(groups.map((group) => [group.id, group]))
  const nodes = new Map<string, DeckGroupNode>()
  for (const group of groups) {
    nodes.set(group.id, {
      group,
      sessions: sessions.filter((session) => session.groupId === group.id),
      children: [],
    })
  }

  const roots: DeckGroupNode[] = []
  for (const group of groups) {
    const node = nodes.get(group.id)!
    const parentId = group.parentGroupId
    const invalidParent = !parentId
      || parentId === group.id
      || !nodes.has(parentId)
      || hasAncestor(parentId, group.id, groupMap)
    if (invalidParent) roots.push(node)
    else nodes.get(parentId)!.children.push(node)
  }
  return roots
}

export function countDeckDescendants(node: DeckGroupNode): number {
  return node.sessions.length + node.children.reduce(
    (total, child) => total + 1 + countDeckDescendants(child),
    0,
  )
}

export function nextDeckAxis(axis: DeckAxis): DeckAxis {
  return axis === 'vertical' ? 'horizontal' : 'vertical'
}

export function chooseVerticalDirection(
  anchorTop: number,
  anchorBottom: number,
  branchHeight: number,
  viewportHeight: number,
): VerticalDirection {
  const roomAbove = Math.max(0, anchorTop)
  const roomBelow = Math.max(0, viewportHeight - anchorBottom)
  if (roomBelow >= branchHeight) return 'down'
  if (roomAbove >= branchHeight) return 'up'
  return roomBelow >= roomAbove ? 'down' : 'up'
}

export function toggleDeckPath(path: string[], depth: number, groupId: string): string[] {
  const prefix = path.slice(0, depth)
  if (path[depth] === groupId) return prefix
  return [...prefix, groupId]
}

export function openDeckPath(path: string[], depth: number, groupId: string): string[] {
  return [...path.slice(0, depth), groupId]
}
