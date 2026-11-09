# Changelog

## 0.4.12a - 2026-11-09 (dev)

**实机反馈修复：失效 cookie 一票否决整个候选列表**。用户实测"api code -101
并回落 QQ/网易云"——本机 `cookies.txt` 与 `cookies-bilibili.txt` 并存，前者
SESSDATA 已过期（nav -101 实测确认），旧实现取第一个存在的文件即返回，且
-101 被当作整体失败回落音乐链。

- 候选顺序：**`cookies-bilibili.txt` 优先于 `cookies.txt`**（专用导出不应被
  同名通用文件遮蔽；两者都过期为后续缓解，见下）；
- **逐候选尝试 + 判定缓存**：nav -101 的文件按 `路径\0mtime` 记为 bad 换下一个
  候选，bad 判定缓存住（每文件一次 nav 往返，不逐曲重试）；重新导出（mtime
  变化）自动重新验证；非 cookie 类错误（签名/网络）不换候选直接抛出；
- 错误信息带文件名：`bilibili cookie expired or not logged in (cookies.txt)`，
  便于直接知道重导哪份；绝不含 SESSDATA 值；
- 测试：双文件场景（stale→good 换文件成功、判定缓存跨曲生效、全部过期时
  带标签的可读原因 + 音乐链存活）+ 候选顺序断言；负向验证 v0.4.12
  （f466b16）精确复现用户故障形态（`-101 → 回落网易云`）。

## 0.4.12 - 2026-11-09 (dev)

**bilibili 字幕源第 3 步：浏览器扩展上报 bvid + 桥内浏览器会话分层**
（HANDOFF-bilibili-subtitle-source.md；用户已拍板方案 A 主路径）：

- 新交付物 `browser-extension/`（MV3，三文件）：content script 监听 bilibili
  视频/番剧页的 `play`/`pause`/`seeked` 事件 + 5s 心跳 + SPA 切换检测（1s），
  提取 BV 号与播放进度，经 background service worker POST 到本机专用监听。
  **只上报页面元数据** `{bvid,title,positionSec,durationSec,playing}`——不触
  bilibili 接口、不读 cookie、宿主不可达时静默失败。安装见
  `browser-extension/README.md`（加载解压目录即可）。
- 插件宿主新增**专用 loopback 监听**：默认 `127.0.0.1:51789`（`browserSessionPort`
  可配 1024–65535）。不走 DSH webServer——它的端口随启动变化，扩展拿不到；
  绑定失败（EADDRINUSE）只降级本功能，插件其余照常。上报经校验（bvid 格式、
  标题截 300、数值钳位）后**仅存内存**，15s 无心跳过期；`server.unref()` 不钉
  测试进程；trace 仅在 bvid 变化时打一行。
- **bvid 闸门**（`computeEffectiveBvid`）：override（调试）> 浏览器 AUMID 命中
  （chrome/microsoftedge/msedge/firefox/brave）且上报新鲜 > 空。bvid 并入观察
  身份：切视频即重解析、上报过期（关标签 15s）自动回落音乐链。纯 client 不动。
- **桥 `Select-Session` 分层**：音乐 preferred-playing > **playing-browser** >
  other-playing > preferred-paused。浏览器 AUMID 片段内联在函数体（AST 提取
  测试自动携带）；**不**加进默认 appPatterns——那会让播放中的浏览器压过播放中
  的音乐客户端（既有 PS 用例也会挂）；用户显式往 appPatterns 加浏览器片段仍是
  opt-in 提级通道。PS 测试 6 → 12 例。
- 验证：check（七文件）/ test（fail 0，新增 browser-session 套件）/ bridge
  全绿；负向验证 `8828011`——JS 侧缺新 export 直接失败，旧桥恰好死在
  "playing browser should beat other playing" 新用例。宿主 + 桥改动 →
  **重启 DSH 生效**（扩展侧在浏览器扩展页"重新加载"）。
- 实机联调清单：装扩展 → 开 bilibili 视频播放 → 胶囊自动显示该视频字幕
  （来源「B站字幕」）；切视频字幕跟换；音乐客户端开始播放时音乐优先；关标签
  15s 后回落音乐链。

## 0.4.11 - 2026-11-09 (dev)

**bilibili 视频字幕作为歌词源**（HANDOFF-bilibili-subtitle-source.md 第 1、2 步；
用户已拍板 bvid 方案 A+B 与 cookies.txt 读文件。本步不依赖浏览器扩展，默认配置下
行为与 0.4.10 完全一致）：

- 新模块 `lib/bilibili-subtitles.js`：Netscape cookies.txt 解析（只取
  bilibili.com 域的 `SESSDATA`，其余站点行不进内存拼接）→ `view` 取 cid →
  **Wbi 签名**（`wts` + 排序 + 过滤 `!'()*` + md5；64 位乱序表回归锚定
  社区公知值 `ea1db1…`）→ `/x/player/wbi/v2` 取字幕轨 → 下载字幕 JSON。
- **Wbi 签名必需**（实测推翻调研阶段的"先不加签名"建议）：无签名时接口返回
  code:0 + 全部轨道但 `subtitle_url` 全为空——"成功形状的空"，会被误判成
  "视频没字幕"。空 URL 视为签名被拒：刷新 wbi key 重试一次，仍空才报错。
- 字幕 JSON `body[]{from,to,content}` 直接映射 `{t,text}`（`//` 开头的
  `subtitle_url` 补 `https:`；临时 URL 绝不缓存，只缓存解析后的行）；轨优先
  `zh-CN` → `ai-zh` → 第一条有 URL 的。
- 接入 `lyric-service`：`bvid` 进 facts 与缓存键（换视频必换键；**bvid
  大小写敏感**——BV+base58，任何大小写归一化都是错的，本轮测试咬出三处）。
  有 `bvid` 时**先于** 4 源链直取字幕（不经搜索打分）；无字幕 / Cookie 失效 /
  接口故障一律**静默回落** `netease → qq → kugou → migu → local`，bilibili
  结果照常 7 天持久化。`describe()` 只输出计数/布尔，不含路径与凭证。
- Cookie 安全：`SESSDATA` 仅存内存（按路径+mtime 失效重读），绝不写入
  state.json / 歌词缓存 / 日志 / 错误信息；错误只说 "cookie 缺失或过期"。
- 新配置三项：`bilibiliCookiePath`（显式路径；留空按 Downloads 下
  `cookies.txt` → `cookies-bilibili.txt` 候选，含 shell 重定向后的 Downloads，
  绝不扫盘）、`bilibiliBvidOverride`（手填 BV 号直取字幕——扩展接入前的唯一
  bvid 来源，调试/尝鲜用）、`bilibiliEnabled`（默认 true，无 bvid 时完全不触网）。
- 浏览器 SMTC 只有 App/标题/歌手/专辑，**没有 URL 或 BV 号**——扩展上报
  （方案 A）与标题反查（方案 B）按交接单第 3、4 步另行接入；SMTC 浏览器
  pattern 也留到那一步（直接加进默认 patterns 会让播放中的浏览器挤进
  Select-Session 的 preferred 层，压过正在播放的音乐客户端，需要桥内分层）。
- 验证：check（七文件）/ test（fail 0，新增 31 断言）/ test:bridge 全绿；
  负向验证 v0.4.10a——旧 lib + 新模块时恰好 6 条集成契约失败；真实链路
  （真 cookie + `BV1GJ411x7h7`）复现调研基准逐项吻合：6414 行 cookies、
  12 轨 12 URL、zh-CN、47 行字幕、首行 t=0.12。宿主侧（index.js/lyric-service）
  变更需重启 DSH 或插件管理器开关一次生效。

## 0.4.10a - 2026-11-09 (dev)

- **方舟观测纵向呼吸**：`padding-block:12px`（仅该皮肤）。修正过程两次误读
  用户意图（min-width 挤压换行 → 水平 padding），最终按用户澄清落地纵向。
- **SMTC 切歌宽限期**：切歌时播放器拆会话重注册，`active:false` 一拍即卸载
  整颗胶囊。3s 宽限保持最后快照；宽限内恢复则无缝续播；真停止正常退休。
  回归测试四段（保持/到期退休/重挂载），client-react 的 idle 断言同步。

## 0.4.10 - 2026-11-09 (dev)

**HANDOFF-lyrics-pending-fixes.md 四修**（歌词模块会话只读检测，本会话实施）：

- **删除 `.dnl-now-trans` 重复旧规则**（v0.3.x 残留在 CSS 数组后段静默覆盖
  v0.4.1 的 grid 收起规则）+ 计数断言防再犯；
- **自适应换句迟滞**：固定 0.35s → 按曲目歌词间隔中位数动态计算
  （×0.25，钳 0.08–0.35s）。慢歌保留全部防抖，快歌收紧到贴近 SMTC 抖动
  下限——0.5s 间隔的延迟从 0.35s 降到 0.125s，≤0.35s 的歌从"永不前进"
  变为正常跟句；
- **换句过渡** 220ms ease-out → **340ms cubic-bezier(.4,0,.2,1)**，位移
  3→4px，清除时间抽常量 `CROSSFADE_CLEAR_MS = CROSSFADE_MS + 60`（CSS 与
  计时器共用，永不再漂移；旧 20ms 余量掉一帧就截断淡出）；
- **测宽文本与 collapsedText 同源**：无歌词歌曲测宽走 title+artist fallback，
  移除空文本早退——歌名不再截断，"…" 状态也正确收缩。

三个新测试在 v0.4.9c 上负向验证失败；check/test/bridge 全绿；纯 client
热换装生效。

## 0.4.9c - 2026-11-09 (dev)

- 拖动把手/齿轮几何恢复：删除 v0.4.9 为装饰层写的 `.dnl-island>*`
  兜底规则（把 absolute 的把手/红点拉成 relative，布局乱掉）；
  装饰层改 `z-index:-1`（正确姿势）。
- 月亮**回撤**到 v0.4.9 实现（用户确认原版正确）；方舟框角**回撤**到
  左上/右下（裂开的真凶是红点骑切角线，保持红点内收修复）。
- 方舟观测加入装饰层允许列表；新增等高线/扫描线 7s 漂移动效
  （reduced-motion 静止）。

## 0.4.9b - 2026-11-09 (dev)

- 方舟框角修正（红点内收 16px）+ 七彩轮换修复（@property 动画移到
  island 本体——伪元素上的自定义属性动画传不到消费它的父级变量）+
  persona 月亮弧线尝试 + 装饰层 `:not(.dnl-decor)` 修正（后续 0.4.9c
  进一步改为 z-index:-1）。

## 0.4.9a - 2026-11-09 (dev)

- **方舟观测/月相引路切换弹回默认**：`readDisplay()` 白名单漏新皮肤——
  同款写入/读取不对称第二次上线。**结构性修复**：白名单直接
  `SKIN_IDS.has(...)`（与写入侧同一常量），回归测试枚举全部皮肤
  round-trip，新增成员自动覆盖。

## 0.4.9 - 2026-11-08 (dev)

**两个参考级新皮肤 + 装饰层**（用户指定参考：明日方舟 UI、女神异闻录 3 Reload、
Wallpaper Engine 网页壁纸的雨痕/花瓣/光点；技法部分读取了本机 WE 订阅的
`topographic.frag`（Perlin 噪声→等高线分层）与 `tech_gear.frag`（极坐标条纹）
着色器源码，以及腾讯游戏学院《明日方舟 UI/UX 分析》的设计语言总结）：

- **方舟观测**（arknights）：Diegetic HUD 语言——**切角轮廓**（clip-path
  对角斜切 10px）、深炭渐变底、细描边环、**四角 HUD 框角**（::before 四段
  linear-gradient 拼出 L 角）、**等高线纹理**（feTurbulence 双轴低频噪声 +
  颜色矩阵映射为青蓝色带，烘进 data-URI SVG，栅格化一次）、极淡扫描线。
  **强调色可设**：跟随主题色（默认）/ 方舟橙 / 观测青 / 荧黄绿——驱动描边、
  框角与扫描线。深色工业风，亮暗壁纸均可读。
