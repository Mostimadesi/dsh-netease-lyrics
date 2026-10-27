# dsh-netease-lyrics 工程交接文档

> 生成于 2026-10-16 会话末尾。面向下一轮对话的任意模型（含非 DSH_PluginDev 预设）。
> 目标：读完本文即可接手开发/调试，不必重走本会话的弯路。
> 用户侧面向使用说明见同目录 `README.md`；本文聚焦**工程状态与决策史**。

## 1. 交付物一句话

DSH 桌面版顶部歌词浮层插件 `dsh-netease-lyrics` v0.1.0：Windows SMTC 读当前播放（网易云 via BetterNCM+InfLink-rs，或任意注册 SMTC 的播放器含 QQ 音乐），在线歌词**网易云优先、QQ 后备**，React 无 JSX 客户端渲染进 `shell.overlay` 槽。**已安装**于 `desktop` profile（`link:` 指向本目录，改代码即生效于下次载入）。

## 2. 本机环境快照（换机不适用，全部实测）

| 项 | 值 |
|---|---|
| DSH profile | `desktop`（`C:\Users\Mostima、\.dsh\profiles\desktop`），GUI `http://127.0.0.1:19387` |
| 安装方式 | profile 依赖表 `dsh-netease-lyrics: link:D:/DeepSeek Harness/workspace/plugins_helper/dsh-netease-lyrics`，bundles 列表末位，enabled |
| 网易云客户端 | 3.1.41.205529，装于 `D:\CloudMusic\`；原生不注册 SMTC（实测 75 采样全 0） |
| BetterNCM | 已装（`C:\betterncm\`，加载器 `msimg32.dll` 在 `D:\CloudMusic\`） |
| InfLink-rs | **v3.4.0**（sha256 与官方一致），`C:\betterncm\plugins\InfLink-rs.plugin`；旧版 3.2.11 保留为 `.bak`。**3.2.11 与客户端 3.1.41 不兼容（SMTC 会话不注册）是本会话最大的一次排障**，勿回退 |
| QQ 音乐 | 本机已装未实播验证；官方 20.22.2692.0613 起原生 SMTC；`QQMusic-ID-Injector`（InfLink-rs 作者作）存在但**未安装**，未使用 |
| 桥进程 | Windows PowerShell 5.1（绝对路径调用，不能用 pwsh 7）；SMTC 桥脚本常驻，行 JSON 协议 |
| 歌词接口 | 网易云 `music.163.com` 旧版公开接口；QQ `c.y.qq.com`（搜索 `client_search_cp`，歌词 `fcg_query_lyric_new.fcg`，Base64+HTML 实体）。均为未公开接口，无 SLA |

## 3. 架构与文件地图

```
dsh-netease-lyrics/
├── package.json          # dsh.client.inject: ui-layout / ui-slots / ui-plugin-manager
├── cordis.patch.yml      # insert 一行宿主插件；config: showTranslation: true（其余默认）
├── lib/
│   ├── index.js          # 宿主半边：桥守护（退避重启+重禁用复位）、歌词编排、
│   │                     #   路由 state.json / cover.png / rematch、信任栅栏、boot trace
│   ├── lyric-service.js  # 多源歌词：netease→qq 回退；匹配打分(标题≥2且总分≥4，
│   │                     #   时长差>10s 拒)；v2 缓存(键含标题+时长版本)；串行+800ms 限频
│   ├── client.js         # 浏览器半边（window.__ModuleLoader__ 格式，React.createElement）
│   │                     #   shell.overlay 浮层 + plugins.bundle.config 设置页
│   └── smtc-bridge.ps1   # 取自 dsh-netease-island(MIT)+本会话改造：QQ 模式匹配、
│                         #   会话选择改为「播放中的受支持播放器 > 其他播放中 > 暂停的受支持」
├── refs/                 # dsh-netease-island 原版源码（参考用，不参与安装）
└── test/                 # 见 §5；*.mjs 多为一次性迁移脚本（见 §7）
```

数据流：`播放器 → SMTC → PS5.1 桥(行JSON) → lib/index.js(指纹变化→resolve) → HTTP 路由 → client.js(轮询+进度外推+渲染)`。客户端本地进度钟 `createPlaybackClock`：抑制采样回退/重复采样防切句抖动，跳转/暂停/切歌仍重同步，停更最多外推 2s。

## 4. 功能与状态面（截至本会话末）

- 收起态：原文+译文双行（无译文单行）；~220ms 交叉淡入淡出（respect `prefers-reduced-motion`）；未匹配显示 `标题 — 歌手 · 未匹配`。
- 展开态：封面+曲目+匹配信息（**含来源标记「网易云歌词 / QQ 音乐歌词」**）+滚动歌词窗+进度条+「重新匹配」。
- 拖动：`⠿` 手柄，位置归一化存 localStorage，防误触点击；默认顶部 70% 宽处。
- 设置页（plugins.bundle.config 槽）：三色（原文/译文/高亮）+字体栈（名称逐段 JSON 引号包裹防注入）+重置按钮；localStorage 持久，浏览器间不共享。
- state.json 诊断字段：`bridge/detail/appPatterns/lyric.{status,source,sourceLabel,fallbackUsed,attempts}/service.{policy,cacheVersion,note,lastAttempts}`。多源版本应显示 `policy:"netease-first-qq-fallback"`、`cacheVersion:2`。
- 缓存 `~/.dsh/dsh-netease-lyrics-cache.json` v2：成功 7 天/负结果 10 分钟/错误 30 秒 TTL，上限 300 条；v1 不迁移（防旧负缓存挡回退）。
- boot trace：`~/.dsh/dsh-netease-lyrics-boot.log`。

## 5. 测试清单（全绿状态交付）

| 文件 | 覆盖 | 运行 |
|---|---|---|
| `test/multisource.test.mjs` | 25 项：双源回退全故障矩阵、缓存/并发/重试、实体解码 | `node test/multisource.test.mjs` |
| `test/lyric-service.test.mjs` | LRC 解析/指纹归一/原单源管线 | 同上 |
| `test/client-ui.test.mjs` | 真实 client.js 双槽注册、双行/颜色/字体（vm 沙箱跑真组件） | 同上 |
| `test/playback-clock.test.mjs` | 切句抖动抑制、跳转/暂停/切歌重同步 | 同上 |
| `test/drag-position.test.mjs` | 指针捕获→保存→重挂载恢复 | 同上 |
| `test/lyric-transition.test.mjs` | 过渡层生命周期、快速切歌清理、reduced-motion | 同上 |
| `test/media-selection.test.ps1` | 提取真 Select-Session 函数测 6 场景（AST 切片+dot-source） | `powershell -File ...`（PS5.1） |
| `test/live-qq-fallback.mjs` | **真实外网**QQ 接口（模拟网易云故障，Adele Hello 47 行） | 手动，勿进 CI |

`test/` 里 `fix-playback-ui.mjs`、`prepare-multisource.mjs`、`update-multisource-docs.mjs`、`update-ui.mjs`、`multisource-service.txt` 是**一次性构建脚本（已执行过，勿重跑）**，留着仅作变更史。

## 6. 验证状态矩阵（如实）

| 层 | 状态 |
|---|---|
| 安装 | ✅ plugin_manager `applied` 无 warning；profile 依赖+bundles 在位 |
| 宿主热载 | ✅ boot trace 走通；桥 up、网易云实播歌词 matched（旧版模块） |
| 逻辑测试 | ✅ §5 全绿（末次全量回归通过） |
| 真实 QQ 接口 | ✅ live-qq-fallback 47 行歌词 |
| QQ 桥会话选择 | ✅ 函数级 6 场景；❌ QQ 客户端实播端到端（用户承诺协助测试，未做） |
| **多源回退模块上机** | ❌ **运行中宿主仍是旧模块**（`policy:null` 实证）；需完整重启 DSH 后确认 §4 诊断字段 |
| 渐变/拖动/字体观感 | 代码级验证；人工观感未确认 |

## 7. 会话关键决策与坑（防重踩）

1. **Loader 模块缓存**：`set_bundle` 禁用→启用会重跑 `apply()` 但**复用同一模块实例**——模块级状态（如 `bridge.stopped`）不复位会让桥永远起不来。`lib/index.js` apply() 开头已加复位；此类改动必须重启 DSH 才真正载入。已验证过一次这个坑。
2. **PowerShell 命令行传中文会被控制台代码页弄坏**（本会话三次踩）——测试代码一律写 UTF-8 文件再 `node file`，不 `node -e`。
3. **网易云「接口」与「客户端」无关**：歌词匹配只需出网到 music.163.com，网易云客户端不必运行。别把「网易云没开」当歌词失败原因。
4. QQ 歌词 `trans` 与主歌词时间戳差 ~60ms，合并容差 100ms 用「就近对齐」而非精确匹配；QQ 文本需 Base64+HTML 实体解码。
5. 匹配阈值设计：标题包含 ≥2 分且总分 ≥4 才接受；时长差 >10s 一票否决（防翻唱/现场版）；**歌手重合也已加入硬过滤**（同名同长不同歌手直接回退下一源）。
6. `skill-filesystem` 对不存在目录静默返回空、`!!js` 配置求值抛错无用户可见日志——排查「工具在但目录空」类问题先想到这两层静默。
7. 官方 `plugins.bundle.config` 槽 key=包名注册即生效（live profile 增量扫描 client 半边，**无需重启**）；宿主半边 JS/ps1 改动**必须重启**。
8. inspect 的 `cordis_inspect_query` `input` 参数在部分链路有序列化 bug（"must be an object"），传不了分页参数时改用无 input 调用或落盘 spill 文件 grep。

## 8. 悬而未决 / 下一步建议

1. **重启 DSH 验证多源版本**（§6 第 6 行）：重启 → 放歌 → 看 `state.json` 的 `policy/cacheVersion`；然后用户用 QQ 实播一首网易云没有的歌验证 `lyric.source:"qq"`。
2. QQ 精确 ID：若将来装 `QQMusic-ID-Injector`（流派字段带 `QQ-{ID}`），桥脚本需把 genre 透传，lyric-service 可按 ID 直取 QQ 歌词，消除同名错配。未实现。
3. 已知边界（README「已知边界」节）：接口无 SLA、VIP/无版权无词、仅 Windows、与 dsh-netease-island 同装会双浮层。
4. `package.json` version 仍 0.1.0，若对外发布建议按多源功能 bump。

## 9. 本机其他相关改动（非本插件，但影响后续开发会话）

- **plugin-dev-preset 技能修复**：预设 `skill-filesystem` 的 `!!js` 从 patch 目录解析 `@deepseek-ai/dsh-agent-preset` 必然 MODULE_NOT_FOUND（本地 link: bundle 无运行时解析链）。已建 junction：`plugin-dev-preset\node_modules\@deepseek-ai\dsh-agent-preset` → 运行时包目录；重建方法见 `plugin-dev-preset/README.md`。**同样待重启+新会话验证 `skill` 工具**。
- profile 内其他 bundle（dsh-turn-notify、wallpaper-engine、dshmarket 等）与本插件无耦合。

## 10. 快速命令

```powershell
# 状态诊断
Invoke-RestMethod http://127.0.0.1:19387/dsh-netease-lyrics/state.json
# 全量回归
cd 'D:\DeepSeek Harness\workspace\plugins_helper\dsh-netease-lyrics'
node test/multisource.test.mjs; node test/lyric-service.test.mjs; node test/client-ui.test.mjs
node test/playback-clock.test.mjs; node test/drag-position.test.mjs; node test/lyric-transition.test.mjs
powershell -File test/media-selection.test.ps1   # 注意是 PS5.1
# 语法检查（改宿主/客户端后必做）
node --check lib/index.js; node --check lib/client.js; node --check lib/lyric-service.js
```
