# dsh-netease-lyrics

> **dev 分支（v0.3.0 预览）**：新增「环境悬浮歌词」。稳定版请看 [`main`](https://github.com/Mostimadesi/dsh-netease-lyrics/tree/main)。

DSH 歌词伴侣，两个浮层并存：

1. **顶部胶囊**：页面顶部居中，展示**当前播放歌曲的当前歌词句**；hover / 点击展开为封面 + 曲目信息 + 滚动歌词窗口 + 进度条；
2. **环境悬浮歌词**（v0.3.0 新增，灵感来自 [limpbus-lyrics「都市回响」](https://github.com/Celine258/idea-from-limbus-company-dancing-lyrics)）：歌词句随机浮现在面板左右两侧，轻微倾斜、逐字浮现、随播放起伏、退场淡出或加速跌落——像桌面上飘过的歌词雨。

无 SMTC 会话时整块隐藏；悬浮层 `pointer-events:none`，不遮挡任何面板操作。

播放状态取自 Windows **SMTC**（系统媒体控件）——不登录、不读 cookie、不访问账号数据，
网易云、QQ 音乐、酷狗音乐以及任何注册了 SMTC 的播放器都能作为播放来源。
歌词按「标题 + 歌手 + 时长」匹配：依次尝试网易云、QQ 音乐、酷狗的在线接口，
未匹配、无带时间歌词或请求失败就换下一个；三家都失败时再读本机的 `.lrc` 侧车文件或音频内嵌歌词。
播放器客户端都不承担歌词接口服务，不要求它们为了取词而启动。

## 前置条件

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（桥进程依赖 WinRT `Windows.Media.Control`） |
| PowerShell | Windows PowerShell 5.1（`powershell.exe`，不能用 pwsh 7；系统自带） |
| 播放器 | 任何向 SMTC 注册媒体会话的播放器 |
| 网易云桌面版 | **原生客户端不注册 SMTC 会话**（实测 75 次采样全 0）。必须装 BetterNCM + InfLink-rs 把播放状态发布到 SMTC（见 [dsh-netease-island 的方案 B 记载](https://github.com/yezisorft/dsh-netease-island)），或改用浏览器网页版播放 |
| 网络 | 宿主进程可出网到 `music.163.com` 和 `c.y.qq.com`（歌词链路） |

## 安装

```powershell
git clone https://github.com/Mostimadesi/dsh-netease-lyrics.git
git -C dsh-netease-lyrics checkout dev   # v0.3.0 预览（悬浮歌词）
dsh plugin --profile desktop add <克隆目录的绝对路径>
```

或由 DSH 插件工程会话用 `plugin_manager install_bundle` 安装。装完**重启 DeepSeek Harness**
（客户端注入表只在宿主启动时采集一次）。

## 工作方式

```
网易云(装 InfLink-rs) ──SMTC──► powershell.exe 5.1 桥(lib/smtc-bridge.ps1) ──行JSON──► 宿主半边
宿主半边(lib/index.js)：桥守护 + 歌曲指纹变化 → 搜索/匹配/拉词/缓存(lib/lyric-service.js)
  GET  /dsh-netease-lyrics/state.json   状态 + 匹配结果 + 歌词行
  GET  /dsh-netease-lyrics/cover.png    封面（按 ?v=<serial> 不可变缓存）
  POST /dsh-netease-lyrics/rematch      清掉当前曲目的匹配结论并重试（仅回环）
浏览器半边(lib/client.js)：shell.overlay 注册两个浮层（胶囊 + 悬浮层），
  单次轮询 + 进度外推，两个浮层共享同一状态
```

匹配打分：时长差（≤2s +3 / ≤5s +2 / ≤10s +1 / >10s −2）+ 标题（完全一致 +4 / 包含 +2）
+ 歌手重合（+2）；接受阈值：总分 ≥4 且标题分 ≥2。SMTC 不含歌曲 ID，错配（同名翻唱/现场版）
可能发生——展开态会显示匹配到的曲目名，可一键「重新匹配」。

缓存：`~/.dsh/dsh-netease-lyrics-cache.json`（v2，最多 300 项，记录歌曲版本、时长及歌词来源）。
成功结果保留 7 天；双源未匹配结论保留 10 分钟，请求故障保留 30 秒，切歌回来或点击重新匹配时重试。
旧 v1 缓存不会迁移，以免旧单源失败阻断新回退；升级后首次播放会重新取词。请求串行且逐请求至少间隔 800ms。

## 环境悬浮歌词（v0.3.0）

歌词句随机浮现在面板**左右两侧**（避开中央工作区）；位置随机采样并回避已在场的句子，
连续两句不会左右横跳。动画由 requestAnimationFrame 逐帧驱动（时间即动画时钟，
暂停即冻结、恢复不跳帧），编排语义移植自 limpbus-lyrics 的 `glyph_motion.py`：

- **入场**：逐字错峰——每字比前一字晚 90ms 开始、各自淡入 140ms，入场期带阻尼颤动后汇入律动；
- **波动**：正弦行进波（逐字相位差 0.6rad）；**抖动**：6Hz 平滑值噪声逐字不规则颤动；
- **波纹退场**：原地逐字淡出（200ms/字）；**跌落退场**：逐字加速下坠（`fall·leaving²`、±8° 旋转、350ms/字）；
- **整句渐隐**：无逐字编排，整句 300ms 淡入 / 600ms 淡出 + 垂直漂移；
- **译文与原文同一时间轴**：各自作为独立语言组、共用同一时钟，入场/律动/退场完全同步。

插件详情页（设置 → 插件 → dsh-netease-lyrics）「环境悬浮歌词」区可配置：

| 设置 | 说明 |
| --- | --- |
| 启用开关 | 总开关（默认开） |
| 自定义文本 | 每行一句（最多 30 句）+ 每句停留 1–30 秒；开启后替代播放器歌词，无媒体会话也可显示 |
| 出现方向 | 倾斜出现（随机角度，默认）/ 横向正交（0°）/ 竖向正立（字形正立、自上而下） |
| 倾斜角度 | 0–25°（默认 12°），仅「倾斜出现」生效 |
| 同屏句数 | 1–4（默认 2）；最近 N 句同时在场，超预算时最旧的先退场 |
| 单行显示 | 长句不自动换行（可能横跨窗口中部），默认关闭保持防遮挡折叠 |
| 动效样式 | 波纹·波动（默认）/ 波纹·抖动 / 跌落·波动 / 跌落·抖动 / 整句渐隐 |
| 律动幅度 | 0–30（默认 10），驱动波动/抖动振幅；与跌落距离互不影响 |
| 跌落距离 | 0–128（默认 48px@32px 字号），仅「跌落」类动效的退场下坠距离 |
| 文字样式 | 白芯发光（默认）/ 经典纯色 / 渐变字芯（双色可调）/ 卡门的声音（暖白+琥珀） |
| 文字颜色模式 | 手动取色 / 跟随主题 / 跟随专辑封面（采样主色并自动提升可读性，失败回退主题）/ 预设配色（晨曦、海洋、霓虹、森林、黑白） |
| 译文颜色 | 翻译行独立取色（留空跟随原文颜色） |
| 字号 / 字体 | 12–32px（默认 18）；本机字体名，逗号分隔，留空跟随胶囊字体 |

设置保存在当前浏览器 localStorage，浏览器间不共享；`prefers-reduced-motion` 下动画降级为静态显示。

## 字体颜色与双语显示（胶囊）

收起态显示原文及其下方的译文小字；没有译文时保持单行。展开态也显示译文。
译文来自所选歌词源已有的译文数据，需启用 `showTranslation`，本 bundle 已默认开启。

胶囊的原文、译文、当前句高亮颜色与「歌词字体」在插件详情页配置（与悬浮歌词相互独立）。
选色后立即生效，保存在当前浏览器的本地存储中；默认颜色跟随明暗主题。

胶囊外圈有呼吸灯，由四层叠加而成：贴边的 **2px 亮线** + **5px 中间层** + **9px 外层泛光**
+ 一层**色相漂移层**。光从胶囊边缘向外依次减弱，是柔和过渡而不是一条粗环带；
胶囊内部始终透明，不会压住歌词。

动效分三部分：

- **呼吸本体**：快吸（0→26%）、短暂停留、慢呼的不对称曲线；三层相位递增（0 / 5% / 10% 周期），
  贴边亮线先亮、中间层与外层随后亮起，视觉上是光在向外扩散再收回，而不是整圈一起闪。
- **色相漂移**：第四层是中间层的 `hue-rotate(18deg)` 副本，在呼吸后段淡入，
  所以一口气之内颜色会略微偏冷/偏暖，不会一直是同一个纯色。
- **随歌词的一次外扩**：每换一句歌词，最外层有一圈约 0.9 秒的轻微外扩波纹（remount 重播），
  暂停时不再出现。

暂停播放时呼吸停下，只留一圈微弱常亮（与冻结的歌词一致）。
设置页「歌词胶囊 → 呼吸灯」可选 **跟随主题**（默认，取主题强调色）、
**跟随歌曲封面**（取封面主色，取色失败或无封面时回退主题强调色）或 **关闭**；
「呼吸节奏」可选 **舒缓（8.4 秒，更淡）/ 标准（5.6 秒）/ 活跃（3.9 秒）**，关闭呼吸灯时该项隐藏。
`prefers-reduced-motion` 下改为 9 秒的纯透明度轻呼吸，并停用色相漂移与外扩波纹。

浮层默认位于顶部偏右（视口宽度的 70%）。按住浮层左侧的 `⠿` 手柄拖动，松开后
自动保存位置；拖动不会触发胶囊的固定展开切换。展开、窗口缩放时会将浮层限制在视口内。
设置页的「重置浮层位置」按钮恢复默认位置。

播放进度会忽略重复采样及正常播放中的小幅回退，避免下一句与当前句来回切换。
切歌、明显的进度跳转和暂停仍会重新同步；连续读数停止更新时，本地最多外推 2 秒。
bridge 侧另有兜底：播放中位置连续 2.2 秒不动时重新请求 SMTC manager 并当轮重读时间线
（暂停不触发、健康时零额外请求），`state.json` 的 `timelineRefreshes` 记录触发次数。
很小的向后拖动（约 1.5 秒以内）可能被当作采样抖动抑制。

## QQ 音乐接入（SMTC 基础适配）

QQ 音乐作为当前播放来源已加入默认识别（`qqmusic` appId 子串）。
优先选择正在播放的受支持播放器，再回退到其他播放中会话，最后才选择暂停会话；
同时播放两个受支持播放器时，以系统枚举顺序中的首个播放中会话为准。

[旧 QQMusicSMTC 项目](https://github.com/FoskyM/QQMusicSMTC)注明 QQ 音乐从
`20.22.2692.0613` 起内置 SMTC。建议先用新版 QQ 原生会话验证，无需先注入 DLL。
[QQMusic-ID-Injector](https://github.com/apoint123/QQMusic-ID-Injector) 是 InfLink-rs 作者的项目，
用于在 SMTC 的流派字段附加 `QQ-{ID}`；本版不依赖该扩展，也没有安装或改写 QQ 客户端。

本版支持 QQ 播放状态及 QQ 在线歌词作为后备来源。仍按歌名、歌手和时长匹配，
尚未读取扩展插件的 QQ 歌曲 ID；不同录音版本仍可能无词或错配。验证时暂停网易云、在 QQ 播放一首歌，
检查 `state.json` 的 `app`、`title`、`playing` 和 `lyric.status`。
宿主及桥代码更新后需重启 DSH 才能确保载入新版本。尚需本机 QQ 实播验收。

## 酷狗音乐接入（SMTC 与歌词）

酷狗音乐（Windows 客户端 `KuGou.exe`）会注册系统 SMTC 会话，标题、歌手与播放/暂停状态
无需插件、无需登录即可读取；默认 `appPatterns` 已包含 `kugou`，安装即生效。
歌词走酷狗的三段公开接口：`songsearch.kugou.com/song_search_v2` 搜索（按歌名、歌手、时长匹配）
→ `krcs.kugou.com/search` 用文件 hash 取歌词候选 → `lyrics.kugou.com/download` 取 Base64 LRC。
三步都校验 `status`，沿用与网易云 / QQ 相同的超时、请求间隔与负缓存策略。

**进度是估算的**：酷狗的 SMTC 会话不提供时间线——`Position`、`EndTime`、`PlaybackRate`
全为 0，`canSeek` 为 false，重新请求也拿不到位置。所以插件按「曲目身份 + 播放状态」自己推进一个
本地时钟：换歌归零、暂停不计时、恢复从原位置继续。`state.json` 的 `positionEstimated` 会标为 `true`，
`durationSec` 在播放器不报时长时用最后一行歌词时间 +10 秒兜底。代价是：**在酷狗里拖动进度条不会被感知**，
估算会一直走到切歌为止（想立刻对齐就暂停再继续，或切一首再切回来）。

注意：酷狗桌面端自己的 `.krc` 歌词文件是加密的（v20 已不是早年 `krc1` 的 XOR+deflate 方案，
实测无法解出），插件不读取也不解析它，只从上面的在线接口取普通 LRC。

## 多歌词源与失败回退

固定顺序为 `netease → qq → kugou → local`。网易云搜索无可信匹配、取回歌词为空或没有时间戳，
以及 HTTP、超时、API 错误和无效 JSON 都会进入下一个源；前一个源命中且有歌词时不请求后续源。
所有在线源都失败时，最后从本机离线文件取词（见下节）。
全部失败返回 `unmatched`；其中有请求故障则返回 `error` 并保留各自原因，浮层不崩溃。
QQ Base64 歌词与 HTML 实体会先解码，译文按 100ms 容差合并。不会把不同歌曲的原文和译文拼接。
主源已有原文但无译文时继续使用主源，不为了补译文切换录音版本。

展开浮层会显示「网易云歌词」「QQ 音乐歌词」「酷狗音乐歌词」或「本地文件歌词」。
状态接口的 `lyric.source`、`lyric.fallbackUsed`、`lyric.attempts` 分别表示实际来源、是否使用后备源
和每个来源的尝试结果（含 `local` 一条）。`service.policy` 应为 `netease > qq > kugou > local-file`，
`service.local` 会列出本地搜索目录与是否启用。

## 本地歌词兜底（离线）

三家在线源都失败时，按歌名 / 歌手匹配本机文件，再按以下优先级取词：

1. 音频文件旁的 **同名 `.lrc`**（`Adele - Hello.mp3` → `Adele - Hello.lrc`）；
2. 音频文件**内嵌标签**：MP3 的 ID3v2 `USLT` / `TXXX:LYRICS` / `SYLT`，FLAC 的
   `VORBIS_COMMENT` 里的 `LYRICS` / `UNSYNCEDLYRICS` / `SYNCEDLYRICS`；
3. 只有普通文本没有时间戳时，按曲目时长**平均铺开**并在来源里标注「（无时间轴）」，
   不会伪装成精确同步。

搜索范围默认 `%USERPROFILE%\Music` 与 `%USERPROFILE%\Downloads`，可用 `localDirs` 覆盖；
扫描是异步有界的（深度 2、最多 4000 个条目、1.2 秒预算），只在三家在线源都失败后触发一次，
命中结果照常走 7 天缓存。开关为 `localLyrics`（默认 `true`，设 `false` 完全不扫盘）。
`.krc`、`.m4a` 的 `©lyr`、APE/WMA 标签暂不支持。

## 歌词过渡（胶囊）

收起态原文与译文作为一组进行约 220 毫秒交叉淡入淡出，伴随 3px 轻微位移；
展开态歌词窗口采用同样的过渡。动画仅在歌词句或曲目变化时触发，普通采样不重播。
快速切歌只保留当前与上一层，并清理过期计时器；系统开启“减少动态效果”时直接切句。

## 配置

在 profile 的 `cordis.patch.yml` 里给该条目加 `config`（不写用默认值）：

```yaml
- id: dsh-netease-lyrics
  name: dsh-netease-lyrics
  config:
    pollMs: 500            # 轮询间隔（毫秒），钳制 200 ~ 5000
    appPatterns:           # SMTC appId 子串匹配（仅 ASCII；留空回退默认）
      - cloudmusic
      - netease
      - com.netease
      - qqmusic
      - kugou
    apiBase: 'https://music.163.com'   # 可指向自建 NeteaseCloudMusicApi 实例
    showTranslation: false  # 歌词译文（原文下方小字）
    retryDelayMs: 15000    # 首轮未匹配后的自动重试间隔（毫秒，钳制 5000 ~ 60000）
    maxAutoRetries: 2      # 每曲自动重试上限（0 关闭；成功/切歌/手动重匹配即复位）
    localLyrics: true      # 三家在线源都失败后，读歌曲旁 .lrc / 内嵌歌词
    localDirs:             # 本地歌词搜索目录（默认 Music 与 Downloads，最多 8 个）
      - 'D:\Music'
```

### 首轮未匹配自动重试

QQ 音乐的 SMTC 会话可能先于在线曲库就绪，瞬时失败此前会被 10 分钟负缓存钉死，
只能手动重试。现在首轮 `unmatched` / `error` 后按 `retryDelayMs` 自动重试
（默认 15 秒，重试前自动清掉该曲目的负缓存，确保真出网），每曲封顶
`maxAutoRetries` 次；匹配成功、切歌或手动「重新匹配」都会复位重试预算。
`state.json` 的 `retry` 字段（`attempts` / `pending` / `pendingAttempt`）可观测当前状态。

## 故障排查

1. **重启 DSH 了吗** —— 没重启客户端半边不会加载。
2. `http://127.0.0.1:19387/dsh-netease-lyrics/state.json`：
   - `bridge` 字段：`down`/`starting`/`up`/`fatal`，`detail` 带原因；
   - `matched`（顶层，SMTC appId 是否命中 appPatterns）为 `false` 说明放歌的播放器不在匹配范围；
   - `sessionCount` 一直 0 且音乐在放 → 播放器没注册 SMTC（网易云桌面版见前置条件）；
   - `lyric.status`：`matched` / `unmatched` / `error`，`service.note` 带接口侧原因。
3. 浮层不出现但 `state.json` 正常 → 看浏览器控制台有无 `dsh-netease-lyrics` 相关报错，
   以及 `~/.dsh/dsh-netease-lyrics-boot.log`。
4. 悬浮歌词不显示 → 确认插件详情页「启用环境悬浮歌词」已勾选；歌词源为
   `unmatched`/`error`（纯音乐等）时悬浮层不渲染；自定义文本模式需填入非空文本。

## 已知边界

- 网易云及 QQ 搜索/歌词均为未公开接口，无稳定性保证；`apiBase` 仅影响网易云路径。
- VIP / 无版权歌曲可能拉不到歌词（胶囊显示未匹配，悬浮层不渲染）。
- 仅 Windows；网易云桌面版依赖 BetterNCM + InfLink-rs（第三方注入，客户端升级可能失效）。
- 若与 dsh-netease-island 同装，顶部会出现两个胶囊（overlay 为 list 槽，可共存但视觉重复）。
- 「跟随专辑封面」颜色模式依赖封面路由与浏览器 canvas；封面为单色块时取色即为该单色，
  观感可能偏淡。竖向正立时长句自动向左续列。
- 悬浮歌词的编排参数（入场节奏、退场窗口）为固定值，仅幅度/距离/角度可调。

## 开发与测试

零 npm 依赖,Node.js ≥ 18 即可跑测试:

```powershell
npm test              # 4 个 node 测试:双源回退矩阵 / LRC 解析 / 客户端(双浮层注册+偏好) / 帧级编排仿真
npm run test:bridge   # PS5.1 会话选择 6 场景(需 Windows PowerShell 5.1)
npm run check         # 三个 JS 文件语法检查
```

`test/live-qq-fallback.mjs` 访问真实 QQ 在线接口,仅手动运行,不进 CI;
推送到 GitHub 后 `.github/workflows/ci.yml` 会在 windows-latest 上自动跑上述全部检查。

## 来源与许可

- `lib/smtc-bridge.ps1` 基于 [dsh-netease-island](https://github.com/yezisorft/dsh-netease-island)（MIT），
  本插件增加 QQ 匹配和播放优先的会话选择逻辑；
  宿主半边的进程守护与信任栅栏模式亦参考该项目。
- 环境悬浮歌词的动效编排参考 [limpbus-lyrics「都市回响」](https://github.com/Celine258/idea-from-limbus-company-dancing-lyrics)
  的 `glyph_motion.py` 时间驱动语义（逐字错峰入场、行进波/噪声抖动、加速跌落退场），
  为浏览器 rAF 独立实现，不引入该项目依赖。
- 其余代码按 MIT 发布。

QQ 请求字段参考 [QQMusicApi search](https://github.com/jsososo/QQMusicApi/blob/master/routes/search.js) 和 [lyric](https://github.com/jsososo/QQMusicApi/blob/master/routes/lyric.js)，本插件为独立实现，不引入该项目依赖。
