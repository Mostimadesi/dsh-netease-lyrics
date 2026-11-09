# dsh-netease-lyrics bridge（浏览器扩展）

MV3 扩展：把「当前正在播放的 bilibili 视频」上报给本机 dsh-netease-lyrics 插件，
让歌词胶囊自动跟随你在看的视频显示该视频的字幕（来源标注「B站字幕」）。

## 为什么需要它

系统 SMTC 只提供 App/标题/歌手/专辑，**没有 URL 或 BV 号**。插件无法从系统层面
得知浏览器在放哪个视频；本扩展是唯一可靠的 bvid 来源（方案 A，用户已拍板）。
未装扩展时插件会尝试标题反查（方案 B，后续步骤），或使用 `bilibiliBvidOverride`
配置手填一个视频。

## 安装（Chrome / Edge，加载解压缩的扩展）

1. 打开 `chrome://extensions`（Edge：`edge://extensions`）；
2. 右上角开启「开发者模式」；
3. 「加载已解压的扩展程序」→ 选择本目录（`browser-extension/`）；
4. 保持插件侧 `bilibiliEnabled` 开启（默认开）。

## 数据与隐私

- 只上报：`{ bvid, title, positionSec, durationSec, playing }`——页面元数据；
- **不访问 bilibili 接口、不读取 cookie、不包含任何登录凭证**；
- 只发往 `http://127.0.0.1:51789/dsh-netease-lyrics/browser-session`（本机），
  宿主不可达时静默失败（不影响浏览）；
- 插件侧把上报保存在内存中，15 秒无心跳即过期，不落盘。

## 端口

默认 `51789`（仅绑定 `127.0.0.1`）。若与插件配置 `browserSessionPort` 改成别的
端口，请同步修改 `background.js` 顶部的 `DEFAULT_PORT` 后在扩展页点「重新加载」。

## 触发时机

- 视频 `play` / `pause` / `seeked` / `ended` 事件（立即上报）；
- SPA 切换视频（bvid 变化，1 秒内检测）；
- **播放中与暂停中都每 5 秒心跳**（心跳不做内容去重：暂停时载荷不变，
  若被去重跳过，插件侧 10 秒新鲜度过期就会丢掉 bvid 关联，视频会被当成
  普通媒体回落音乐搜索链——字幕在暂停时消失、恢复后才重新匹配）。

## 已知边界

- 番剧页（`/bangumi/play/*`）没有 BV 号，当前不上报（ep/ss 支持留待后续）；
- 播放器在 iframe 中的嵌入式播放（站外嵌入）不在 content script 匹配范围内；
- 上报的 `positionSec`/`durationSec` 已存储但字幕对轴当前仍以 SMTC 时间线为准
  （Chrome 会为浏览器视频提供时间线）；后续步骤可用上报进度做更精确对轴。
