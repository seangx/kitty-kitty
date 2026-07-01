# 桌宠贴边隐藏（探头吸附）

日期:2026-07-01
状态:已批准,实现中

## 背景 / 目标

桌宠窗口(450×650,frameless/transparent/alwaysOnTop)常年浮在桌面上,想临时"收起"时没有便捷方式。加一个贴边隐藏:把猫拖到屏幕边缘松手即吸附成"探头",只露一小截朝屏内探出;点击探头把它唤回原位。

## 交互规格

- **触发**:拖动结束(`drag-end`)时,若窗口某条边越过屏幕 workArea 边界、或距边界 < 阈值(~24px),自动吸附到最近的那条边。
- **支持的边**:**左 / 右 / 上** 三条。**不支持下边**——猫贴窗口底部居中(128×128),吸下边会把猫挤出屏、露出顶部透明区;且底部常有 Dock。
- **隐藏形态**:窗口大部分移出屏外,只在屏内留一截 peek(~64px);renderer 把猫 align 到朝屏内的那一侧,使露出的 peek 正好是猫的一部分(探头效果)。用**现有 idle 猫帧**,不专门画探头美术。
- **唤出**:点击露出的探头猫 → 滑回吸附前的位置。**不加快捷键**(用户明确)。

## 架构

吸附判定/窗口定位在主进程,探头渲染在 renderer,各司其职。

| 层 | 职责 |
|---|---|
| **主进程** `src/main/windows/pet-window.ts` | `drag-end` handler 增吸附判定:算窗口 bounds vs `getDisplayMatching(bounds).workArea`,定 `edge`(left/right/top)与 hidden 位置;维护模块级 `snapState: { edge, restoreBounds } \| null`;动画移动窗口到边缘;`petWindow.webContents.send('pet:snapped', { edge })`;新 IPC `pet:unsnap` → 动画滑回 `restoreBounds`、清 `snapState`、`send('pet:unsnapped')` |
| **renderer** `src/renderer/pet/PetCanvas.tsx` | 监听 `pet:snapped`/`pet:unsnapped` → `snapEdge` state;peek 模式下把猫容器 align 到 edge 对应侧(left→猫靠右露右半,right→猫靠左露左半,top→猫保持底部露下半),其余区域透明 + click-through 穿透;点击探头猫 → `invoke('pet:unsnap')` |

### 窗口定位公式(peek≈64px,W=450,H=650)

- **left**:`x = workArea.x - (W - peek)`,露右缘 peek;猫 align 右。
- **right**:`x = workArea.x + workArea.width - peek`,露左缘 peek;猫 align 左。
- **top**:`y = workArea.y - (H - peek)`,露下缘 peek;猫保持底部对齐(本就露猫)。
- 非吸附轴保持当前坐标(如 left/right 吸附时 y 不变)。

### 状态与 IPC

- `snapState` 记录吸附边 + 吸附前完整 bounds(用于精确还原)。
- 主进程 → renderer:`pet:snapped {edge}`、`pet:unsnapped`。
- renderer → 主进程:`pet:unsnap`(点击探头触发)。
- 拖动开始时若处于 snapped,先隐式 unsnap(拖动即取消吸附),避免状态错乱。

## 关键细节

- **阈值**:窗口边缘距 workArea < 24px 或越界即吸附;取被越过/最近的一条边(多条同时满足取重叠最多者)。
- **动画**:滑入/滑出用 renderer CSS transform(窗口位置一步到位,视觉滑动交给 CSS),或主进程分帧 `setPosition`(~10 帧 ease)。实现时择一,优先 CSS(更顺滑、不占主进程)。
- **click-through**:复用现有 `set-ignore-mouse` 动态 toggle 机制;peek 模式下仅露出的猫区域 `pointerEvents:auto`,其余透明穿透。
- **多显示器**:一律用 `getDisplayMatching(petWindow.getBounds()).workArea`。
- **持久化**:隐藏态**不持久化**。hidden 是屏外坐标,`moved` 会写入 `window-pos.json`,但 `loadPosition` 已有可见性校验(屏外位置被判 invisible → 回默认),重启自然回到正常位置。为稳妥,吸附期间可临时不写位置文件(避免存屏外坐标)。

## 不做(YAGNI)

- 专门的探头美术帧(用现有 idle 帧贴边)
- 吸附下边
- 快捷键唤回
- 隐藏态跨重启持久化
- 悬停自动滑出(仅点击唤出)

## 验证

项目无单测套件 → `npm run build` 必过 + 手动回归:
1. 拖猫到左/右/上边缘松手 → 吸附成探头,只露一小截猫。
2. 点击探头猫 → 滑回吸附前位置。
3. 拖动已吸附的猫 → 先解除吸附再正常拖动。
4. 吸附后重启 kitty → 猫回到正常可见位置(不卡在屏外)。
5. 多显示器:在副屏拖到边缘 → 吸附到副屏对应边,不跑到主屏。