- **月相引路**（persona）：P3 Reload 语言——**深蓝渐变玻璃**（靛蓝→午夜蓝）+
  柔和**内发光**（inset shadow）+ 右上**月相弧光**（径向渐变圆 + 外发光）+
  **五颗缓慢漂浮的光点**（::after 五个 radial-gradient 点 + 9s 位移关键帧，
  合成器驱动；reduced-motion 静止）。
- **装饰层**（会话区提示设置 → 装饰层）：**雨痕水珠**（四条斜向雨丝下落 +
  三颗带高光的水珠凝在玻璃上）/ **花瓣飘落**（四片贝塞尔圆角花瓣旋转下落，
  主题色染色）/ **光点浮尘**（六点缓慢漂移）。全部纯 CSS 程序化绘制
  （无素材），transform/opacity 合成器动画；**仅玻璃类皮肤可叠加**
  （arknights 有自己的 HUD 框架、ember/solid 为实底），reduced-motion 全静止。
- 皮肤 select 增至七项（SKIN_IDS 同步）；方舟强调色与装饰层控件只在其皮肤
  选中时出现。
- **修一个测试盲区**：gear 面板新控件用**数组片段**作 children——真实 React
  支持，ambient 测试的 fake React walker 遇到嵌套数组返回无 props 节点
  （v0.4.0 settingsGroup 教训的复发）。改回单容器 div 包裹。`check`/
  `test`（fail 0）/`bridge` 全绿。
- `npm run check` / `npm test` / `npm run test:bridge` 全套通过；纯 client
  改动热换装生效。

## 0.4.8 - 2026-11-08 (dev)

**渐变玻璃参数化 + 两个壁纸衍生新皮肤**（用户指出：①三层参数应交给用户——
紫罗兰 7% 确实太淡看不见；②原意是根据两张壁纸各做一个样式，渐变玻璃是
独立的自设计预设，被错误合并成了一个）：

- **渐变玻璃四旋钮**（设置 → 胶囊样式 → 选「渐变玻璃」后展开调整块，即时生效）：
  - **颗粒强度** 0–100%（默认 30）；
  - **罩染强度** 0–100%（默认 35）；
  - **描边亮度** 0–200%（默认 70，缩放双色渐变环的两端混合比）；
  - **伴侣色** 六选：紫罗兰（默认）/ 长春花蓝 / 青碧 / 暖珊瑚 / 琥珀 / 苔绿。
  - 实现路径：颗粒与罩染从 data-URI 内嵌层移到 **::before/::after 伪元素**
    （island 是 stacking context，`z-index:-1` 恰好垫在背景上、内容下），
    强度走元素 `opacity`——data-URI SVG 无法读外部 CSS 变量，伪元素 opacity
    是唯一可运行时调节的通道。描边亮度与伴侣色直接进 color-mix 变量参数。
  - **旋钮只影响渐变玻璃**；两个新皮肤与实底卡片为固定调色板（壁纸即基准）。
- **两个壁纸衍生预设**（按用户两张参考图各做一个）：
  - **静谧祝愿**（紫蓝柔光）：薰衣草→长春花蓝渐变描边（`#cfd4ff`→`#5b67d8`）、
    紫→蓝双点罩染、26px 重磨砂、轻颗粒——对应「Peaceful Wishes」的柔光玻璃质感；
  - **暗夜余烬**（暖光炭色）：余烬橙→炭褐渐变描边（`#ffb36b`→`#241408`）、
    暖琥珀罩染、更重颗粒、层底色改用 `bg-layer-1` 加深——对应暗色暖光壁纸，
    深色场景下发光。
- 样式 select 增至五项；皮肤白名单 `SKIN_IDS` 统一（island class 与 select 共用）。
- **测试**：v0.4.8 契约全集（::before/::after 由旋钮变量驱动、border-box 环、
  ring 旋钮缩放深角、两个新皮肤的调色锚点、select 选项、GLASS_ACCENTS 存在）。
  调试插曲：正则字符窗口三连误判（伪元素层隔着转义引号 / color-mix 前缀 /
  backdrop-filter 前缀），以「先量字节距离再定窗口」收束。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过；
  纯 client 改动，热换装生效。

## 0.4.7 - 2026-11-08 (dev)

**「轻玻璃」重做为「渐变玻璃」**（用户反馈：与默认样式差距不大——批评成立，
原实现只调了模糊半径和顶缘高光，属于最弱的差异档；用户提供了紫蓝渐变壁纸
作为设计基准，并要求「更多纹理」）。新皮肤三叠视觉信号，全部是默认样式
没有的：

- **双色渐变描边环**：border 透明化 + border-box 渐变垫层——左上亮品牌角
  流向右下深角（brand→白 45% 混合 / brand→深靛 #0b0b2a 混合），边框本身
  携带颜色而非平面细线；
- **斜向品牌罩染**：padding-box 上叠一层 brand 9% → 透明 → 紫罗兰 #8b7cff
  7% 的斜向渐变（紫色伴侣色按用户壁纸定的锚点）；
- **SVG feTurbulence 胶片颗粒**：0.85 基频分形噪声、去饱和、alpha 0.06 平铺
  ——真实颗粒纹理，栅格化一次后全程合成器合成，零运行时成本。

面板不透明度滑杆继续生效（底色沿用 .dnl-expanded 的 color-mix alpha 公式）；
展开态显式保留全套背景（否则被 .dnl-expanded 的单色背景覆盖）。
设置标签更新为「渐变玻璃（品牌渐变描边 + 颗粒纹理）」。
`npm run check` / `npm test` 全绿；纯 client 改动，热换装生效。

## 0.4.6 - 2026-11-08 (dev)

用户指定的三件事（细节见下）：

- **① 音效完全自定义**（设置 → 会话区提示）：
  - **音效样式**四种合成预设（仍无素材文件）：`清脆双音`（默认，原版）、
    `钟声`（基音+非谐泛音衰减，低沉浑厚）、`三音琶音`（C6→E6→G6 上行，
    明亮）、`三连脉冲`（三角波三短音，节奏感最强——嘈杂环境最醒目）；
  - **重放次数** 1–3：整段模式预排在**音频时钟**上（间隔 0.35s），一次
    effect 调用完成，不受页面节流影响；
  - **音效音量** 1–10 级（默认 5）：每音增益 = 级 × 0.06（默认 0.30，
    比旧版固定 0.18 响——用户反馈单声提示音易被其他音源盖过）。
- **② 呼吸灯「仅通知到达时」模式**（设置 → 歌词胶囊 → 呼吸灯 第 4 项）：
  平时无光；通知行显示期间（空闲胶囊 / 插入窗口 / ghost 淡出）亮起
  **放大 1.45×、更高亮度峰值、1.15s 快节奏**的 burst 光晕
  （`dnl-halo-burst`：transform 缩放只走合成器，模糊边框不重栅格化），
  与到达音效形成一声一闪的同步节拍；有媒体时插入窗结束即熄灭，只剩红点。
  该模式下呼吸节奏设置项自动隐藏（节奏固定）。
- **③ 胶囊新样式两种**（设置 → 歌词胶囊 → 胶囊样式）：
  - `轻玻璃`：24px 强磨砂 + 1.35× 饱和提升 + 顶缘 1px 高光，更冷的玻璃感；
  - `实底卡片`：不透明主题实底、12px 方角、更深投影，任何壁纸上都清晰可读
    （不透明面板下「面板不透明度」滑杆自然失效）。
  - `默认`保持原样；class 级覆盖，动画/布局全部继承。
- 修复：`glowMode` 计算此前不认识 `'notice'`（会回落 theme）——新增分支。
- **测试**：pulse×3 重放九音预排、音量→增益（0.48）、burst 光晕三态
  （纯播放无光 / 插入窗有光 / 交接后熄灭）、空闲胶囊有光、solid 皮肤类名、
  四条源码契约（NOTICE_SOUNDS/调度器/burst 放大/皮肤规则）；
  ambient 套件的呼吸灯 aria-label 同步更名（颜色来源→模式）。
  全套拿 v0.4.5 负向验证会失败。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。

## 0.4.5 - 2026-11-07 (dev)

用户指定的三件事：

- **① 通知到达音效**：Web Audio 现场合成双音提示音（880→1318.51Hz 正弦，
  ~0.9s 衰减包络，峰值 0.18），**零素材文件**。仅在**通知到达**时播放一次：
  冷却 2.5s 防连发（一轮结束+授权闪现同 tick 只响一声）、冷挂载/刷新不重放
  （`polledBefore`——重挂载不是新到达）、清除/过期不播。自动播放策略可能
  挂起 AudioContext：resume 尝试 + 一次性 pointerdown 兜底，下一次到达即恢复；
  音频失败永不拖垮浮层。
- **② 红点通知设置**（插件设置页新增「会话区提示」组，localStorage 存储）：
  - **总开关**：关闭后一切提示面消失（无胶囊/红点/插入/音效），行为回到
    无通知时代；
  - **轮次结束提示保留**（1–60 分钟，默认 10）：客户端按用户偏好过期
    轮次结束提示（提问类永不过期）；宿主同步新增 `noticeTurnTtlMs`
    配置上限（1–60 分钟，默认 600000），有效保留 = 两者取短；
  - **音效开关**：独立于总开关的提示音开关。
- **③ 效率优化**（不改观感）：
  - `sanitizeNotices` 按 payload 身份 WeakMap 缓存——播放中 250ms 插值
    tick 每渲染都重建通知数组，现在同一 tick 内全部复用；
  - `mainSessionIdOf` / `workspaceGroupOf` 加快照身份缓存——同上，消除
    每渲染的 byId/items 扫描（store 在数据变化前返回同一快照对象）；
  - 通知总开关关闭时整个派生链短路（不 sanitize/不过期/不组过滤）；
  - **光效审计结论**：呼吸灯四层全是 opacity 关键帧（合成器合成，无每帧
    JS/重排），`.dnl-kick` 按曲目 keyed 不重演，译文行 grid 过渡同理——
    无安全余量可挤，保持原样。
- **修一个真 bug（render-phase 变异陷阱，dotHold 同族）**：`everPolledRef`
  / `prevSmtcRef` 原在 render 期写入，而 ghost/过渡分支的 render-phase
  setState 会**丢弃该 pass**——丢弃 pass 的写入已生效，重渲读到污染值：
  冷挂载播了 arrival 音效（测试抓到的），媒体启动的连续性插入同样会静默
  丢失。两个 ref 改为**提交时**在 effect 写入，render 只读。
- **测试**：偏好读写/钳制/损坏回退、保留过期三态、sanitize 缓存同一引用、
  总开关全灭、音效三态（冷挂载不响/到达响一次/冷却抑制连发）、过期即退休；
  交互区所有 turnEnd.at 改为真实时钟值（客户端 TTL 按墙钟判定）。
  全套拿 v0.4.4 负向验证会失败。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。

## 0.4.4 - 2026-11-07 (dev)

**修复「切换到对应会话时红点自动消失」的两个漏网场景**（用户实测报告）：

- **工作区级分组（display filter + 定向消费）**：原过滤器按 `sessionId` 精确匹配
  主视图会话，而用户心智是工作区级的——「先点其他工作区再点回来」时 DSH 往往
  在工作区里打开的是**另一个会话**（甚至新建的空白会话），`sessionId` 对不上，
  红点既不过滤也不消失。现在客户端再取 `workspaces` 服务，把主会话映射到其
  **工作区的全部会话**（`items[].sessionIds`），按组过滤；服务缺席时回退到单会话
  分组，行为与 v0.4.2 一致。
- **到访即消费（不再「切走复活」）**：多提示时，之前只看显示层过滤——切走后
  先前过滤的通知会「复活」，红点永远清不掉。现在切入某工作区时，对该组的
  **轮次结束通知**自动发**定向 ack**（`POST /notice/ack` 新 body 参数
  `sessionIds`）：真正消费宿主侧通知，切走不再出现；轮次在你查看期间结束时
  同样即时被消费（effect 的 serial 依赖链）。**提问类通知依旧永不被消费**
  ——代理还在等答案，访问只是把同工作区的提问藏起来，离开后仍提示。
