# PearPlayer 外链视频 Web 播放方案（HTTP + P2P 双通道）

给任意 **HTTP 外链视频 + .torrent 种子直链**（站长提供），浏览器用户打开一个播放页即可实现 **HTTP 直连 + WebRTC P2P 双通道播放**，下载完自动做种。**magnet 由后端从种子自动解析**（站长无需提供磁力）。数据全部在用户端互相分享，服务端只负责注册、解析/托管 `.torrent` 与 tracker 协调（**零视频上行**）。

基于 [PearPlayer.js](https://github.com/PearInc/PearPlayer.js)（MIT）二次开发：修复了 5 个播放器 bug，扩展了「HTTP 外链 + 种子直链」方案，并自建 Node 后端。

---

## 一、架构总览

```
                    ┌─────────────────────────────────────────────┐
                    │                浏览器（用户端）               │
                    │  ┌─────────┐   ┌────────────────────────┐   │
                    │  │ <video> │◄──┤ MSE 多源调度 (PearPlayer)│   │
                    │  └─────────┘   └──────────┬─────────────┘   │
                    │                           │                 │
        HTTP 通道 ──┼── 直连外链 CDN ◄──────────┤                 │
        P2P 通道  ──┼── WebRTC(WebTorrent) ◄────┘                 │
                    └───────────┬────────────────────────┬────────┘
                                │ 节点API/注册/托管       │ announce/peers
                    ┌───────────▼──────────┐   ┌─────────▼─────────┐
                    │  后端 Node 服务        │   │  Tracker (wt)     │
                    │  注册/API/.torrent托管 │   │  peer 发现         │
                    └───────────────────────┘   └───────────────────┘
```

- **HTTP 通道**：`<video>` 直连外链 URL（跨域直连，无需媒体代理）
- **P2P 通道**：WebTorrent（浏览器 WebRTC），走 tracker 发现 peer，用户之间互相传块
- **服务端不提供视频上行**，只提供几 KB 的 `.torrent` / magnet / 节点信息

---

## 二、快速开始（本地）

```powershell
# 1. 启动后端（HTTP 8000 + WS 8001）
cd server
$env:PEAR_FOG_COUNT='0'; node index.js
```

```powershell
# 2. 打开测试台（推荐入口）
http://127.0.0.1:8000/test.html
```

测试台已默认预填 kaltura 大文件（100MB），点「注册 → 播放」即可看到 HTTP + P2P 双通道效果。

或直接打开播放页：

```
http://127.0.0.1:8000/?url=<外链>&torrent=<.torrent种子直链>&tracker=<tracker服务器>
```

**站长只需提供 `url` + `torrent` 两个参数**，magnet 由后端从种子自动解析（无需手填）。

### 播放器参数（`?` 查询串）

| 参数 | 说明 | 必填 |
|:--|:--|:--:|
| `url` | HTTP 视频外链 | ✅ 必要 |
| `torrent` | `.torrent` 种子直链（站长提供，P2P 必需） | ⚠️ 无则**纯 HTTP** |
| `magnet` | 磁力链接（可选；后端有 torrent 时自动从种子解析，无需手填） | 可选 |
| `tracker` | tracker 服务器，**逗号分隔多地址**（API 返回的 trackers 优先） | 可选 |

---

## 三、后端 API

| 路由 | 方法 | 作用 |
|:--|:--|:--|
| `/v1/videos` | POST | 注册 `{url, magnet?, torrentUrl?, name?}`，返回 `magnetURI/torrentUrl/trackers/hasTorrent/metaSource` |
| `/v1/videos?url=` | GET | 按 url 查询（已注册直接返回） |
| `/v1/videos` | GET | 列出全部注册视频 |
| `/v1/customer/nodes` | GET | 节点 API（PearPlayer 协议）：size + HTTP 节点 + WebTorrent magnet 节点 |
| `/boot/{name}.torrent` | GET | 托管 `.torrent`（供播放器/引导页下载） |
| `/v1/stats` | POST/GET | 统计上报 / 聚合（播放页统计面板 API 驱动） |
| `/proxy/{id}` | GET | 次级方案：回源外链的 HTTP 代理（支持 Range） |
| `/rtc_config` | GET | WebRTC 配置动态下发（多 STUN/TURN，供播放器启动前拉取） |
| `/health` | GET | 健康检查（进程守护/监控用，返回已注册数） |
| `/` `/test.html` `/metadata.html` `/seed.html` | GET | 播放页 / 测试台 / metadata 引导页 / 做种页 |

### `.torrent` 引导与 magnet 解析（后端职责核心）

**站长只需提供 `url`（视频直链）+ `torrent`（.torrent 种子直链）**；后端**不下载视频**，只下载几 KB 的种子并**用代码解析出 magnet**（infoHash + 种子自带 announce）。

```
注册流程（站长提供 url + torrent 种子直链）：
POST /v1/videos {url, torrentUrl, magnet?}
  ├─ 有 magnet      → 解析磁力（infoHash 复用优先）→ metaSource: local / xs / downloadmeta
  ├─ 无 magnet 有 torrentUrl
  │                  → 下载 .torrent（几 KB）→ 代码解析出 magnet/infoHash
  │                    → 托管 torrents/ → 返回 torrentUrl（GitHub 地址）
  └─ 都无            → 纯 HTTP 注册（hasTorrent:false，播放器仅 HTTP，无 P2P）

以种子为中心：同 infoHash 已处理过 → 直接复用（无论 url 怎么变）
```

---

## 四、目录结构

```
pearplayer/
├─ server/                       # ← 后端（Node 服务）
│  ├─ index.js                   # 入口：HTTP 8000 + WS 8001 + 全部路由
│  ├─ config.js                  # 端口 / 媒体 / tracker / 节点 / PEAR_* 配置
│  ├─ video-service.js           # 视频注册（url+torrent→解析magnet / 纯HTTP）、.torrent 托管
│  ├─ tracker-swarm.js           # 真实 P2P 在线人数探针（wss tracker scrape，不污染 swarm）
│  ├─ nodes-api.js               # 节点 API（PearPlayer 协议：magnet/size）
│  ├─ http-media.js              # 媒体服务 + 回源代理 proxyRequest
│  ├─ media.js                   # 媒体路径解析（剥 {host:port} 前缀）
│  ├─ torrent-service.js         # torrent 生成与缓存（有母本时）
│  ├─ gen-torrent.js             # 命令行生成 .torrent + magnet（7 tracker：wss+udp+http）
│  ├─ start-43.sh                # 43 生产启动脚本（环境变量固化）
│  ├─ signaling.js / fog-node.js # Fog 信令（次级方案不需要）
│  ├─ metadata-node.js           # Node metadata 引导（Node↔浏览器有坑，推荐浏览器引导）
│  ├─ nginx-pear.conf            # 生产 nginx 反代示例（TLS + /tracker）
│  ├─ media/                     # 本地母本（可选，无则纯用户端）
│  ├─ torrents/                  # 托管的 .torrent（/boot/ 提供）
│  └─ public/                    # 播放器静态页
├─ src/                          # ← 播放器源码（browserify → dist/pear-player.js）
│  ├─ worker.js                  # WebTorrent 集成：magnet / .torrent 直链 + uploadspeed
│  ├─ dispatcher.js              # 多源调度 + bitfield 同步（做种关键）
│  ├─ simple-RTC.js              # WebRTC 数据通道
│  ├─ piece-validator.js         # 块校验
│  ├─ http-downloader.js         # HTTP 下载器
│  └─ ...                        # 其余播放器数据层文件
├─ index.player.js               # 播放器入口（window.PearConfig）
├─ dist/pear-player.js           # 播放器构建产物（npm run build-player）
├─ scripts/deploy.js             # 部署包同步脚本（npm run deploy → deploy/p2p_mp4）
└─ docs/principle.md             # 原理整理（最终架构定型，权威版）
```

### 前端静态页（`server/public/`）

| 页面 | 作用 |
|:--|:--|
| `index.html` | 播放页：统计面板（速度/块数本地实时渲染 + 在线人数=真实 P2P swarm）+ 自动注册/播放 |
| `test.html` | **功能测试台**：url（必要）+ torrent（站长提供，P2P 必需）输入，自动注册 / iframe 播放 |
| `metadata.html` | 浏览器端 metadata 引导（无 `.torrent` 时兜底） |
| `seed.html` | 浏览器做种页（可并入播放页） |
| `webtorrent.min.js` | WebTorrent 浏览器 bundle |

---

## 五、构建与开发

```powershell
# 重新构建播放器（改 src/*.js 后必须执行）
npm run build-player          # → dist/pear-player.js
```

后端无需构建，直接 `node index.js`。前端页面无需构建（后端静态托管）。

---

## 六、生产部署（公网）

### 实际部署拓扑（已上线）

```
用户浏览器 ──HTTPS──► https://wietrade.github.io/p2p_mp4/   （前端 GitHub Pages）
                        │ 跨域调用
                        ▼
                https://bot3.1230sb.com/p2p_mp4/           （后端 nginx 反代 → Node :8000）
                        ├── /p2p_mp4/v1/*  ──► 注册/节点/统计 API
                        ├── /p2p_mp4/boot/ ──► .torrent 托管
                        └── /tracker      ──► wt-tracker(:8083) WebSocket

视频数据流（服务端零上行）：
  HTTP 通道：用户 <video> 直连外链 CDN（如 vodcdn.sg.kaltura.com）
  P2P 通道：用户 ↔ 用户（WebRTC + tracker 协调）
```

### 部署清单

| 项 | 地址 | 说明 |
|:--|:--|:--|
| 前端（GitHub Pages） | `https://wietrade.github.io/p2p_mp4/` | 仓库 `wietrade/p2p_mp4` main 分支根，部署包在 `deploy/p2p_mp4/` |
| **种子文件（GitHub）** | `https://wietrade.github.io/p2p_mp4/torrents/` | `.torrent` 静态托管，服务器注册时远程下载解析 |
| 后端 API | `https://bot3.1230sb.com/p2p_mp4/` | nginx `location ^~ /p2p_mp4/` 反代 → `127.0.0.1:8000` |
| Tracker | `wss://bot3.1230sb.com/tracker` | wt-tracker docker :8083 |

### 部署命令

```powershell
# 前端（GitHub Pages）：同步 server/public + dist + torrents → deploy/p2p_mp4 并推送
npm run deploy
cd deploy/p2p_mp4 && git add -A && git commit -m "..." && git push origin main

# 后端（43）：scp 修改的 server 文件 → 重启（例：改动 index.js / video-service.js）
scp -i I:\1H\43.165.167.132_id_ed25519 server/index.js server/video-service.js `
  root@43.165.167.132:/www/wwwroot/bot3.1230sb.com/p2p_mp4/
ssh -i I:\1H\43.165.167.132_id_ed25519 root@43.165.167.132 '
  fuser -k 8003/tcp 2>/dev/null; sleep 1;
  cd /www/wwwroot/bot3.1230sb.com/p2p_mp4 && \
  PEAR_FOG_COUNT=0 PEAR_NO_NODES=1 PEAR_WS_PORT=8003 \
  PEAR_PUBLIC_BASE="https://bot3.1230sb.com/p2p_mp4" \
  PEAR_TORRENT_BASE="https://wietrade.github.io/p2p_mp4/torrents" \
  PEAR_SOURCE_HOST="bot3.1230sb.com" PEAR_SOURCE_PORT=443 \
  nohup node index.js > /tmp/p2p-server.log 2>&1 < /dev/null & sleep 3; tail -3 /tmp/p2p-server.log'
```

### 部署注意

1. **前端页面必须用相对路径**（`./pear-player.js`、`./?`），兼容 GitHub Pages 子目录
2. 后端启动环境变量：`PEAR_FOG_COUNT=0`（无 Fog）、`PEAR_NO_NODES=1`（零 HTTP 节点）、`PEAR_PUBLIC_BASE=https://bot3.1230sb.com/p2p_mp4`（API 公网）、`PEAR_TORRENT_BASE=https://wietrade.github.io/p2p_mp4/torrents`（种子 GitHub 地址）
3. nginx 反代用 `location ^~ /p2p_mp4/`（`^~` 避免被 `.js` 正则 location 抢走）
4. 后端 CORS：`/v1/*`、`/boot/`、媒体均已 `Access-Control-Allow-Origin: *`
5. 视频**不存服务器**：站长提供 `url` + `.torrent` 种子直链，后端只下载/托管几 KB 种子（magnet 由代码解析）；HTTP 通道用户直连外链 CDN
6. 服务端职责最小化：注册、`.torrent`、tracker；**零视频上行**
7. **多 tracker 并行**：自建 + `wss://tracker.openwebtorrent.com`（浏览器 P2P）；种子另带 `udp://` `http://` 公共 tracker（**兼容 uTorrent 等传统客户端**，它们不支持 wss）
8. **rtc_config 动态下发**：多 STUN（google/twilio/cloudflare），可选 TURN（`PEAR_TURN_URL/USER/CRED`）
9. **进程守护**：`server/start-43.sh` + systemd/pm2（`Restart=always`），健康检查 `/health`
10. 前端页面按 hostname 自适应：本地开 DataChannel，外网关（P2P 走 WebTorrent wss 信令）

---

## 七、实测验证（浏览器）

| 测试 | 视频 | 结果 |
|:--|:--|:--|
| 多用户 P2P（kaltura 外链） | 100MB | P2P 94.8%（182/192 块） |
| 次级方案（bbb + magnet） | 30MB | P2P 96.8%（60/62 块） |
| 纯用户端 P2P（无 seed 页面） | 100MB | 用户 1 做种 → 用户 2 P2P 95.8% |
| 参数全链路（url+magnet+torrent+tracker） | 100MB | P2P 97.4%（184/189 块） |
| **外网端到端（GitHub Pages + 43 后端）** | 100MB | P2P 94.9%（75/79 块），HTTP 直连 CDN（mac=vodcdn） |
| **站长方案（url + torrent 直链，magnet 代码解析）** | 100MB | P2P 97.4%（187/192 块）；无 torrent → 纯 HTTP；在线人数=真实 swarm（刷新不虚增） |

---

## 架构定型（最终方案）

**浏览器 WebRTC 互传 + CDN 兜底 + wss tracker 发现 + 种子带完整公共 tracker（兼容 uTorrent）+ 服务端零上行。**

- 不引入 Node 数据桥 / 用户贡献节点（服务器不可承受流量 / 用户无法运行 Node）
- Fog / 信令 WS 仅本地联调（外网 `useDataChannel=false`）
- 数据全在用户端流动，服务端只出 KB 级元数据
- 权威原理文档：`docs/principle.md`

---

## 八、关键修复（相对上游）

1. `ondatachannel` 的 `this` → `self`；SDP `a=mid` 提取；`windowLength` 误用
2. 硬编码后端地址 → `window.PearConfig`（worker/reporter 可配）
3. WebTorrent 0.98 默认 STUN 无效 → `tracker.rtcConfig`
4. **bitfield 同步**：HTTP 下载后同步到 `torrent.bitfield`，否则下载完不做种
5. **纯 magnet 方案**：validator 从 `torrent.torrentFile` 创建；新增 `.torrent` 直链引导（`torrentUrl`）
6. 后端 `listVideos()` 补 `hasTorrent/metaSource` 字段

### 安全与边界（2026-08-25 线上验证）

| 项 | 修复 |
|:--|:--|
| SSRF | 注册校验内网 + `/proxy` 转发前二次校验（`isPrivateHost`） |
| HTTP 状态码 | `http-downloader` `\|\|` → `&&` + Content-Range 空保护 |
| 路径穿越 | 种子 `parsed.name` → `sanitize` 去 `..` |
| 磁盘打满 | 下载大小上限 `maxDownloadBytes`（默认 2GB） |
| 末块边界 | `_calRange` 整除分支（文件为 pieceLength 整数倍） |
| 外网信令 | hostname 自适应 + `useDataChannel=false`（不再连本机 WS） |
| 统计桩 | reporter 死代码 + axios 移除 |

---

## License

MIT. 播放器部分 Copyright (c) [Pear Limited](https://pear.hk)；本方案为二次开发。
