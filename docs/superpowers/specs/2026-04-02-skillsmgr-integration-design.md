# skillsmgr 集成设计

将 skillsmgr CLI 接入 kitty-kitty，为每个 session 提供技能管理 GUI。

## 目标

- 在 session 右键菜单中提供技能管理入口
- 展示已安装技能（按来源分组 + group 分组），标记部署状态
- 支持一键部署/移除技能到 session 的 cwd
- 支持从 skillsmgr.dev registry 搜索并安装技能
- 所有操作走 skillsmgr CLI，不直接操作文件系统

## 架构

```
SkillsPanel (renderer)
   │
   ├── skills:list ──────► skills-manager.ts ──► skillsmgr list + list --deployed
   ├── skills:add ───────► skills-manager.ts ──► skillsmgr add <name> --same-agents -y
   ├── skills:remove ────► skills-manager.ts ──► skillsmgr remove <name> --same-agents -y
   ├── skills:search ────► skills-manager.ts ──► skillsmgr search <query>
   └── skills:install ───► skills-manager.ts ──► skillsmgr install <name> --all
```

## 后端：`src/main/skills/skills-manager.ts`

### 统一 CLI Runner

```typescript
interface CliResult {
  success: boolean
  stdout: string
  stderr: string
}

function runSkillsMgr(args: string[], cwd?: string): CliResult
```

- 统一调用 `execSync('skillsmgr ' + args.join(' '))`
- 超时 30 秒
- 首次调用检测 skillsmgr 是否安装（`which skillsmgr`），缓存结果
- 未安装时所有操作返回 `{ success: false, stderr: 'skillsmgr 未安装' }`
- session 无 cwd 时拒绝需要 cwd 的操作

### 文本解析器

独立函数，后续 skillsmgr 加 `--json` 后只替换这些函数。

#### parseList(stdout) → SkillCategory[]

输入格式：
```
Available in ~/.skills-manager/:

── official (12 skills) ──
  anthropic (12)
    claude-api
    pdf
    ...

── community (5 skills) ──
  agent-skills (4)
    deploy-to-vercel
    ...
  jt-codex (1)
    jt-codex

── custom (1 skill) ──
  example-skill
```

输出：
```typescript
interface SkillCategory {
  category: string          // "official", "community", "custom", "registry"
  source?: string           // "anthropic", "agent-skills" 等（custom 无 source）
  skills: string[]          // 技能名列表
}
```

#### parseDeployed(stdout) → string[]

输入格式（有部署时）：
```
◉ skill-name    (link) ← official/anthropic/skill-name
```

输出：已部署技能名数组。无部署时返回空数组。

#### parseSearch(stdout) → SearchResult[]

输入格式：
```
NAME      VERSION  DESCRIPTION
jt-codex  1.0.0    Use Codex CLI...

1 of 1 results
```

输出：
```typescript
interface SearchResult {
  name: string
  version: string
  description: string
}
```

#### parseResult(stdout, stderr) → { success: boolean, message: string }

操作命令（add/remove/install）的统一结果解析。成功取 stdout，失败取 stderr。

### 操作接口

```typescript
// 列出已安装技能 + group 分组
function listSkills(): { categories: SkillCategory[], groups: GroupInfo[] }

// 列出 cwd 下已部署的技能
function listDeployed(cwd: string): string[]

// 部署技能到 cwd
// 优先 --same-agents -y，失败兜底 -a <mapped-agent> -y
function addSkill(cwd: string, name: string, tool: string): CliResult

// 移除技能
function removeSkill(cwd: string, name: string): CliResult

// 搜索 registry
function searchSkills(query: string): SearchResult[]

// 从 registry 安装
function installSkill(name: string): CliResult
```

### Agent 映射兜底

当 `--same-agents` 失败（项目没有已配置的 agent）时，根据 session.tool 映射：

| session.tool | skillsmgr agent |
|-------------|-----------------|
| claude | claude-code |
| codex | codex |
| shell | claude-code |

### Group 支持

读取 `skillsmgr group list` 的输出获取用户自定义分组。group 和来源分组平级展示在 UI 中。

## IPC 接口：`src/main/ipc/skills-handlers.ts`

| Channel | 入参 | 返回 |
|---------|------|------|
| `skills:list` | sessionId | `{ categories, groups, deployed, available: boolean }` |
| `skills:add` | sessionId, skillName | `{ success, message }` |
| `skills:remove` | sessionId, skillName | `{ success, message }` |
| `skills:search` | query | `{ results: SearchResult[] }` |
| `skills:install` | skillName | `{ success, message }` |

`available` 字段表示 skillsmgr CLI 是否可用，UI 据此决定是否显示"未安装"提示。

`skills:list` 内部合并 `listSkills()` + `listDeployed(session.cwd)` + `group list`，一次 IPC 拿到所有数据。

## UI：`src/renderer/pet/SkillsPanel.tsx`

### 入口

session 气泡右键菜单新增「📦 技能」，点击打开 SkillsPanel（DraggablePopup 包裹）。

### 布局

```
┌─ 📦 技能管理 ────────── ✕ ─┐
│ [🔍 搜索 registry...      ] │
│                              │
│ ── 搜索结果 ──               │ ← 仅搜索时显示
│   jt-codex v1.0.0  [安装]   │
│                              │
│ ▾ official/anthropic         │
│   ● claude-api               │
│   ○ pdf                      │
│   ○ frontend-design          │
│                              │
│ ▸ community/agent-skills     │
│ ▸ custom                     │
│ ▸ registry                   │
│                              │
│ ▾ 我的分组 (group)           │ ← 有 group 时显示
│   ○ some-skill               │
│                              │
│  ⚠ skillsmgr 未安装          │ ← 仅在未检测到时显示
└──────────────────────────────┘
```

### 交互

- ● 已部署 / ○ 未部署：点击切换，调 `skills:add` 或 `skills:remove`
- 分组可折叠（▾/▸）
- 搜索框输入回车 → 调 `skills:search` → 顶部展示结果
- 搜索结果的「安装」按钮 → 调 `skills:install` → 安装后刷新列表
- 已安装的技能在搜索结果中不显示安装按钮
- 操作中猫猫播放 dance 动画
- 操作结果通过 `say()` 气泡反馈（成功/失败+错误信息）
- skillsmgr 未安装时面板显示提示文案和安装命令

### 状态管理

不加 store。面板打开时 `invoke('skills:list')` 获取数据，操作后重新获取刷新。

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `src/main/skills/skills-manager.ts` | **新增** CLI runner + 解析器 + 操作接口 |
| `src/main/ipc/skills-handlers.ts` | **新增** 5 个 IPC handler |
| `src/main/ipc/handlers.ts` | 注册 skills handlers |
| `src/shared/types/ipc.ts` | 新增 5 个 IPC 常量 |
| `src/shared/types/skills.ts` | **新增** SkillCategory, SearchResult, GroupInfo 等类型 |
| `src/renderer/pet/SkillsPanel.tsx` | **新增** 技能管理面板组件 |
| `src/renderer/pet/TagCloud.tsx` | 右键菜单新增「📦 技能」项 |
| `src/renderer/lib/ipc.ts` | 新增 skills IPC wrappers |

## 后续演进

- skillsmgr 加 `--json` 后：替换 `parseList`、`parseDeployed`、`parseSearch`、`parseResult` 四个解析函数，其余不动
- session 创建时自动加载预设技能组（基于 group）
- worktree pane 继承主分支技能配置