- **宿主**：`ackNotices` 新增 scoped 模式（只消费指定会话的轮次结束，遍历
  **实时状态**而非 wire 快照——你正在看时结束的那轮也一并消费）；ack 路由
  现在读取并校验 body（空 body = 无 scope 全量 ack；`sessionIds` 为空/非法
  → 400；坏 JSON → 400）。
- **跨 realm 陷阱修复**：vm 测试沙盒中 `x instanceof Map/Set` 对真正的跨 realm
  Map/Set 恒为 false（深坑——scoped ack 会被静默降级为全量 ack，正是测试暴露的）。
  `notice-aggregate` 对 Map/Set 全部改**结构检测**（`isMapLike`/`isSetLike`）：
  生产同 realm 行为不变，任何跨 realm 调用方（含测试沙盒）也正确。
- **测试**：`workspaceGroupOf` 单测、同工作区不同会话的隐藏 + 定向 ack
  body 断言（组内含全部 session id）、提问类不消费断言、宿主 scoped ack
  集成（含 400 路径）、聚合 scoped ack 四态。全套拿 v0.4.3 负向验证会失败。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。

## 0.4.3 - 2026-11-07 (dev)

自审后按用户决策落地的三项（自审报告其余项暂缓）：

- **① 插入窗口 1.8s → 4s**（用户指定 3~5s，取中值）。播放中通知的折叠行
  替换显示更久，悬停胶囊时有真实的时间看到通知标题。
- **② 修 hover-ack 误消费（自审 P0）。** v0.4.1 起 `onMouseEnter` 无条件
  ack——歌词模式下悬停胶囊读歌词也会把**没看过的**通知静默消费掉（注释
  声称"歌词模式下是 no-op"是错的：有红点时 notices 恰恰非空）。现在仅在
  **折叠行实际显示通知时**（通知胶囊 / 插入窗口 / ghost 行）且未展开时 ack；
  悬停歌词行不再触发。插入窗口内的悬停仍算查看（标题就在屏上）。
- **③ 冷挂载重放抑制（自审 P1 的修复）。** 之前的连续性逻辑在「页面刷新 /
  热重载 / 重开窗口」后首次轮询同时带来"媒体播放中 + 既有通知"时，会重放
  一次插入窗口（v0.4.1 是 1.8s；窗口延长到 4s 后重放会更吵）。新增
  `everPolledRef`：插入窗口只为**挂载后新到达**的通知（或跨两个轮询观察到
  的真实媒体启动）武装；冷挂载直接显示红点。
- **自审 P2（点击通知跳转对应会话）调研结论：当前 client runtime 无可用
  API，暂缓。** 已核实：会话切换的真实入口是 `dsh-client-ui-workspace` 的
  `UiWorkspaceService.openSession()`（`replaceMain` = `sessions.retain(source:
  "mainView")` **加上** 内部 `selection` store 更新），但该控制器是
  workspace bundle 的闭包局部实例，未 `reflect.provide`；裸调
  `sessions.retain(source:"mainView")` 只加保留计数、不切换中央面板，且会
  永久污染 mainView 语义（我们自己的未读过滤就建立在它之上）。client
  runtime 全部提供的服务面：actionCards / documentPreviews / layout /
  modules / pluginNavigation（仅插件页导航）/ resources / sessions /
  sidebarRight(Tabs) / uiRenderer / userQuestionPanels——均无会话导航。
  待上游暴露 `openSession` 钩子或服务后一行即可接入。
- **测试**：hover 门控（歌词 hover 不 ack / 插入窗口 hover ack）、冷挂载
  直达红点且无插入计时器、挂载后新通知仍插入、reduced-motion 契约更新、
  源码契约（polledBefore 抑制 + noticeRowShown 门控）。全套拿 v0.4.2
  负向验证会失败。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。

## 0.4.2 - 2026-11-07 (dev)

两个打磨点（用户实测 v0.4.1 后的反馈）：

- **① 红点的出现/点击退场补齐过渡。**
  - **出现淡入**：红点亮起改为 0.18s 淡入（`dnl-dot-in`，透明度 0→0.95 +
    轻微放大回弹），呼吸（`dnl-dot-pulse`）延迟 0.18s 接管——插入窗口结束
    那一刻红点不再「啪」地弹出。
  - **点击淡出**：v0.4.1 点击红点打开列表时是**立即卸载**（"主动交互立即
    退场"），用户反馈消失太快缺过渡——改回与被动清除一致的 260ms 淡出
    （`dnl-dot-out`），在展开面板下方完成，视觉连续。
  - `prefers-reduced-motion`：入场直接定格为静态可见（opacity .95），
    退场立即消失（原实现退场态 opacity 0，入场漏了定格）。
- **② 切换到「触发红点提示的会话」时，红点自动消失。**
  - 调研结论：宿主进程没有「当前主视图会话」事件（session 事件表无
    focus/active 类）；但**浏览器侧 client runtime** 的 `sessions` service
    暴露 `list.getSnapshot().byId[id].retainedBy.mainView > 0`——这正是 DSH
    官方 UI 判定「用户正在看的会话」的信号（官方未读标记 completionUnread
    同样对 main 视图豁免）。插件 client bundle 经 runner facade 的
    `ctx.get('sessions')` 可选查询拿到它。
  - 实现：`mainSessionIdOf()` 纯函数（防 try/catch，服务缺失/抛错返回 null）
    + `sanitizeNotices` 保留 wire `sessionId` + 派生区过滤
    `notices.filter(item => item.sessionId !== mainSessionId)`——纯展示层：
    用户切到该会话，其提问/轮次结束通知在**下一个轮询 tick（≤500ms）内**
    从胶囊/红点淡出；切走后自然恢复显示。所有既有淡入淡出机制原样复用。
  - 边界：主视图判定读取频率 = 轮询节奏（无额外接线）；多窗口/多客户端时
    任何持有 mainView retain 的会话都算「在看」（与官方语义一致）。
- **测试**（拿 v0.4.1 负向验证会失败，已验证）：
  `mainSessionIdOf` 单测（正常/零值/缺服务/抛快照）、`sessionId` 保留断言、
  main-view 过滤交互流（在看的会话无红点 → 切走红点恢复 → 切回淡出）、
  点击红点改为淡出断言、出现淡入 CSS 契约、reduced-motion 新形状契约。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。

## 0.4.1 - 2026-11-07 (dev)

三个打磨点（用户实测 v0.4.0 后的反馈）：

- **① 红点更低调 + 查看后消失（带淡出）。**
  - 视觉降噪：红点从 10px 亮红（#e5484d）缩到 8px 柔和红（#c65054），去掉了
    1.3× 缩放脉冲（在实机上过于醒目），改为缓慢的**透明度呼吸**（2.6s，
    0.95↔0.55）；hover 光圈同步降饱和。
  - **查看后消失**：新增 `POST /dsh-netease-lyrics/notice/ack` 路由 +
    `ackNotices()`（notice-aggregate）。「查看」的判定 = 悬停展开通知胶囊、
    或点击红点展开通知视图后**移出鼠标**。ack 消费**轮次结束**类通知
    （自然过期/宿主清理同样走淡出）；**提问类永不 ack**——回答提问是会话
    本体的职责，ack 不该把它吞掉。
  - 所有消失都**淡出**而非闪断：通知胶囊整块 260ms 淡出（`.dnl-host-fade`）
    后卸载；红点保留挂载 260ms（`.dnl-dot-out`：透明度+收缩）再卸载，
    `aria-hidden` 同步隐藏。`prefers-reduced-motion` 下立即静止消失。
    点击红点属于主动交互：立即退场，不在展开的面板下面跑淡出。
  - 防误吞：ack 前先重算一次快照——用户查看**之后**才到达的新通知
    （尤其提问）不会被这次 ack 抹掉。
- **② 播放中来通知：先「插入」1.8s，再交给红点。** 有 SMTC 时新通知不再
  直接缩成红点，而是把折叠行**暂时替换**为通知文案（与歌词行共用同一
  `LyricTransition`，双向交叉淡入淡出），1.8 秒后交还歌词行、红点亮起。
  插入窗口在**渲染期**武装（`setInsertDeadline` render-phase adjust——第一帧
  就要显示，v0.3.30 的绘制时序教训）；`noticeKey`（serial+headline）去重，
  只有新通知才重新插入；媒体恰好从停止→播放时，未 ack 的通知胶囊也获得
  一个完整的插入窗口再交接。指针悬到红点上会立即消耗插入窗口（胶囊不会
  在指针底下翻回歌词）。
- **③ 修译文占位（历史遗漏）。** v0.3.27 的「曲目级译文行高预留」
  （`hasAnyTranslation` + 隐藏的 16px 占位）副作用：**当前行没有译文、
  甚至还在显示歌名兜底文案时**，译文行也一直占着位——文字整体偏上。
  改为**每行自决**：所有行渲染同一个 `.dnl-now-trans` span，无译文的行
  加 `dnl-now-trans-empty` 类，用 `grid-template-rows:0fr` 折叠行高
  （0.2s ease 过渡，出现/消失平滑），胶囊内容在任何情况下垂直居中。
  歌名兜底、无译文行、带译文行三态高度各自正确。
- **宿主**：`/notice/ack` 与读同栅栏（`fence`，无外发请求），POST-only，
  返回 `{ ok, dropped }`；`ackNotices` 为纯函数（快照重算 + 只消费
  round-ending + serial 递增）。
- **测试**（全部拿 v0.4.0 负向验证会失败）：
  - `notice-aggregate.test.mjs`：ack 三态（同会话提问+轮次结束 / 纯轮次结束 /
    查看后新到达）+ 恶意形状。
  - `notice-client.test.mjs` 全面重写：hover-ack POST、ghost 淡出（host 挂载
    260ms 带类名再卸载）、插入窗口（首帧 notice 行、无 dot、1800ms 后交还
    歌词行 + dot 出现）、点红点立即退场、被动清除走 dot 淡出
    （挂载+`dnl-dot-out`+aria-hidden+卸载）、离开通知视图 ack。
  - `host-lifecycle.test.mjs`：ack 路由集成（POST 消费轮次结束、保留提问、
    GET 405）。
  - `line-width.test.mjs`：`noticeRowShown` 契约 + 译文行 grid 折叠契约
    （替代旧的 reserve 断言，含反向断言确保旧机制未复活）。
- 修测试环境坑：fake timer 的毫秒值与真实 `Date.now()` 有漂移
  （`deadline - now` 排出 1799ms），fireTimers 需带容差。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。
- **需用户实机确认**：① 红点观感（更小更静）；② 查看后胶囊/红点淡出消失、
  未查看的提问不受影响；③ 播放中通知先插入 ~1.8s 再变红点、双向交叉淡入淡出；
  ④ 无译文行/歌名态文字居中、有译文行正常双行。

## 0.4.0 - 2026-11-06 (dev)

- **新功能：会话区提示（工作区通知）。** 任意工作区的会话「有提问 / 一轮对话结束」时，
  插件现在会通知用户——两种形态由浮窗是否触发（有无 SMTC 媒体会话）决定：
  - **浮窗未触发**（无任何 SMTC 信息）：胶囊直接显示提示语本身——
    「**xx会话区有提问**」（待回答的 `ask_user_question` / 待确认的授权请求）或
    「**xx会话区第x轮对话结束**」（`turn/end`）；hover 展开可见完整列表
    （问题预览、轮次结局、时间）。多条时显示 `+n` 角标，最新提示经
    `LyricTransition` 交叉淡入。
  - **浮窗触发**（正在显示歌词）：只在胶囊**右下角显示一个红点**
    （18×18 方形命中区 + 10px 红点，带轻微脉冲；`prefers-reduced-motion` 下静止），
    点击红点才展开完整提示列表；齿轮 ✕ 返回歌词视图，红点复现。
    红点打开的列表与无媒体模式的列表共用同一 builder（`noticeList`），不会漂移。
