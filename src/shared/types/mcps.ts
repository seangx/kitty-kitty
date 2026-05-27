export interface McpServerInfo {
  name: string
  description?: string
  source?: string  // central / project / built-in 等
}

export interface McpsListResult {
  available: boolean
  central: McpServerInfo[]     // ~/.mcps-manager/servers/* 中央仓库内容
  deployed: string[]           // 当前 cwd 已部署的 server name
}

export interface McpOpResult {
  success: boolean
  message: string
}
