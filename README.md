# dsh-netease-lyrics

DSH 顶部歌词浮层：在页面顶部居中显示一个胶囊，展示**当前播放歌曲的当前歌词句**；
hover / 点击展开为封面 + 曲目信息 + 滚动歌词窗口 + 进度条。无 SMTC 会话时整块隐藏。

播放状态取自 Windows **SMTC**（系统媒体控件）——不登录、不读 cookie、不访问账号数据。
歌词按「标题 + 歌手 + 时长」匹配：优先请求网易云在线接口，未匹配、无带时间歌词或请求失败后，再请求 QQ 在线接口。两个桌面客户端都不承担歌词接口服务，不要求它们为了取词而启动。

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
浏览器半边(lib/client.js)：shell.overlay 注册浮层，轮询 + 进度外推 + 当前句渲染
```

匹配打分：时长差（≤2s +3 / ≤5s +2 / ≤10s +1 / >10s −2）+ 标题（完全一致 +4 / 包含 +2）
+ 歌手重合（+2）；接受阈值：总分 ≥4 且标题分 ≥2。SMTC 不含歌曲 ID，错配（同名翻唱/现场版）
可能发生——展开态会显示匹配到的曲目名，可一键「重新匹配」。

缓存：`~/.dsh/dsh-netease-lyrics-cache.json`（v2，最多 300 项，记录歌曲版本、时长及歌词来源）。
成功结果保留 7 天；双源未匹配结论保留 10 分钟，请求故障保留 30 秒，切歌回来或点击重新匹配时重试。
旧 v1 缓存不会迁移，以免旧单源失败阻断新回退；升级后首次播放会重新取词。请求串行且逐请求至少间隔 800ms。

## 字体颜色与双语显示

收起态显示原文及其下方的译文小字；没有译文时保持单行。展开态也显示译文。
译文来自所选歌词源已有的译文数据，需启用 `showTranslation`，本 bundle 已默认开启。

进入「设置 → 插件 → dsh-netease-lyrics」的插件详情页，可以分别配置原文、译文、
当前句高亮颜色。选色后立即生效，并保存在当前浏览器的本地存储中；不同浏览器不共享。
各项可单独恢复默认，也可一键恢复全部主题默认。默认颜色跟随明暗主题，
自定义颜色在两种主题下保持所选值。

同一设置页提供「歌词字体」输入框，可填写本机已安装字体的名称，用逗号分隔后备字体，
例如 `Microsoft YaHei, Noto Sans CJK SC`。留空或点击「恢复默认字体」跟随 DSH 字体；
该设置同时用于收起与展开态的原文和译文，不安装或下载字体文件。

浮层默认位于顶部偏右（视口宽度的 70%）。按住浮层左侧的 `⠿` 手柄拖动，松开后
自动保存位置；拖动不会触发胶囊的固定展开切换。展开、窗口缩放时会将浮层限制在视口内。
设置页的「重置浮层位置」按钮恢复默认位置。位置与字体均保存在当前浏览器本地存储中。

播放进度会忽略重复采样及正常播放中的小幅回退，避免下一句与当前句来回切换。
切歌、明显的进度跳转和暂停仍会重新同步；连续读数停止更新时，本地最多外推 2 秒。
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

## 多歌词源与失败回退

固定顺序为 `netease → qq`。网易云搜索无可信匹配、取回歌词为空或没有时间戳，
以及 HTTP、超时、API 错误和无效 JSON 都会进入 QQ 分支；主源命中且有歌词时不请求 QQ。
两个源都无词返回 `unmatched`；其中有请求故障则返回 `error` 并保留各自原因，浮层不崩溃。
QQ Base64 歌词与 HTML 实体会先解码，译文按 100ms 容差合并。不会把不同歌曲的原文和译文拼接。
主源已有原文但无译文时继续使用主源，不为了补译文切换录音版本。

展开浮层会显示「网易云歌词」或「QQ 音乐歌词」。状态接口的 `lyric.source`、
`lyric.fallbackUsed`、`lyric.attempts` 分别表示实际来源、是否使用后备源和每个来源的尝试结果。
`service.policy` 应为 `netease-first-qq-fallback`，`service.cacheVersion` 应为 `2`，
可据此判断宿主是否载入本版。升级宿主后需完整重启 DSH；不会自动重启或改装播放器。

## 歌词过渡

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
    apiBase: 'https://music.163.com'   # 可指向自建 NeteaseCloudMusicApi 实例
    showTranslation: false  # 歌词译文（原文下方小字）
```

## 故障排查

1. **重启 DSH 了吗** —— 没重启客户端半边不会加载。
2. `http://127.0.0.1:19387/dsh-netease-lyrics/state.json`：
   - `bridge` 字段：`down`/`starting`/`up`/`fatal`，`detail` 带原因；
   - `matched`（顶层，SMTC appId 是否命中 appPatterns）为 `false` 说明放歌的播放器不在匹配范围；
   - `sessionCount` 一直 0 且音乐在放 → 播放器没注册 SMTC（网易云桌面版见前置条件）；
   - `lyric.status`：`matched` / `unmatched` / `error`，`service.note` 带接口侧原因。
3. 浮层不出现但 `state.json` 正常 → 看浏览器控制台有无 `dsh-netease-lyrics` 相关报错，
   以及 `~/.dsh/dsh-netease-lyrics-boot.log`。

## 已知边界

- 网易云及 QQ 搜索/歌词均为未公开接口，无稳定性保证；`apiBase` 仅影响网易云路径。
- VIP / 无版权歌曲可能拉不到歌词（会显示未匹配）。
- 仅 Windows；网易云桌面版依赖 BetterNCM + InfLink-rs（第三方注入，客户端升级可能失效）。
- 若与 dsh-netease-island 同装，顶部会出现两个浮层（overlay 为 list 槽，可共存但视觉重复）。

## 开发与测试

零 npm 依赖,Node.js ≥ 18 即可跑测试:

```powershell
npm test              # 6 个 node 测试:双源回退矩阵 / LRC 解析 / UI / 进度钟 / 拖动 / 过渡
npm run test:bridge   # PS5.1 会话选择 6 场景(需 Windows PowerShell 5.1)
npm run check         # 三个 JS 文件语法检查
```

`test/live-qq-fallback.mjs` 访问真实 QQ 在线接口,仅手动运行,不进 CI;
推送到 GitHub 后 `.github/workflows/ci.yml` 会在 windows-latest 上自动跑上述全部检查。

## 来源与许可

- `lib/smtc-bridge.ps1` 基于 [dsh-netease-island](https://github.com/yezisorft/dsh-netease-island)（MIT），
  本插件增加 QQ 匹配和播放优先的会话选择逻辑；
  宿主半边的进程守护与信任栅栏模式亦参考该项目。
- 其余代码按 MIT 发布。

QQ 请求字段参考 [QQMusicApi search](https://github.com/jsososo/QQMusicApi/blob/master/routes/search.js) 和 [lyric](https://github.com/jsososo/QQMusicApi/blob/master/routes/lyric.js)，本插件为独立实现，不引入该项目依赖。