- **数据链路**（宿主半边）：
  - 新增 `lib/notice-aggregate.js`（纯函数、零 I/O、零依赖）：
    - 通过 `ctx.on('session/event', …, { global: true })` 订阅**全进程**会话事件流，
      折叠每个**根会话**（子代理会话带 `header.parentSession`，直接跳过）的通知状态。
    - 提问判定沿用 `@deepseek-ai/dsh-user-questions` 投影折叠的 settle 语义
      （`pending` / `TOOL_OUTCOME_UNKNOWN` 保持可回答；答案批次 / 失败结束提问），
      但**不**看 request-header 的 timed 标志——阻塞式 `ask_user_question` 同样值得提示。
      `approval/asked` + `approval/decided`（never 策略下背靠背出现）合起来无净通知。
    - `turn/end` 记录「第 x 轮结束」；下一次 `turn/start` 使其失效；
      序列化时超过 10 分钟（TTL）的「轮次结束」自动退役——陈旧提示不会永远挂着。
    - 会话从 store 移除（`session/disposed`）时丢弃其全部通知。
  - `state.json` 新增 `notice: { serial, items[] }` 字段：`serial` 随状态递增，
    `items` 里每会话至多一条（提问优先于轮次结束，最新的在前，上限 12 条）。
  - 工作区显示名在**序列化时**解析：优先 `workspaceRegistry`（按 sessionIds
    归属，其次按 cwd 路径匹配，Windows 大小写不敏感），服务缺席时回退目录名。
    这样晚到的 registry 不需要刷新钩子，下一个轮询周期自然生效。
  - 订阅经 `safeOn` 防御式接线（root 无 `on` 的裸测试环境照常工作），
    折叠器 try/catch 包裹——畸形事件不会影响事件总线（observe-only，不阻塞 append）。
  - 禁用插件清空通知状态；重启用新状态（不会复活禁用期间观察到的事件）。
- **渲染契约**（浏览器半边，`lib/client.js`）：
  - `noticeMode = 无SMTC && 有通知`：隐藏条件从 `st === null || st.active !== true`
    改为 `!smtcActive && !noticeMode`；通知模式下无呼吸灯（呼吸灯宣告「正在播放」），
    无齿轮（面板即完整列表），`aria-label` 改读「会话区提示：…」。
  - 宽度测量 effect 增加 `noticeMode` 依赖并在该模式下重置 `lastLineWidth` 缓存
    ——通知行没有 `nowWrapRef`，不重置会在恢复歌词后跳过相同句的宽度写入。
  - `sanitizeNotices` 与 `sanitizeLines` 同级的防御层：畸形行跳过、字段归一、
    硬上限 12 条；`时钟标签/结局标签/标题文案` 全部纯函数，已导出到 `__test`。
  - hook 全部保持在合并早退 `if (!smtcActive && !noticeMode) return null` 之前
    （v0.3.18 事故教训：hook 数量变化会卸载整个组件）。
- **测试**（全部已接入 `npm test`，**拿 0.3.31 验证会失败**）：
  - `test/notice-aggregate.test.mjs`：根会话折叠全集（approval、ask_user_question
    含 PTC 变体、turn end/start）、settle 语义、dispose、TTL + 活跃会话修剪、
    排序与上限、恶意输入不抛错。
  - `test/notice-client.test.mjs`：真实 React 驱动真实组件——空闲+通知出胶囊
    （含中文文案逐字断言）、hover 展开完整列表、420ms 收起、交叉淡入两层并存、
    播放中只有红点、点红点开列表、齿轮返回歌词、红点复现、无通知无红点、
    空闲无通知仍完全隐藏（0.3.x 契约不回退）；另有源码形状契约
    （早退条件、红点按钮、CSS 锚点、reduced-motion 降级）。
  - `test/host-lifecycle.test.mjs` 新增宿主集成块：事件→`state.json`
    全链路、子会话忽略、`session/disposed` 丢弃、teardown 退订两个事件。
  - `test/line-width.test.mjs` 契约更新：依赖数组必须含 `noticeMode`，
    且通知模式重置测量缓存（断言文字描述各自的不变量）。
- `npm run check`（六文件）/ `npm test`（fail 0）/ `npm run test:bridge` 全套通过。
- **需用户重启 DSH 实机确认**：① 无媒体时有提问/轮次结束，胶囊显示对应文案；
  ② 播放中同一通知只出现红点，点击展开列表；③ 提示消失（回答/下一轮开始）
  后胶囊/红点随之消失。

## 0.3.31 - 2026-11-06 (dev)

- **修复：展开态下拖动，胶囊窗口会被横向拉长。**
  - 真因：v0.3.26 为让**收起态**胶囊宽度平滑过渡而写入的「按当前行测量的显式
    宽度」，在**展开态**依然生效。`.dnl-now-wrap` 收起靠
    `grid-template-rows:0fr`，这只把**高度**压成 0、**宽度仍参与布局**，
    于是长歌词行把整个展开面板横向撑开。
  - 实测（真实 Chrome，展开态）：短句胶囊 **362px** → 长句 **598px**（撑宽 236px）
    → 短句 362px。拖动时歌曲仍在播放，每换到长句就撑开一次，
    看起来就是"一拖就被拉长"。
  - 修法：显式宽度**只在收起态生效**；展开时清空（`wrap.style.width = ""`）
    并把 `expanded` 加入 effect 依赖，收起时重新测量并重新钉住。
  - 复验：展开态短/长/短三种歌词下胶囊恒为 **362×341**，`wrap.style.width`
    为空、与列表同宽；**收起态未受影响**——仍按当前行插值（实测 35 个中间宽度，
    74→295→113，逐帧最大变化 45.2px，与修复前一致）。
  - 测试：`test/line-width.test.mjs` 增加两条契约——宽度 effect 必须随
    `expanded` 重跑、展开时必须清空显式宽度；**拿修复前版本验证会失败**
    （`the width effect also re-runs on expand/collapse`）。

## 0.3.30 - 2026-11-06 (dev)

- **「换句时闪过另一句」的真正原因找到了：交叉淡入的「淡出层」是在
  `useEffect` 里创建的，也就是浏览器已经绘制之后。**
  - 机制：换句那一帧 `previous === null`，新句**没有 `dnl-fade-in` 类**、
    以满不透明度直接出现；随后 effect 才把旧句以 `dnl-fade-out`
    （opacity 从 1 开始）插进来、新句的 `dnl-fade-in` 从 0 重新开始 ——
    于是**刚切走的那句又盖回屏幕**，然后才真正交叉淡入到新句。
    在收起态窄胶囊上，这就是"该切下一句，中间却快速闪过别的一句"。
  - 修法：抽出 `nextTransitionFrame(frame, identity, children)`，在**渲染期**
    派生 `previous`（React 官方 "adjust state when props change" 模式）。
    第一帧就同时带旧层和新层，淡入淡出只跑一次。effect 只负责 240ms 后
    **清除**旧层，绝不再创建它。
  - **为什么之前多轮探针都判错**：headless（无 GPU）会把 effect 在同一帧内
    冲刷掉，两种写法截图像素完全一致（实测逐帧 opacity 序列一模一样）。
    这个缺陷只在真实 GPU 合成的 DSH 窗口里可见 —— 靠浏览器探针**测不出来**。
    用户实机验证：撤回这处改动后"闪另一句"立刻复现，恢复后消失。
  - 测试：新增 `test/line-crossfade.test.mjs`（`nextTransitionFrame` 的纯函数
    契约 + 源码形状断言"effect 不得创建 previous"），已接入 `npm test`；
    **拿修复前版本验证会失败**。这一条专门防止该改动被再次误删
    —— 本轮曾把它当作"实测无差别"而 stash 掉，实机立刻回归。
- `npm run check` / `npm test`（fail 0）全套通过。

## 0.3.29 - 2026-11-06 (dev)

- **「闪过另一句」的真正根因（第三次定位，这次有实测对照）：一次陈旧的
  位置回退读数被当成换句。** 0.3.28 的迟滞只处理了"边界抖动"，但还有另一种
  情况：播放器偶尔在**一个轮询周期内**回报一个更旧的位置（切歌/会话更新瞬间
  常见），raw 索引因此掉一大截，迟滞带（0.35s）挡不住，于是先显示上一句、
  下一轮询再纠正——正是"中间突然快速闪过另外一句，然后才切到下一句"。
  - 复现（真实 Chrome，pos `12 → 2 → 12`，500ms 轮询）：
    `C3 → OUT:C3/IN:A1 → OUT:A1/IN:C3 → C3`（**A1 闪了一次**）。
  - 修法：`settleLineIndex` 增加**回退确认**——向后的索引变化必须在
    `backwardSettleMs(pollMs)` 内保持不变才提交。该窗口最短 750ms，
    且**恒大于一个轮询间隔**（`max(750, pollMs*1.5)`）。
    - 第一版窗口写死 450ms，小于 500ms 的轮询间隔，陈旧读数照样活过窗口、
      仍然闪 —— 这就是 0.3.28 没修好的原因，已实测记录。
  - 复验：同一场景只剩 `C3`，**完全不闪**；边界抖动场景 `A1→B2` 仅 1 次切换；
    真实向后拖动进度仍会生效（晚一个轮询周期）。
- **「左侧拖动很容易误触发展开」已修**。三个独立守卫，覆盖三个不同时刻：
  1. 手势进行中（`dragRef` 非空）不展开；
  2. 手势结束后 400ms 内不展开（指针还停在胶囊上，正是误展开的时机）；
  3. 从左侧 gutter 进入不展开（展开会在手势中途改变胶囊与手柄尺寸）。
  另外 `suppressClick` 改为**在 pointerdown 时就置位**（原来要移动满 4px 才置位），
  所以"轻轻一拖"不会漏出 click 去触发 island 的展开+钉住。
  - 复验：悬停 gutter、2px 微拖、真实拖动三种情况 `expanded` 均为 `false`。
- 同一渲染帧只计算**一次**索引（`index = indexForHooks`）：原先渲染路径与
  滚动/宽度 effect 各自读一次时钟，可能短暂不一致，且会让有状态的守卫被推进两次。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过；
  `test/line-hysteresis.test.mjs` 扩到覆盖回退确认与窗口尺寸。

## 0.3.28 - 2026-11-06 (dev)

- **紧急修复：package.json 被写入 UTF-8 BOM，导致插件完全无法加载**。
  报错 `Unexpected token '\uFEFF', "﻿{ "name"... is not valid JSON`。
  根因：改版本号时用了 Windows PowerShell 5.1 的
  `Set-Content -Encoding UTF8`，**它会写 BOM**（这个坑我自己都写进经验卡了，
  却还是踩了）。宿主用裸 `JSON.parse` 读 manifest，带 BOM 直接抛错 ——
  `npm test` 却照常通过（npm 自己会剥 BOM），所以测试没能拦住。
  - 修法：以 `UTF8Encoding(false)` 重写 `package.json`，首字节恢复为 `7B`（`{`）。
  - **防回归**：新增 `test/manifest-encoding.test.mjs`，检查 `package.json`、
    同目录 `*.json` 与 `cordis.patch.yml` 均无 BOM 且 JSON 可解析；已接入
    `npm test`。已用"重新注入 BOM"验证过它确实会失败。
  - 教训：改 JSON/YAML 清单**只用编辑器或带 `UTF8Encoding($false)` 的写入**，
    不要用 `Set-Content -Encoding UTF8`；并且"测试通过"不等于"宿主能加载"。

用户再次澄清了两个现象，此前两轮都判断错了方向，本轮按用户描述**先复现、再修**：

