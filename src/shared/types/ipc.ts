export const IPC = {
  // Session management
  SESSION_CREATE: 'session:create',
  SESSION_CREATE_IN_DIR: 'session:create-in-dir',  // pick folder → start CLI there
  SESSION_IMPORT: 'session:import',                 // import existing tmux sessions
  SESSION_LIST: 'session:list',
  SESSION_ATTACH: 'session:attach',
  SESSION_KILL: 'session:kill',
  SESSION_SYNC: 'session:sync',

  // Worktree panes
  WORKTREE_DISCOVER: 'worktree:discover',
  WORKTREE_CREATE_PANE: 'worktree:create-pane',
  WORKTREE_ATTACH_PANES: 'worktree:attach-panes',
  WORKTREE_REMOVE_PANE: 'worktree:remove-pane',
  WORKTREE_PRUNE_MERGED: 'worktree:prune-merged',
  WORKTREE_LIST_PANES: 'worktree:list-panes',

  // Collab messages (push from main → renderer)
  COLLAB_MESSAGE: 'collab:message',

  // Skills (skillsmgr integration)
  SKILLS_LIST: 'skills:list',
  SKILLS_ADD: 'skills:add',
  SKILLS_REMOVE: 'skills:remove',
  SKILLS_SEARCH: 'skills:search',
  SKILLS_INSTALL: 'skills:install',

  // Pet
  PET_STATE_GET: 'pet:state:get',
  PET_INTERACT: 'pet:interact',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set'
} as const
