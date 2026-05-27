export const IPC = {
  // Session management
  SESSION_CREATE: 'session:create',
  SESSION_CREATE_IN_DIR: 'session:create-in-dir',  // pick folder → start CLI there
  SESSION_LIST: 'session:list',
  SESSION_ATTACH: 'session:attach',
  SESSION_KILL: 'session:kill',
  SESSION_SYNC: 'session:sync',

  // Skills (skillsmgr integration)
  SKILLS_LIST: 'skills:list',
  SKILLS_ADD: 'skills:add',
  SKILLS_REMOVE: 'skills:remove',
  SKILLS_SEARCH: 'skills:search',
  SKILLS_INSTALL: 'skills:install',

  // MCPs (mcpsmgr integration)
  MCPS_LIST: 'mcps:list',
  MCPS_ADD: 'mcps:add',
  MCPS_REMOVE: 'mcps:remove',
  MCPS_INSTALL: 'mcps:install',
  MCPS_UNINSTALL: 'mcps:uninstall',
  MCPS_WRITE_MANUAL: 'mcps:write-manual',

  // Pet
  PET_STATE_GET: 'pet:state:get',
  PET_STATE_UPDATE: 'pet:state:update',
  PET_INTERACT: 'pet:interact',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',

  // Group session management
  SESSION_CREATE_IN_GROUP: 'session:create-in-group',
  GROUP_SET_MAIN_SESSION: 'group:set-main-session',

  // Ntfy push notifications
  NTFY_MESSAGE: 'ntfy:message',
  NTFY_TOPIC_GET: 'ntfy:topic:get',
  NTFY_TOPIC_SET: 'ntfy:topic:set',
} as const
