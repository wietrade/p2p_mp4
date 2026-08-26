# PearPlayer P2P 视频播放器

**HTTP + P2P 混合加速的 HTML5 视频播放方案**

视频站长只需提供 **HTTP 视频地址** 和 **.torrent 种子链接**，播放器自动同时从 HTTP（CDN 回源）和 P2P（WebTorrent 网络）下载，用户越多 P2P 越快、带宽成本越低。

> 在线演示：<https://bot3.1230sb.com/p2p_mp4/>

---

## 特性

- 🎬 **双源混合**：HTTP（CDN 回源）+ WebRTC P2P 并行下载，共享块存储自动去重，慢的一侧不拖累快的一侧
- 🔁 **P2P 块级分享**：HTTP 下载完成的块立即标记可分享（`pieces=null` + `have` 广播），同一视频的用户之间互传
- 📊 **实时统计面板**：P2P/HTTP 速度、块数、进度、P2P 占比；**在线用户 = 真实 P2P 连接数**
- 📱 **响应式**：适配手机（2×2 卡片布局）与桌面
- 🔒 **安全加固**：SSRF 防护（视频/种子/磁力 URL）、注册单飞（single-flight）、原子写、每 IP 限流
- 🧲 **磁力自动解析**：站长给 .torrent 直链即可，后端自动解析出 infoHash / magnet
- 🛡️ **无上传架构**：服务端不下载/不存储视频，零视频上行流量

## 架构

```
┌─────────────── GitHub Pages (wietrade.github.io/p2p_mp4) ───────────────┐
│  index.html（播放器页）  pear-player.js（播放器引擎）  torrents/*.torrent  │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ 注册 /v1/videos、统计 /v1/stats（CORS 开放）
                          ┌─────────▼─────────┐
                          │  43 后端 (Node.js) │   bot3.1230sb.com/p2p_mp4
                          │  视频注册 · 种子解析 │   wss://bot3.1230sb.com/tracker
                          │  swarm 统计 · 限流  │   （自建 WebSocket Tracker）
                          └────────────────────┘
                                    │ announce（peer 发现 + WebRTC 信令）
                          ┌─────────▼─────────┐
                          │  用户浏览器（WebTorrent P2P）  │ 互相分享已下载块
                          └────────────────────┘
```

### 数据流

1. 用户打开页面 → 播放器向后端注册视频（URL + .torrent）
2. 后端返回：infoHash、magnet、.torrent 直链、wss tracker 列表
3. 播放器同时启动两路：
   - **HTTP**：Dispatcher 滑动窗口，从 CDN 直接 Range 下载
   - **P2P**：WebTorrent 加载 .torrent → 连接 tracker → 发现 swarm 里的其他用户 → 按 **rarest + 速度加权** 请求块
4. 两块存储共享（`d.store` + `d.bitfield`）：谁先下完谁赢，另一路自动跳过 → 混合传输零重复

## 站长接入（如何接入自己的视频）

只需提供视频的 **HTTP 地址** 和 **.torrent 种子链接**（P2P 必需），无需上传视频到服务器：

```
https://bot3.1230sb.com/p2p_mp4/?url=【HTTP视频地址】&torrent=【.torrent 直链】
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | ✅ | 视频 HTTP 直链（支持 Range + CORS） |
| `torrent` | ✅ | 视频对应的 .torrent 直链（启用 P2P；缺省则仅 HTTP 播放） |
| `magnet` | ❌ | 磁力链接（有 .torrent 时自动解析，可不填） |
| `tracker` | ❌ | 追加 WebSocket tracker（逗号分隔），默认自建 + 公共 wss |

**示例**（默认演示视频，也可直接访问首页无参数）：
```
https://bot3.1230sb.com/p2p_mp4/?url=https%3A%2F%2Fvodcdn.sg.kaltura.com%2F...%2Fa.mp4&torrent=https%3A%2F%2Fwietrade.github.io%2Fp2p_mp4%2Ftorrents%2Fkaltura.mp4.torrent
```

**种子要求**：
- piece 长度建议 **512KB**（与播放器分块一致，P2P 效率最高）
- 种子内可包含完整 tracker（自建 wss + 公共 wss；http/udp 仅对 Node seeder 有效，浏览器自动跳过）

## 用户使用

直接打开页面即可自动播放 + P2P 加速，无需任何操作：

- 在线演示：<https://bot3.1230sb.com/p2p_mp4/>
- GitHub Pages 版：<https://wietrade.github.io/p2p_mp4/>

## 技术栈

- **播放器**：[PearPlayer.js](https://github.com/PearInc/PearPlayer.js)（fork，MSE + 多源调度）+ [WebTorrent 0.98](https://webtorrent.io/)（浏览器 P2P，定制 store/bitfield 共享）
- **后端**：Node.js（Express 风格原生 HTTP）——视频注册、种子解析、swarm 统计、限流
- **Tracker**：wt-tracker（WebSocket tracker，Docker）——WebRTC 信令 + peer 发现
- **部署**：GitHub Pages（前端静态）+ 43 云服务器（后端 + tracker）

## 目录结构（source 分支）

```
├── src/                  # 播放器源码（worker 调度 / dispatcher / WebTorrent fork）
├── dist/pear-player.js   # 播放器构建产物
├── server/               # 后端 Node 服务 + 前端页面
│   ├── index.js          # 后端入口（/v1/videos、/v1/stats、CORS、限流）
│   ├── video-service.js  # 视频注册（SSRF 防护、单飞、tracker 过滤）
│   ├── tracker-swarm.js  # P2P 在线统计（tracker scrape）
│   └── public/           # index.html / test.html / seed.html
├── scripts/deploy.js     # 部署脚本（同步到 GitHub Pages）
└── deploy/p2p_mp4/       # 部署包（本仓库 main 分支 = GitHub Pages 站点）
```

> 本仓库 `main` 分支为 GitHub Pages 部署产物；完整源码在 `source` 分支。

## License

MIT（播放器 fork 自 [PearInc/PearPlayer.js](https://github.com/PearInc/PearPlayer.js)）