- **「换句时快速闪过另一句歌词」的真因：`positionSec` 抖动 + 行索引无迟滞。**
  不是宽度、不是译文、不是高度。真实播放器的位置上报本来就有抖动
  （SMTC 快照常抖 ±0.2s，时钟还会在其上插值）。`currentLineIndex` 是纯二分
  `t <= pos`，没有记忆：抖动在行边界来回跨一次，索引就来回翻，
  `LyricTransition` 于是反复把**上一句**重新渲染进交叉淡入
  —— 视觉上就是"该切到下一句，中间却闪了另一句"。
  - 复现（真实 Chrome，pos 在 5s 边界 `4.8 ↔ 5.2` 抖动）：
    `B2 → OUT:B2/IN:A1 → OUT:A1/IN:B2 → B2 → OUT:B2/IN:A1 → A1 → B2`
    —— 11 次切换，A1 反复闪现；平滑播放则只有 `A1→B2→C3` 正常推进。
  - 修法：新增 `stickyLineIndex` + `LINE_HYSTERESIS_SEC = 0.35`。
    前进要越过 `t(下一句) + 0.35`，后退要低于 `t(当前句) − 0.35`；
    带内一律保持屏幕上那一句。真实跳转/拖动进度仍是立即生效。
  - 复验（同一抖动场景）：`A1 → OUT:A1/IN:B2 → B2`，**只切换 1 次**，无闪现；
    平滑播放、小回退场景均正常。
  - 测试：新增 `test/line-hysteresis.test.mjs`（纯函数 + 源码契约），
    已接入 `npm test`；**拿未修复版验证会失败**。
- **「左侧完全拖不动」的真因：点在 DSH 窗口的拖拽区上，不是胶囊。**
  本 CSS 此前**一处 `app-region` 都没有**。DSH 的 Electron 窗口顶部有窗口
  拖拽条，而胶囊固定在 `top:12px` 正落在其中 —— 在其上按下指针会被窗口
  拿去拖窗口，页面根本收不到事件，所以"点到的其实是 DSH 窗口"。
  同类插件 `dsh-audio-pulse` 明确注释这是 body-level overlay 的硬性要求。
  - 修法：`.dnl-host` 加 `-webkit-app-region:initial`（声明这是页面图层、
    不打穿窗口拖拽区），`.dnl-island` 加 `-webkit-app-region:no-drag`
    （胶囊内部永远是"不拖窗口"区域）。
  - 测试：`test/ambient-client.test.mjs` 增加两条 CSS 契约断言。
