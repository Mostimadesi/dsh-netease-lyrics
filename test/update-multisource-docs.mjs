import fs from 'node:fs';
const p=new URL('../README.md',import.meta.url);let s=fs.readFileSync(p,'utf8');
function replace(a,b){if(!s.includes(a))throw Error('Missing README anchor');s=s.replace(a,b);}
replace('歌词通过网易云公开搜索接口按「标题 + 歌手 + 时长」匹配后拉取（无需登录）。','歌词按「标题 + 歌手 + 时长」匹配：优先请求网易云在线接口，未匹配、无带时间歌词或请求失败后，再请求 QQ 在线接口。两个桌面客户端都不承担歌词接口服务，不要求它们为了取词而启动。');
replace('| 网络 | 宿主进程可出网到 `music.163.com`（仅歌词链路） |','| 网络 | 宿主进程可出网到 `music.163.com` 和 `c.y.qq.com`（歌词链路） |');
replace('缓存：`~/.dsh/dsh-netease-lyrics-cache.json`（匹配结果持久化；未匹配结论 10 分钟内不重试，\n防止轮询打死接口）。请求全局串行 + 最小间隔 800ms。','缓存：`~/.dsh/dsh-netease-lyrics-cache.json`（v2，最多 300 项，记录歌曲版本、时长及歌词来源）。\n成功结果保留 7 天；双源未匹配结论保留 10 分钟，请求故障保留 30 秒，切歌回来或点击重新匹配时重试。\n旧 v1 缓存不会迁移，以免旧单源失败阻断新回退；升级后首次播放会重新取词。请求串行且逐请求至少间隔 800ms。');
replace('译文来自网易云已有歌词数据','译文来自所选歌词源已有的译文数据');
replace('本版仅适配 QQ 播放状态，歌词仍通过网易云按歌名、歌手和时长匹配，不是 QQ 原生歌词源。\nQQ 独占歌曲或版本不一致的曲目可能无歌词或错配。验证时暂停网易云、在 QQ 播放一首歌，','本版支持 QQ 播放状态及 QQ 在线歌词作为后备来源。仍按歌名、歌手和时长匹配，\n尚未读取扩展插件的 QQ 歌曲 ID；不同录音版本仍可能无词或错配。验证时暂停网易云、在 QQ 播放一首歌，');
replace('## 歌词过渡','## 多歌词源与失败回退\n\n固定顺序为 `netease → qq`。网易云搜索无可信匹配、取回歌词为空或没有时间戳，\n以及 HTTP、超时、API 错误和无效 JSON 都会进入 QQ 分支；主源命中且有歌词时不请求 QQ。\n两个源都无词返回 `unmatched`；其中有请求故障则返回 `error` 并保留各自原因，浮层不崩溃。\nQQ Base64 歌词与 HTML 实体会先解码，译文按 100ms 容差合并。不会把不同歌曲的原文和译文拼接。\n主源已有原文但无译文时继续使用主源，不为了补译文切换录音版本。\n\n展开浮层会显示「网易云歌词」或「QQ 音乐歌词」。状态接口的 `lyric.source`、\n`lyric.fallbackUsed`、`lyric.attempts` 分别表示实际来源、是否使用后备源和每个来源的尝试结果。\n`service.policy` 应为 `netease-first-qq-fallback`，`service.cacheVersion` 应为 `2`，\n可据此判断宿主是否载入本版。升级宿主后需完整重启 DSH；不会自动重启或改装播放器。\n\n## 歌词过渡');
replace('- 网易云搜索/歌词为未公开接口，无稳定性保证；风控时可切 `apiBase` 到自建实例。','- 网易云及 QQ 搜索/歌词均为未公开接口，无稳定性保证；`apiBase` 仅影响网易云路径。');
s += '\nQQ 请求字段参考 [QQMusicApi search](https://github.com/jsososo/QQMusicApi/blob/master/routes/search.js) 和 [lyric](https://github.com/jsososo/QQMusicApi/blob/master/routes/lyric.js)，本插件为独立实现，不引入该项目依赖。\n';
fs.writeFileSync(p,s);
