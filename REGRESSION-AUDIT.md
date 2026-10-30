# dsh-netease-lyrics 回归自查报告

> 轮次：2026-10-28，v0.3.18 → v0.3.19。本轮不新增功能，只做检查与修复。

## 一、结论

| 项 | 结果 |
|---|---|
静态审计（重复规则 / 语法 / 依赖） | 无异常（98 条 CSS 规则，选择器无重复） |
渲染审计：20 种状态快照 × 2 组件（47 项） | 全过（修掉 2 个缺陷后） |
单元测试：7 个套件 | 全过，合计 **112 项断言** |
真实浏览器逐项交互（12 项） | 全过 |
线上实例 `/state.json` 一致性 | 无异常 |
线上 7 条 HTTP 路由行为 | 全部符合预期 |

## 二、查出并修掉的缺陷

### 缺陷 1（严重）：畸形歌词行会让整个胶囊崩溃

- **现象**：胶囊突然消失，与 v0.3.18 的 hook 问题表现相同。
- **根因**：`currentLineIndex()` 直接读 `lines[mid].t`。歌词来自第三方接口并写入缓存文件，
  一条 `null` 或半成品行就会在二分查找里抛错，React 卸载整个浮层。
- **修复**：新增 `sanitizeLines()`（丢非对象行、`t` 非数字归 0、`text` 非字符串归空、空译文归 `undefined`），
  胶囊与环境浮层共用；`currentLineIndex` 自身也加了防御。
- **验证**：渲染审计的「null/NaN/字符串垃圾」用例由 FAIL 转 PASS。

### 缺陷 2（中等）：设置视图的返回按钮尺寸为 0

- **现象**：点开齿轮后回不去（按钮点不到）。
- **根因**：设置视图里 `dnl-gear` 由 `.dnl-set-head-row` 承载，实测 `26×26` 变成 `0×0`，
  `elementFromPoint` 落到 `BODY`。
- **修复**：显式保证尺寸与可命中。
- **验证**：实测 26×26，最上层元素就是它自己。

### 改进：居中改为引擎级（首帧即正确）

- 原先靠 `useEffect` 设置 `scrollTop`，effect 在绘制之后才跑，首帧会看到未居中。
- 现在 `scroll-snap-type:y mandatory` + `scroll-padding-block:50%` 让浏览器首帧就吸附到中间
  （实测 `scrollTop` 0 → 56），effect 再补齐（实测落在 59% 以内）。

## 三、补上的测试盲区

v0.3.18 的 hook 崩溃**测试完全没抓到**，因为原套件只渲染「有内容」这一条路径。
新增 `test/render-audit.test.mjs`（47 项，已接入 `npm test` 并排在最前）：

覆盖的 20 种快照：无曲目 / 空对象 / bridge 启动中（无 lyric 键）/ idle / loading / unmatched /
error / matched 无行 / 单行 / 有译文 / 无译文 / 暂停 / 零时长（酷狗）/ 位置越界 / 负位置 /
无封面 / 播放器全不支持 / 超长标题 / emoji / 本地无时间轴歌词。

每个快照都断言：**胶囊不崩且能渲染出节点**、**环境浮层不崩**。
另含 4 类畸形输入、6 项交互结构检查（折叠态、9 行窗口、齿轮开关、5 个按钮、折叠控件 inert）。

## 四、真实浏览器逐项验证（12 项）

| 检查 | 结果 |
|---|---|
胶囊可见且尺寸合理 | PASS 266×340 |
歌词框有界（紧凑） | PASS h=184 / max-height=184px |
当前句垂直居中 | PASS 59% |
歌词行未被裁切（可滚动） | PASS overflow-y=auto |
齿轮中心最上层 = 齿轮 | PASS dnl-gear |
拖动手柄中心最上层 = 手柄 | PASS dnl-drag |
5 个按钮全部可命中且够大 | PASS 28×28 / 34×24 / 34×34 |
点齿轮进入设置视图 | PASS，返回按钮可命中 |
设置视图有不透明度滑块 | PASS value=100 |
返回按钮回到歌词 | PASS |
拖动手柄移动胶囊 | PASS 70vw|12px → 420px|110px |
悬停齿轮不收起 | PASS，h=340 |

## 五、线上实例检查

```
active True | app cloudmusic.exe | playing True
title 星炬不熄 | positionSec 77.656 | durationSec 232.954
canToggle/canNext/canPrev/canSeek 全 True | positionEstimated False
bridge up | timelineRefreshes 7      ← 停滞检测确实在工作
lyric.status matched (51 行) | source 网易云
providers netease > qq > kugou > migu > local
policy    netease > qq > kugou > migu > local-file
```

路由行为：

```
GET  /state.json          200
GET  /cover.png           200 (80727 bytes)
GET  /rematch             405  method not allowed
GET  /control             405  method not allowed
POST /control {cmd:nope}  400  unsupported command
POST /control {pos:null}  400  bad position     ← 之前修的漏洞仍有效
POST /control {pos:"x"}   400  bad position
POST /control {pos:-5}    400  bad position
```

## 六、本轮未覆盖 / 已知限制

1. **真实播放器上的播放控制未在本轮实测**（会真的切歌/暂停你的音乐）。上一轮已验证桥的
   `toggle` 返回 `{"ok":true,"via":"explicit"}`，且 `can*` 三个能力位都是 True，链路是通的。
2. **酷狗的 `canSeek=false`**：±5s 按钮会禁用，这是播放器能力限制，非缺陷。
3. 浏览器验证用的是**从真实渲染结果序列化出的 fixture**（React 事件处理器无法序列化，
   因此点击/拖动由等价语义的 shim 驱动）。真实 React 路径由 `ambient-client.test.mjs` 覆盖。
4. **未做**长时间挂机稳定性测试（内存/定时器泄漏）。若要，我可以跑一轮 30 分钟采样。

## 七、建议

- 本轮的 `render-audit` 是防止「胶囊消失」类问题复发的主要手段，已进 `npm test`，请勿移除。
- 若后续再改 UI，建议先跑 `node test/render-audit.test.mjs`（快，47 项，覆盖全部状态分支）。