- `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。

## 0.3.27 - 2026-11-06 (dev)

用户实机反馈两点，均已在真实 Chrome 里复现并修复：

- **换句时"文字乱跳"的真因：收起态胶囊高度在 34px ↔ 51px 之间跳。**
  带译文的歌词行（`.dnl-now` 39px）比不带译文的（22px）高 17px，换句时高度
  一帧内突变、且没有 height 过渡，于是文字整体上下位移。实测
  `hostH` 取值 `[34, 51]`、`.dnl-now` 取值 `[22, 39]`。
  - 修法：只要这首歌**任意一行**有译文，所有行都预留译文行高
    （`.dnl-now-reserve`，16px，`visibility:hidden`）。修复后实测
    `hostH` 恒为 51、`.dnl-now` 恒为 39，换句不再改变高度。
- **收起态左侧"完全拖不动"的真因：悬停展开抢走了拖动。**
  v0.3.26 里 `.dnl-drag` 覆盖左侧 30px 后，指针一进入就触发
  `onMouseEnter` → `setExpanded(true)`，胶囊从 118×34 展开到 263×318，
  拖动手柄的盒子在手势中途被改掉，拖动直接失效、位置也没保存。
  实测对比：v0.3.26 拖动只移动 73px 且松手弹回 0px；
  - 修法：指针从**左侧 gutter**（拖动手柄的盒子）进入时不展开；
    胶囊其余部分仍然悬停展开。修复后实测拖动跟随 −120px、
    松手保持 −120px、`display.v1` 写入 `x:0.60625`、重新挂载仍生效。
- **撤回 v0.3.26 的"固定宽度"方案**：用户明确表示"不能这么固定宽度，
  这还不如不改"。宽度恢复为按**当前行**测量（保留 `transition:width`
  平滑插值），不再整曲定宽。
- 测试 `test/line-width.test.mjs` 同步更新为三条契约：按当前行测宽 +
  高度预留（`hasAnyTranslation` / `.dnl-now-reserve`）+ gutter 不展开；
  `npm run check` / `npm test`（fail 0）/ `npm run test:bridge` 全套通过。

## 0.3.26 - 2026-11-06 (dev)

**更正 v0.3.25 的结论**：用户实机反馈「呼吸灯关掉也乱跳」，据此复测证实
**逐句涟漪（.dnl-kick）不是主因**。v0.3.25 把 kick 改为按曲目触发本身无害
（少了一次逐句重绘、切歌脉冲保留），但**没有解决乱跳**，特此更正，勿沿用上一版
「关灯即恢复 / 净增重绘 3108→741 已修好」的说法。

- **真正修复：收起态胶囊换句时宽度瞬跳（关灯、开灯都跳）**。
  上一轮所有探针都用了 `one/two/three` 这类**等宽短词**，测出的宽度变化只有
  0.32px，完全掩盖了真实歌词的长短差异 —— 这是测试设计的硬伤。
  改用真实长短歌词后实测（真实 Chrome，rAF 逐帧量 `.dnl-island`）：
  - 长句→短句：宽度 **59 ↔ 362 px**，**单帧跳 198.86 px**，左边缘（host
    用 `translateX(-50%)` 居中）跟着平移 **99.43 px**；
  - **off 与 theme 数值完全一致**，这正是「关灯也跳」的答案；
  - 对照 v0.3.22 / v0.3.24 / v0.3.25 三版：跳变全都一样（198.86 / 99.43），
    说明**不是本会话引入的回归**，而是自 v0.3.22 起一直存在的老问题。
  - 机制：收起态胶囊宽度由文字长度决定，`.dnl-island` 的 transition 只覆盖
    `max-width/padding/border-radius`，**没有 width 过渡**；`LyricTransition`
    交叉淡入时两层文本叠在同一 grid cell，宽度被旧句撑住 240ms，旧句移除即
    瞬间塌到新句宽度。
- **修法（用户选定「宽度做平滑过渡」）**：新增 effect 在每次换句后测量当前句
  的自然宽度，写成 `.dnl-now-wrap` 的显式 px 值；CSS 加
  `transition:width .28s cubic-bezier(.2,.7,.3,1)`。
  - 已排除的方案：`.dnl-fade-out` 绝对定位（仍 198.86px）；`min-width` 固定
    （跳变 0 但胶囊变宽、且用户要的是过渡不是定宽）；纯 CSS
    `interpolate-size: allow-keywords`（本 Chromium 实测无效，仍 198.86px）。
  - 复验（真实 Chrome，实际修改后的 client.js，非 CSS 覆盖模拟）：
    长→短单帧跳 198.86 → **40.7px**、短→长 → **64.6px**，经 **16–18 个中间
    宽度**在 ~280ms 内平滑收敛（如 260→152→63→61）；off 与 theme 一致。
    首帧 40–65px 是缓动曲线的正常起点，之后逐帧连续，不再瞬跳。
  - **歌词换句交叉淡入/淡出动画完整保留**（`LyricTransition` / `.dnl-fade-in`
    / `.dnl-fade-out` 在 v0.3.22–v0.3.26 从未被删除；是宽度瞬跳把过渡观感
    破坏了，用户确认「就是被跳变破坏的淡入淡出」）。
  - 测试：新增 `test/line-width.test.mjs`（真实 React + CSS/源码契约断言 +
    换句不抛错），已接入 `npm test`；**拿未修复版验证会失败**。

## 0.3.25 - 2026-11-06 (dev)

- **修复：开启呼吸灯后，歌词切换时"乱跳"重新出现（关掉呼吸灯即恢复）**。
  真因不是 v0.3.22 的双列表回归（实测换句时 halo/island/lines 节点都不重挂），
  也不是布局位移（6.2s 呼吸周期内 host 的 x/y/w/h 像素级不变）或掉帧
  （真实 Chrome 三变体 rAF 均 16.6ms、零丢帧）。用逐帧截图像素 diff 做
  5 变体对照才定位到：呼吸灯的逐句涟漪 `.dnl-kick` 的 React key 含 `index`，
  **每换一句就重挂并回放一次 `blur+scale` 动画**，那次大面积重绘正好砸在
  歌词淡入的同一帧。隔离实验：换句净增重绘 关灯 456 px / 开灯 3108 px /
  去掉 kick 后回落到噪声水平；去掉常驻呼吸但保留 kick 仍有 1149 px
  —— 主因是逐句涟漪，不是呼吸动画本身。
  - 修法：`key` 从 `kick:<songId>:<index>` 改为 `kick:<songId>`，涟漪改为
    **按曲目**触发（切歌时仍有一次脉冲），换句不再重播。呼吸灯四层动画、
    节奏、颜色来源、暂停冻结全部不变。修复后实测换句净增回落到 741 px
    （关灯基线 430 px 的噪声量级），换句窗口不再出现 1146/1081 式脉冲。
  - 测试：新增 `test/halo-kick.test.mjs`（真实 React 18，驱动真实换句/切歌），
    已接入 `npm test`；**拿未修复版验证会失败**（`kick key 含行号` 断言），
    修复版通过。
- **改进：胶囊收起态左侧整条区域都可拖动位置**。原先只有一个 20×28 的居中
  手柄，实测收起态左侧 30px 区域 72 个采样点里 34 点命中手柄、22 点只落在
  island（点击只"钉住"）、12 点落在文字。现在拖动手柄覆盖整个 30px 左侧
  padding 盒并与胶囊等高（`left:0;top:0;bottom:0;width:30px`）。
  真实 Chrome 复验：240/240 采样点全部命中 `.dnl-drag`。
  该盒子内没有任何控件，不会吞掉控件点击；展开态同样生效。
- **新增 30 分钟 CPU / 内存稳定性采样**：`STABILITY-REPORT.md` +
  `STABILITY-samples.csv`（177 轮 / 10s 间隔 / 7 类进程 / 1726 行）。
  边界：进程级采样，不是插件内部 JS 堆或帧率；同一 renderer 还跑着 GUI
  与其它插件，不能把 CPU/内存变化单独归因到本插件。
- **修正验证命令**：`npm run test:bridge` 原直接 `powershell -NoProfile -File …`，
  在本机有效策略 `RemoteSigned` 下报 "not digitally signed" 失败（D: 盘
  未签名 .ps1 被拦）。已给三条命令补 `-ExecutionPolicy Bypass`，与宿主启动
  `lib/smtc-bridge.ps1` 时 `lib/index.js:339` 的做法一致；生产运行不受影响。

## 0.3.24 - 2026-11-02 (dev)

- **修复：从设置视图返回后，胶囊偶发不再自动收起**。
  根因：设置面板里的**所有控件**（滑块、颜色、下拉、输入框、重置按钮）点击时都会冒泡到 `.dnl-island`，
  而胶囊的 `onClick` 会把 `pinned` 设为真；被钉住后 `mouseleave` 直接 `return`，于是鼠标移出也不收起。
  胶囊内的齿轮和 5 个播放按钮各自 `stopPropagation` 了，唯独设置面板没有——这就是"偶发"的来源：
  只在面板里动过控件才会触发。
  - 设置面板容器统一 `stopPropagation`，一处覆盖全部控件，不必给约 20 个控件逐个加。
  - 同时修正钉住的语义：指针离开胶囊后清除 `pinned`。钉住是为了在面板里操作时不被误收起，
    不该变成"再也关不掉"。
- 测试：新增 `test/capsule-pin.test.mjs`，用真实 React 走完"悬停→开设置→改控件→返回→移出"全流程，
  并断言齿轮/返回按钮确实阻止冒泡、面板守卫存在、故意点击钉住后移出仍会释放。
  该用例已接入 `npm test`，且在未修复版本上确认会失败（不是恒真测试）。

## 0.3.23 - 2026-11-02 (dev)

本轮复核实现、运行效率和兼容性；详细边界见 [复核报告](REGRESSION-AUDIT.md)。

- 前端：两个浮层真正共享一套状态轮询与播放时钟；无曲目／暂停时不再定时触发进度外推渲染；最后一个订阅卸载后取消请求与计时器，隔离旧响应。
- 歌词数据：按原数组缓存清洗结果并排序，居中与渲染使用同一索引；补全设置项 key、修复 RAF 降级计时器的卸载清理。
- 宿主：修复 PowerShell 异步启动失败不重试、stdin 异步错误未处理、旧进程／旧请求污染重新启用实例；dispose 后重试不可复活。
- 歌曲观察键保留版本、专辑、播放器与秒级时长，避免标准／Live 版本和稍后到达的时长被旧匹配遮住。
- 宿主启用 latestOnly 检索：切歌立即取消过时 HTTP、响应体读取与限流等待，跳过过时排队任务；保留同曲去重与请求间隔。服务 dispose 取消未完成工作及持久化定时器。
- 封面切歌／会话消失时先清除旧图；读取失败最多三次、每次相隔五秒，成功后停止重读；无图时环境歌词颜色回归主题。
- 本地解析：修复 UTF-16BE、SYLT 双字节终止符和 ID3v2.3／v2.4 扩展头；支持 LRC offset；本地扫描预算过期后不再开始候选 I/O。
- 缓存：本地命中不跨配置持久化；逐项跳过畸形缓存，不让一条坏歌词阻断后续有效缓存。
- 测试：新增真实 React 18 生命周期、共享请求、宿主代次、旧请求取消和 PowerShell 封面状态机用例；渲染烟雾测试不再写死本机路径。测试渲染器仅为开发依赖，不进入运行文件。
- 更正验证口径：此前 PASS 输出行数不等于总断言数；静态 HTML／shim 也不能验证生产 React 交互。本轮没有启动 Chrome 或操作播放器，不声称测过真实布局帧率、CPU 降幅或所有 Windows／播放器版本。

## 0.3.22 - 2026-10-28 (dev)

- **真正修复:展开窗口换句"卡一下再跳"**（0.3.21 的判断是错的，那个改动没有解决问题）。
  真正的根因：展开窗口把**整个 9 行列表**包进了 `LyricTransition`，而它的 `identity` 含 `index`。
  于是每换一句都会同时渲染**两份完整列表**（旧的一份用于淡出、新的一份用于淡入）——
  两份列表各自有滚动位置、`ref` 指向不确定，视觉上就是"卡住、然后跳"。
  收起态只包一行，所以不受影响，这与"收起没问题"完全吻合。
  - 展开窗口不再使用 `LyricTransition`：列表本来就靠活动行高亮 + 滚动来表达变化，不需要交叉淡入。
    实测换句时列表容器数量 `1 → 1`（此前是 2），面板内交叉淡入包装器 `0` 个。
  - 活动行原本 `font-size` 12→13、`font-weight` 400→600 都**没有过渡**，行高会瞬间跳变，
    而居中目标又按行高计算，于是滚动要再纠正一次。现在两者都加了 0.2s 过渡，与颜色变化同步。
- 测试:新增两条守卫——"歌词列表不得被 LyricTransition 包裹""活动行字号必须过渡"；
  连同上一轮的"不得出现 scroll-snap"，三条一起锁住这个现象。

## 0.3.21 - 2026-10-28 (dev)

- **修复:展开窗口换句时"卡一下然后无过渡地跳"**。0.3.19 我加了
  `scroll-snap-type:y mandatory` + `scroll-padding-block:50%` 想让引擎自己居中，
  但居中 effect 同时也在写 `list.scrollTop` —— mandatory snap 会在那次写入后立刻重新吸附到最近的吸附点，
  两者逐帧互相纠正，表现就是"卡住再跳"。收起态不滚动，所以不受影响。
  - 移除全部 scroll-snap 规则（effect 本身已能正确居中）。
  - 居中改为 `scrollTo({ behavior: "smooth" })`，让行的移动和淡入淡出同时发生，而不是淡入落在一个瞬间跳变上；
    `prefers-reduced-motion` 与不支持平滑滚动的引擎仍回退为瞬时赋值。
- 测试:锁定"CSS 不得出现 scroll-snap""居中必须用平滑滚动""必须有 reduced-motion 回退"。
- 环境:清理了前几轮验证遗留的 38 个 headless Chrome 配置目录（2.2 GB）与孤儿进程；
  验证脚本改为杀整棵进程树 + 硬超时。

## 0.3.20 - 2026-10-28 (dev)

- **修复:外语歌拖动时窗口会改变大小**。重钳制 effect 的依赖里含 `dragPosition`，于是每次 pointermove 都重跑；
  而钳制又是按 host 自身盒宽算的，宽度一变（外语歌词行更长）就反过来改写位置，形成"拖一下就变尺寸"。
  现在该 effect 不再依赖 `dragPosition`，且拖动进行中直接跳过——位置由拖动路径独占。
  实测（带译文行）：整个拖动过程中 island 恒为 266×343，300 帧里只有一种宽高值。
- **修复:齿轮仍然只有从一个方向能点到**。根因是按钮挂在 `.dnl-head` 下，而 `.dnl-head` 是
  `.dnl-grow-inner`（`overflow:hidden`，0fr→1fr 高度动画所必需）里的第一行——齿轮顶边正好落在裁切边界上
  （两者都在 y=33），上半部分被裁掉、命中落到后面的 island，所以只有下半部分可点，
  这正是"只能从左下角接近"的原因。
  现在它是 `.dnl-panel` 的**直接子元素**，绝对定位并距上/右各 4px，任何边都不贴裁切边界；
  同时它在一个地方渲染、两个视图共用（设置视图里原本的重复返回按钮已删除）。
  实测：32×32 盒内 81/81 个采样点全部命中齿轮。
- 测试:CSS 断言改为锁定"绝对定位 + 正间距（负间距会被再次裁切）+ 32px 目标 + 不再依赖 header 流"，
  并要求设置视图仍恰好有一个按钮（避免回不去）。node 侧 112 项、PowerShell 侧 15 项全过。

## 0.3.19 - 2026-10-28 (dev)

回归自查轮，未新增功能。查出并修掉 2 个真实缺陷，补上 1 类测试盲区。

- **修复:歌词行数组里出现畸形条目会让整个胶囊崩溃**。`currentLineIndex` 直接访问 `lines[mid].t`，
  而歌词数据来自第三方接口 + 缓存文件，一条 `null` 或半成品行就会抛错，把整个浮层卸载掉
  （和 0.3.18 的 hook 问题一样，表现都是"胶囊消失"）。新增 `sanitizeLines()` 统一清洗
  （丢掉非对象行、`t` 非数字归 0、`text` 非字符串归空、空译文归 undefined），胶囊与环境浮层两个组件共用；
  `currentLineIndex` 自身也加了防御。
- **修复:设置视图里的返回按钮尺寸为 0**。`dnl-gear` 在设置视图里由 `.dnl-set-head-row` 承载，
  而那条 flex 规则没有保证尺寸；实测返回按钮 `26x26` 变成 `0x0`，`elementFromPoint` 落到 `BODY`。
  现在该按钮有显式尺寸并可命中（实测 26×26、最上层就是它自己）。
- **居中改为引擎级**。歌词框靠 `useEffect` 设置 `scrollTop` 来居中，但 effect 在绘制之后才跑，
  首帧会看到未居中的位置。新增 `scroll-snap-type:y mandatory` + `scroll-padding-block:50%`，
  由浏览器在首帧就把当前句吸附到中间（实测 `scrollTop` 从 0 变成 56），effect 再补齐到精确值（59% 以内）。
- **新增 `test/render-audit.test.mjs`（47 项）并接入 `npm test`**：遍历 20 种真实状态快照
  （无曲目 / bridge 启动中 / idle / loading / unmatched / error / 无行 / 单行 / 有无译文 / 暂停 /
  零时长 / 位置越界 / 负数位置 / 无封面 / 播放器全不支持 / 超长标题 / emoji / 本地无时间轴），
  每个都断言胶囊与环境浮层不崩、能渲染出节点；另含 4 类畸形输入与 6 项交互结构检查。
  **这正是 0.3.18 漏掉的分支**——原测试只渲染"有内容"的路径。
- 真实实例与浏览器逐项验证（本轮一次性，不长期保留）：12 项浏览器交互全过
  （尺寸、紧凑、居中、不裁切、齿轮/手柄/5 个按钮的命中、齿轮开关设置、拖动位移、悬停不收起），
  线上 `/state.json` 无一致性异常，7 条路由行为正确（含 `pos:null` 被拒）。

## 0.3.18 - 2026-10-28 (dev)

- **紧急修复:胶囊整个消失了**。0.3.17 我把"把当前句滚动到中间"的 `useEffect` 插在了
  `if (st === null || st.active !== true) return null;` **之后** —— 这违反 React Hooks 规则：
  没有播放内容时先早退，hook 数量与有内容时不一致，React 直接抛错并卸载整个组件，于是胶囊彻底不渲染。
  已把该 effect 移到早退之前，并把它依赖的 `pos / lines / index` 提前无条件计算（这样每次渲染 hook 数量一致）。
- **新增 Rules-of-Hooks 守卫**：测试会解析每个组件体、剥掉注释、按大括号深度只统计**组件级** return，
  一旦发现其后还有 `useState/useEffect/useRef/...` 就失败。守卫自带两个自检用例
  （必须能抓到"早退后接 hook"，且不得误报"回调里的 return"或注释里的 return），避免它静默通过。
- 修复后实测：展开高度 340px（歌词列表 184px）、齿轮与拖动手柄仍是各自的最上层元素、
  收起高度从 340 平滑降到 53，无异常尖峰。

## 0.3.17 - 2026-10-28 (dev)

- **回退 0.3.16 的悬停缓冲圈**。那圈 `::after{inset:-14px;pointer-events:auto}` 是绝对定位且接收指针的，
  在绘制顺序上盖住了胶囊的所有子元素：`elementFromPoint` 在齿轮中心和拖动手柄中心都返回 `dnl-island` 本身 ——
  于是**齿轮点不开**、**拖动失效**，收起时量到的高度还冲到 650px（静止高度 53px），
  就是"窗口一瞬间被拉到界面底部"的现象。已整体移除。
  改用**时间**而不是**空间**来解决误触：`mouseleave` 后的收起宽限从 260ms 提到 **420ms**，
  指针擦边后仍有足够时间移回，不再需要任何不可见的覆盖层。
- **展开窗口恢复紧凑**。0.3.16 为了让译文行不被裁而取消了歌词框的高度上限，结果 9 行带译文约 297px，
  整个胶囊涨到约 485px。现在歌词框回到 **184px**，但改为 `overflow-y:auto` **滚动**而不是裁切，
  并把当前句**滚动到可视区中间**（实测居中 49.7%）。既不会裁掉行，也不会把窗口撑大。
- 测试:新增"胶囊上不得有任何伪元素覆盖层""拖动手柄与齿轮仍是独立可命中元素""收起宽限 ≥300ms"
  以及"歌词框必须有界且可滚动（不得裁切）"四类断言 —— 直接锁住这次回退的三个症状。

## 0.3.16 - 2026-10-28 (dev)

- **修复:有翻译的歌词不居中**。两个原因叠加：
  1. 歌词框有 `max-height:184px; overflow:hidden`，而 9 行带译文的行实际需要约 237px —— 最后两行被裁掉，
     高亮行看起来贴底。窗口本来就是固定 9 行，高度已被内容限定，这个上限只会伤到自己，已去掉。
  2. 越界占位行只填了一行文字（18px），但带译文的真实行是两行（33px）。于是歌曲开头/结尾的占位行比真实行矮，
     高亮行被拉偏 —— 实测 38.8% 而不是 50%。现在占位行在**歌词含译文时也补一行译文占位**，高度与真实行一致。
  实测修复后：有译文 50%、无译文 50%，且没有任何行被裁切（`clippedBelow` 为负值，即底部仍有富余）。
- **修复:齿轮依然不好点（只从左下方慢慢移入才成功）**。齿轮距胶囊顶边只有 13px、距右边 21px，而胶囊是 14px 圆角，
  指针移向它时很容易跨出边界触发 `mouseleave`。现在胶囊自带一圈**14px 的透明悬停缓冲区**
  （`::after` 伪元素，属于胶囊本身，不是一个独立的事件目标），命中区实测向外扩了约 10px。
  实测：从缓冲圈三个方向走向齿轮、以及"先冲过头再折回"的路径，**0 次 mouseleave**。
- 测试:新增"占位行必须带译文占位""歌词框不得有高度上限/不得裁切""胶囊必须有悬停缓冲圈"三项断言。

## 0.3.15 - 2026-10-28 (dev)

- **修复:齿轮点不到，一靠近胶囊就收起**。0.3.14 的齿轮用 `position:absolute; top:-4px; right:-6px`
  挂在 `.dnl-panel` 上，而它的祖先 `.dnl-grow-inner` 是 `overflow:hidden`（高度动画必须如此）。
  实测：齿轮顶部被裁掉 4px、右侧被裁掉 6px，26×26 的目标里约三分之一落到下层；剩下那点可见部分
  又正好压在胶囊 14px 圆角外，而圆角外不在 `.dnl-island` 的命中区内 —— 于是"瞄准齿轮"实际是在胶囊边缘
  悬停，胶囊立刻收起。
  改法：齿轮作为**头部行里的普通 flex 项**（`margin-left:auto`），完全落在面板的裁切盒内，不再有负偏移。
  实测：齿轮四边距胶囊边缘 219 / 13 / 21 / 301 px，**完全在内**；对齿轮自身 6×6 采样 **36/36 命中它自己**；
  从四个方向走过去 **0 次 mouseleave**（修复前从外侧靠近必然触发）。
- 齿轮现在在**歌词视图和设置视图里都渲染**（设置视图里是同一位置的 ✕），否则打开设置后就无法返回。
  标题行右侧留出 28px，避免齿轮压住曲目名。
- 测试:新增"齿轮必须完全位于胶囊盒内"与"命中区不得被裁切"的断言；齿轮用例同时覆盖两个视图的返回路径。

## 0.3.14 - 2026-10-28 (dev)

- **面板不透明度改为可调**。0.3.13 把展开态背景"画两遍"以更不透明，但浅色窗体 + 浅色字下反而更糊 ——
  这是判断失误，已撤掉。现在 `display.v1.panelOpacity`（20–100%）通过 `color-mix(... calc(var(--dnl-panel-alpha) * 100%), transparent)`
  缩放**主题叠加层自身**的 alpha：100% 就是主题原样（不写死颜色值），越低越透出壁纸。
  上限刻意定在主题值 —— 比主题更不透明在浅色主题下只会更糟。
- **展开胶囊右上角新增齿轮**，点击把面板切换为「歌词胶囊设置」，把原本在插件设置页里的胶囊可调项
  （颜色、呼吸灯、呼吸节奏、字体、位置、以及新的不透明度）搬进来；齿轮再点一次回到歌词。
  插件设置页的「歌词胶囊」分组随之删除，避免两处重复维护。
- 测试:新增齿轮视图（开关切换、`aria-pressed`、被搬入的控件齐全、且已从插件设置页移除）与
  不透明度偏好（默认 1、60% → 0.6、越界钳制到 20%/100%、CSS 必须用变量而非"画两遍"）。

## 0.3.13 - 2026-10-28 (dev)

- **展开态提高不透明度**，方便隔着壁纸读歌词。叠加层 token 是半透明的、具体 alpha 由主题决定，所以不写死颜色值，
  而是把同一颜色画两遍（`background-color` + 一层自身颜色的渐变），alpha 合成为 `1-(1-a)^2`，在任何主题下都更实。
- **修复:歌曲末尾最后一句歌词沉底**。歌词窗口原本按 `index±4` 再夹紧到数组范围，唱到最后一句时后面没有行可"推"，
  高亮行就被留在底部。改为**固定 9 行窗口 + 越界槽位用隐藏占位行填充**（`lyricWindow` 纯函数），
  高亮行在开头、中间、结尾都恒为第 5 行。实测三种状态高亮行中心均在容器的 56.8% 处。
- **新增 ±5 秒前进/后退**。`POST /control` 白名单加入 `seek`，位置经校验后透传给桥；桥先查
  `IsPlaybackPositionEnabled`，不支持时回 `no-seek`（界面提示"该播放器不支持跳转"）而不是静默失败。
  两端都做钳制：客户端 `seekTarget` 把目标夹在 `[0, duration]`，宿主再用当前时长兜一次底。
  顺带修掉一个真实的健壮性缺口：`Number(null)` 与 `Number('')` 都是 0，原本会把"缺失 pos"当成"跳到 0"
  再等一个永不到来的 ack —— 现在只接受真正的数字。
- 测试:客户端新增 `lyricWindow`（9 种窗口情形：中段/首句/末句/短歌词/空输入）与 `seekTarget`
  （前进/后退/两端钳制/无位移/未知时长）的纯函数断言，以及渲染侧"高亮行居中"与按钮能力门控；
  宿主新增 seek 校验（拒绝 `abc`/负数/`null`/`undefined`/`''`/对象/数组）与 `no-seek` 上报。

## 0.3.12 - 2026-10-28 (dev)

- **修复:悬停展开会在边缘反复触发（"卡住展不开"）**。0.3.11 让收起行的歌词瞬间 `height:0`，而面板要 280ms 才长出来
  —— 胶囊总高度先跌到 26px 再涨回 233px。指针停在胶囊中段（y=30）时，那一下塌陷就把它挪到盒子外面，
  浏览器立刻派发 `mouseleave` → 收起 → 高度回升 → 指针又落回盒内 → `mouseenter` → 无限循环。
  headless Chrome 用真实 CDP 鼠标事件复现到 `expand,collapse,expand`，且 `mouseleave` 的 `clientX/clientY`
  与指针实际位置完全一致（指针没动）。
  - 收起行改为**独立 grid 轨道**（`1fr → 0fr`），与面板的 `0fr → 1fr` 同时长同缓动，因此总高度在展开时
    **单调不减**、收起时单调不增，指针不会被甩出盒子。实测 95 帧采样 0 次下陷。
  - 另外给悬停加了 260ms 迟滞：`mouseleave` 只安排收起，`mouseenter` 会取消它，指针擦边不会起振。
- 测试:客户端新增迟滞断言（离开不立即收起、延时后收起、中途重新进入可取消）与"总高度不得下陷"的 CSS 约束。

## 0.3.11 - 2026-10-28 (dev)

- **胶囊展开改为真正的过渡**。收起态只显示一行歌词，展开态显示面板，高度变化由
  `grid-template-rows: 0fr → 1fr` 承担（插值子元素固有高度，不用测量、不限行数）；胶囊同时过渡
  `max-width` / `padding` / `border-radius`。此前用的是 `max-height` 过渡 —— 它只是上限，内容比上限矮时
  一帧就到顶，观感是"啪"地弹开。
- **修复收起态被撑宽**。面板在收起时以 `width:0` 参与布局（不再 `display:none`/卸载），所以它的自然宽度
  撑不开胶囊：收起宽度重新由歌词文字决定。收起时面板带 `inert`、按钮 `disabled`，键盘与读屏不会聚焦到
  看不见的控件；`prefers-reduced-motion` 下关闭全部过渡。
- **新增播放控制**：展开面板底部增加上一首 / 播放暂停 / 下一首。宿主新增 `POST /control`
  （仅 loopback + 命令白名单），转成一行 JSON 写入 SMTC 桥 stdin，桥调用 `TryTogglePlayPauseAsync` /
  `TrySkipNextAsync` / `TrySkipPreviousAsync`，ack 按 `id` 回传。播放器不支持的能力会让按钮禁用；
  命令进行中显示 `…` 并禁止重复点击；桥的 `ok:false`（如 `no-session`）按真实拒绝处理并提示。
- **新增咪咕音乐作为第四歌词源**（顺序 `netease → qq → kugou → migu → local`）。两次请求即可：
  搜索响应自带 `lrcUrl`，该地址直接返回 UTF-8 LRC，无需签名/登录/特殊 header。实现要点：硬性过滤歌手
  （咪咕缺某歌时会返回同名别人的歌）、`duration` 按秒换算成毫秒参与打分、`copyrightId` 一律按字符串、
  清洗 BOM/CRLF、跳过缺 `lrcUrl` 的候选。刻意不用 `search_all.do` 系列端点 —— 它们没有 duration，
  时长校验会静默失效。
- 测试：新增 `/control` 路由 7 项（方法/栅栏/白名单、id 关联 ack、拒绝上报、游离 ack 忽略、桥退出释放等待者）
  与客户端 2 组（展开结构 + 过渡 CSS、播放控制的能力门控/进行中/事件冒泡）；`multisource` 增至 37 项
  并覆盖咪咕的候选过滤、版本校验与 BOM 清洗。node 侧 64 项、PowerShell 侧 15 项全过。

## 0.3.10 - 2026-10-27 (dev)

- **修复:进度停滞检测从未生效(0.3.2 起的回归)**。0.3.2 为了省一点开销把时间戳从 `DateTimeOffset`
  换成 `[Environment]::TickCount64`,但该属性在 .NET Framework(Windows PowerShell 5.1)里**不存在**,
  取值是 `$null` —— 于是「位置不变了多久」恒等于 0,`RequestAsync` 重取永远不会触发,冻结的进度再也不会自愈。
  改回 `[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()`;`Sync-TimelineSnapshot` 在时钟不可用时直接返回,
  测试额外加了一条守卫:源码(排除注释行)若再出现 `TickCount64` 直接失败。
- **酷狗没有时间线时用本地时钟推进进度**。酷狗的 SMTC 会话 `Position`/`EndTime`/`PlaybackRate` 全为 0、
  `canSeek` 为 false,重新请求也拿不到位置 —— 表现就是「识别到歌、歌词也匹配上了,但歌词停在第一句不动」。
  现在 `durSec<=0` 时由桥按「曲目身份 + 播放状态」推进一个本地时钟:换歌归零、暂停不计时、恢复从原位置继续
  (两端都在播放才计时,所以暂停/恢复最多损失一个轮询间隔);`state.json` 增加 `positionEstimated` 标明估算;
  播放器一旦给出真实时间线立即让位。代价:在酷狗里拖动进度条不会被感知,估算会走到切歌为止。
- 时间线停滞重取只在 `durSec>0` 时执行:对根本不提供时间线的播放器重取没有意义。
- `/state.json` 的 `durationSec` 在播放器不报时长时,用最后一行的歌词时间 +10s 兜底,进度条不再固定 `0:00`。
- 测试:新增 7 个本地时钟用例(推进 / 暂停 / 恢复 / 切曲复位 / 坏时钟)与 .NET Framework 时钟守卫;
  `lyric-service` 用例补上酷狗分支,node 侧 55 项、PowerShell 侧 15 项全过。

## 0.3.9 - 2026-10-26 (dev)

- **酷狗音乐**:播放状态与在线歌词。
  - 播放状态:默认 `appPatterns` 增加 `kugou`(`KuGou.exe` 的 SMTC appId 子串),与网易云/QQ 同一套
    会话选择与进度修正逻辑,无需额外配置。
  - 歌词:三段公开接口 —— `songsearch.kugou.com/song_search_v2`(搜索,`Duration` 按秒处理)
    → `krcs.kugou.com/search`(按 `FileHash` 取候选,含 `accesskey`)→ `lyrics.kugou.com/download`
    (Base64 LRC)。沿用共享的超时、请求间隔、负缓存与置信度打分(候选按曲目时长取最接近的一条)。
    来源标签为「酷狗音乐」,`service.providers` 变为 `netease/qq/kugou/local`。
- **本地歌词兜底**:三家在线源全部失败后,按歌名/歌手匹配本机文件并取词 —— 音频旁的同名 `.lrc`(优先),
  或音频内嵌标签(MP3 的 ID3v2 `USLT`/`TXXX:LYRICS`/`SYLT`;FLAC 的 `VORBIS_COMMENT`
  `LYRICS`/`UNSYNCEDLYRICS`/`SYNCEDLYRICS`)。只有纯文本没有时间戳时按曲目时长平均铺开,来源标注
  「本地文件（无时间轴）」。新增 `lib/local-lyrics.js`(零依赖标签解析 + 有界异步扫描:深度 2 /
  4000 条目 / 1.2 秒预算);配置项 `localLyrics`(默认 true)与 `localDirs`(默认 `%USERPROFILE%\Music`、
  `\Downloads`,最多 8 个)。酷狗自己的 `.krc` 是加密的(v20 已非早年 `krc1` 方案,实测解不出),
  明确不解析。
- 测试:酷狗三段落链、无候选/无时间轴回退、`.lrc` 侧车、无时间轴合成、`localLyrics=false` 跳过,
  以及 ID3v2.3 USLT / v2.4 TXXX / SYLT / FLAC VORBIS_COMMENT 的标签解析与扫描优先级(新增 10 例)。

## 0.3.8 - 2026-10-24 (dev)

- **呼吸灯三项增强**(都可在「歌词胶囊」里关掉):
  - **随歌词外扩**:每换一句歌词,最外层有一圈约 0.9s 的轻微波纹(`scale 1→1.045` + 淡出),
    只给这个 span 换 `key`(`kick:<songId>:<lineIndex>`),React 只重挂它、不会打断呼吸;暂停时不渲染。
  - **色相漂移**:新增第四层 `h4` = 中间层几何 + 静态 `hue-rotate(18deg)`,在呼吸后段(55%)淡入到 .3,
    吸气峰值后才起量,所以一口气之内颜色会偏冷/偏暖;用透明度而不是动画化 `filter`/`border-color`,
    避免每帧重算模糊。
  - **呼吸节奏**:新增 `display.v1.glowPace` 与设置项「呼吸节奏」—— 舒缓 8.4s(整体 0.8 不透明度)/
    标准 5.6s / 活跃 3.9s。周期通过 `--dnl-glow-dur` 传入,三层延迟改为周期的比例
    (0 / 5% / 7.5% / 10%),换速度时"向外接力"的比例不变;关闭呼吸灯时该项自动隐藏。

## 0.3.7 - 2026-10-24 (dev)

- **呼吸灯改为三层衰减 + 相位错开的"扩散"呼吸**:
  - 几何:贴边 2px 亮线(`inset:-2px;blur 3px`)+ 5px 中间层(`-7px;blur 9px`)+ 9px 外层泛光
    (`-16px;blur 18px`),峰值透明度分别为 .95 / .60 / .30。光从边缘向外依次减弱,
    不再是一条 12px 的粗环带;三层都是"只有边框、内部透明",不压歌词。
  - 动效:共用 5.6s 周期但相位错开 0 / .28s / .56s(外层滞后),贴边亮线先到峰值,
    中间层、外层随后亮起再收回;曲线改成「快吸、短暂停留、慢呼」;去掉 `transform: scale`。
  - 暂停播放时呼吸停止,只留一圈微弱常亮;`prefers-reduced-motion` 下改为 9s 的容器级轻呼吸。

## 0.3.6 - 2026-10-24 (dev)

- **呼吸灯改为外圈光环**:0.3.5 是填充式光晕,而胶囊背景半透明,光晕会透过胶囊染到文字上,
  且呼吸只体现为"整体亮度微变"。现在只画边框环带(`inset:-16px` + `border:12px solid` + `blur(9px)`),
  光只落在边缘外侧,内部完全透明;同时把幅度加大到 `opacity .14 → .92`(原来 `.16 → .46`)。
- 新增断言锁定几何与幅度:`.dnl-halo` 必须是 `border` 环、不得有 `background` 填充。

## 0.3.5 - 2026-10-24 (dev)

- **胶囊呼吸灯**:胶囊外圈一层约 5 秒周期的柔光,颜色可选 **跟随主题** / **跟随歌曲封面**
  (取封面主色,取色失败回退主题色)/ **关闭**;设置项在「歌词胶囊 → 呼吸灯」,偏好存 `display.v1.glow`。
  `prefers-reduced-motion` 下不呼吸。

## 0.3.4 - 2026-10-24 (dev)

- **设置页进一步归并**:按「一个模块一个折叠块」重组为三块 —— **环境悬浮歌词**(开关 / 内容 /
  颜色与文字 / 字体与字号)、**样式**(排版 / 动效)、**歌词胶囊**(颜色 / 字体 / 位置)。
  前两块默认展开,胶囊默认收起;块内用小节标题 + 虚线分隔代替二级折叠。
- 控件、`aria-label`、localStorage 键与行为不变(22 个 aria-label、3 复选框 / 6 数字 / 6 取色 / 2 文本)。

## 0.3.3 - 2026-10-24 (dev)

- **设置页分组折叠**:选项从「一屏 30 个控件」整理成 7 个可折叠分组 —— 环境悬浮歌词 / 自定义文本 /
  排版 / 动效 / 颜色与文字 / 字体与字号 / 歌词胶囊。常用三组默认展开,其余默认收起。
  长标签里的取值范围挪进控件的 `title` 提示,组内改用一行说明。
- 控件本身没有变化:22 个 `aria-label`、3 复选框 / 6 数字 / 6 取色 / 2 文本 / 5 下拉与改前一致;
  分组用原生 `<details>`,`open` 仅作初始属性。

## 0.3.2 - 2026-10-24 (dev)

- **时间线快照按需重取**:`GetTimelineProperties()` 返回的是 manager 请求那一刻的快照,长命进程不会自己变新;
  只要播放器的更新没有被推进本进程(实测:冷启动后 QQ 音乐会话注册落在推送链路未就绪的窗口里),
  位置就停在启动首采样值上,歌词定在一句、且所有 WinRT 调用都成功、不报任何错。
  现在 `Get-State` 检测到「播放中但位置连续 2.2 秒不动」时重新 `SessionManager.RequestAsync()`,
  并当轮重读时间线再发状态;暂停/停播不触发,健康状态零额外请求。
  阈值 2.2s 取自实测:QQ 音乐按 1.0s/2.05s 台阶上报,客户端本地最多外推 2s。
  `state.json` 新增 `timelineRefreshes` 计数;新增 `test/timeline-sync.test.ps1`。

## 0.3.1 - 2026-10-22 (dev)

- **首轮未匹配自动重试**:歌词 `unmatched` / `error` 后按 `retryDelayMs`(默认 15s,
  可配 5–60s)自动重试,重试前先清掉该曲目的负缓存确保真出网;每曲封顶
  `maxAutoRetries` 次(默认 2,设 0 关闭),成功、切歌或手动「重新匹配」即复位预算。
  动机:QQ 音乐 SMTC 会话可能先于在线曲库就绪,瞬时失败曾被 10 分钟负缓存钉死,
  只能手动重试。新增 `lib/lyric-retry.js`(定时器注入、独立单测 8 场景);
  `state.json` 暴露 `retry.{delayMs,maxAutoRetries,attempts,pending,pendingAttempt}`。

## 0.3.0 - 2026-10-21 (dev)

新增**环境悬浮歌词**（灵感来自 limpbus-lyrics「都市回响」）,与顶部胶囊并存、共用同一状态链路:

- **悬浮层**:歌词句随机浮现在面板左右两侧(避开中央工作区),随机位置与
  在场句子防重叠采样;`pointer-events:none` 不挡任何面板操作,暂停即冻结。
- **逐字编排**(按 limpbus-lyrics `glyph_motion.py` 的时间驱动语义逐帧移植,
  requestAnimationFrame 写内联样式,非 CSS 一次性动画):
  - 入场:每字比前一字晚 90ms 开始、各淡入 140ms,入场期阻尼颤动后汇入律动;
  - 波动:正弦行进波(逐字相位差 0.6rad);抖动:6Hz 平滑值噪声逐字颤动;
  - 波纹退场:原地逐字淡出(200ms/字);跌落退场:逐字加速下坠
    (`fall·leaving²`、±8° 旋转、350ms/字);
  - 整句渐隐:无逐字编排,整句 300ms 淡入 / 600ms 淡出 + 垂直漂移;
  - 译文与原文同一时间轴(各自语言组、同一时钟)。
- **动效样式五选一**:波纹·波动(默认) / 波纹·抖动 / 跌落·波动 / 跌落·抖动 / 整句渐隐。
- **文字样式四选一**:白芯发光(默认) / 经典纯色 / 渐变字芯(双色可调) / 卡门的声音(暖白+琥珀)。
- **颜色模式**:手动取色 / 跟随主题令牌 / 跟随专辑封面(canvas 采样主色并提升可读性,
  失败回退主题) / 预设配色(晨曦、海洋、霓虹、森林、黑白);译文可单独取色。
- **参数旋钮**:律动幅度(0–30)与跌落距离(0–128)独立可调;倾斜角度 0–25°(默认 12°)。
- **出现方向**:倾斜出现(随机角度,原版观感) / 横向正交(0°) / 竖向正立
  (`writing-mode: vertical-rl` + `text-orientation: upright`,字形正立、自上而下)。
- **同屏句数 1–4**:在场预算模型,最近 N 句同时在场,超预算时最旧的先退场;
  整句渐隐下被保留的句子不再因超过演唱时长自动透明。
- **单行显示**开关(长句不自动换行);**自定义文本**模式(每行一句、1–30 秒停留,
  暂时替代播放器歌词,无媒体会话也可显示)。
- 设置页扩展为「环境悬浮歌词 + 歌词胶囊」两区,胶囊(原版浮窗)行为不变。
- 测试:`ambient-client`(注册/偏好/边界/冻结/禁用/编排数学)与 `motion-frame`
  (帧级仿真:错峰入场/行进波/抖动/加速下坠/整句渐隐/同钟译文/退场触发/幅度缩放)
  替代原胶囊专属 UI 测试;`prefers-reduced-motion` 降级为静态。

## 0.2.0 - 2026-10-16

首个对外发布版本。相对 0.1.0 的变更:

- **多源歌词**:固定顺序 `netease → qq`。主源无可信匹配、歌词为空或无时间戳,
  以及 HTTP/超时/API 错误/无效 JSON 时自动回退 QQ;主源命中且有歌词时不请求 QQ。
  双源无词返回 `unmatched`,有请求故障返回 `error`,浮层不崩溃。
- **QQ 音乐接入**:SMTC 识别新增 `qqmusic` appId 子串;会话选择改为
  「播放中的受支持播放器 > 其他播放中会话 > 暂停的受支持播放器」。
- **匹配打分收紧**:标题分 ≥2 且总分 ≥4 才接受;时长差 >10s 一票否决;
  歌手重合加入硬过滤(同名同长不同歌手直接回退下一源)。
- **QQ 歌词解析**:Base64 + HTML 实体解码;译文按 100ms 容差就近合并,
  不跨版本拼接原文与译文。
- **歌词过渡**:约 220ms 交叉淡入淡出 + 3px 位移,尊重 `prefers-reduced-motion`;
  快速切歌只保留当前与上一层并清理过期计时器。
- **本地进度钟**:抑制重复采样与正常播放中的小幅回退,避免切句抖动;
  跳转/暂停/切歌重同步;采样停更最多外推 2 秒。
- **浮层拖动**:`⠿` 手柄拖动,位置归一化存 localStorage,展开/缩放时限制回视口内。
- **设置页**:原文/译文/当前句高亮三色与自定义字体栈(逐段 JSON 引号包裹防注入),
  各项可单独重置或一键恢复默认。
- **缓存 v2**:键含标题+时长版本;成功 7 天/负结果 10 分钟/错误 30 秒 TTL,
  上限 300 条;v1 不迁移(防旧负缓存阻断回退)。
- **诊断**:state.json 暴露 `lyric.{status,source,sourceLabel,fallbackUsed,attempts}`
  与 `service.{policy,cacheVersion,note,lastAttempts}`。

## 0.1.0

- 初始版本:SMTC 桥 + 网易云在线歌词 + 顶部胶囊浮层(收起/展开两态)。
