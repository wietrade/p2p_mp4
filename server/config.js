/**
 * 后端配置
 * 所有值均按播放器源码（src/worker.js / src/dispatcher.js / src/piece-validator.js）确认的协议填写
 */
const path = require('path')

// 完整 announce（种子/magnet 生成用）：
//  - wss://  给 WebTorrent（浏览器/Node P2P）
//  - udp/http 给传统 BT 客户端（uTorrent/qBittorrent 等，它们不支持 wss://）
const SEED_ANNOUNCE = [
  'wss://bot3.1230sb.com/tracker',
  'wss://tracker.openwebtorrent.com',
  'udp://tracker.opentrackr.org:1337/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://exodus.desync.com:6969/announce'
]

module.exports = {
  // HTTP 服务端口（媒体文件 + 节点 API + torrent + 播放器页面）
  httpPort: Number(process.env.PEAR_HTTP_PORT || 8000),

  // WebSocket 信令服务器端口
  wsPort: Number(process.env.PEAR_WS_PORT || 8001),

  // 媒体文件根目录
  mediaRoot: path.join(__dirname, 'media'),

  // 源服务器信息（即播放器 video.src 里的 host:port）
  // 注意：必须与页面加载时使用的 host:port 一致，否则节点 uri 拼接会错
  sourceHost: process.env.PEAR_SOURCE_HOST || '127.0.0.1',
  sourcePort: Number(process.env.PEAR_SOURCE_PORT || 8000),
  // 带端口的 host，如 "127.0.0.1:8000"（url.parse(src).host 的形态）
  get sourceHostWithPort() {
    return this.sourceHost + ':' + this.sourcePort
  },

  // 节点列表（模拟 CDN 多源）。
  // 协议要求：worker.js 用 isLocationHTTP 决定 http/https，用 http_port/https_port 拼端口，
  // 节点 uri = protocol://host:port/{视频host}{视频path}
  // PEAR_NO_NODES=1 时返回空数组（外网部署：HTTP 源由播放页 video.src=/proxy/{id} 提供，避免不可达节点）
  nodes: process.env.PEAR_NO_NODES === '1' ? [] : [
    {
      protocol: 'http',
      host: process.env.PEAR_NODE_HOST || '127.0.0.1',
      http_port: Number(process.env.PEAR_NODE_PORT || 8000),
      https_port: 0,
      type: 'node',
      capacity: 100
    }
  ],

  // 公网对外基础地址（供生成 .torrent / boot 直链）。
  // 外网部署时填 https://bot3.1230sb.com/p2p_mp4；为空则用 sourceHost:sourcePort 拼 http://...
  publicBase: process.env.PEAR_PUBLIC_BASE || '',

  // 种子文件公网基础地址（GitHub Pages 静态托管，模拟远程下载源）。
  // 填如 https://wietrade.github.io/p2p_mp4/torrents；为空则用 publicBase/boot（服务器托管兜底）
  torrentPublicBase: process.env.PEAR_TORRENT_BASE || '',

  // 客户端需携带的 X-Pear-Token（token 校验由各 API 决定，这里留空表示不校验）
  token: '',

  // torrent pieceLength：必须 == 播放器 Dispatcher 的 chunkSize（默认 512*1024）
  // 播放器 piece-validator 用 floor(start/pieceLength) 定位 index，错位会导致全部校验失败
  pieceLength: 512 * 1024,

  // 是否把播放器测试页也由本服务托管（true 时 GET / 返回 public/index.html）
  servePlayerPage: true,

  // 每个媒体文件启动几个 Fog 节点（服务端 WebRTC DataChannel）
  fogCountPerMedia: Number(process.env.PEAR_FOG_COUNT || 2),

  // 最佳方案（服务端下载生成种子）单文件大小上限，防止恶意注册打满磁盘
  maxDownloadBytes: Number(process.env.PEAR_MAX_DOWNLOAD_BYTES || 2 * 1024 * 1024 * 1024),

  // 模拟慢 CDN：HTTP 媒体响应延迟毫秒数（>0 时 DataChannel 能抢在 HTTP 前下载，便于验证 fog 下载）
  httpMediaDelayMs: Number(process.env.PEAR_HTTP_DELAY_MS || 0),

  // WebTorrent 浏览器 P2P：测试视频的 magnetURI（由 gen-torrent.js 生成，含全部 tracker）
  // kaltura.mp4 100MB（NIE 公开测试视频）
  magnetURI:
    process.env.PEAR_MAGNET_URI ||
    'magnet:?xt=urn:btih:ef9cfc0fa65744edf4cd6cd3256cf805b86c7822&dn=kaltura.mp4' +
      SEED_ANNOUNCE.map(function (t) { return '&tr=' + encodeURIComponent(t) }).join(''),
  // WebTorrent announce（浏览器 P2P 用，wss only）：自建 tracker 优先 + 公共 wss 并行
  webTorrentTrackers: [
    'wss://bot3.1230sb.com/tracker',
    'wss://tracker.openwebtorrent.com'
  ],
  // 种子/magnet 生成用的完整 tracker 列表（含传统 udp/http，供 uTorrent 等使用）
  seedAnnounce: SEED_ANNOUNCE,

  // WebRTC rtcConfig（前端 /rtc_config 动态下发，模仿 instant.io /__rtcConfig__）
  // 多公共 STUN 提高 NAT 打洞成功率；如需 TURN 设 PEAR_TURN_URL / PEAR_TURN_USER / PEAR_TURN_CRED
  rtcConfig: (() => {
    const iceServers = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478', 'stun:stun.cloudflare.com:3478'] }
    ]
    if (process.env.PEAR_TURN_URL) {
      iceServers.push({
        urls: process.env.PEAR_TURN_URL.split(','),
        username: process.env.PEAR_TURN_USER || '',
        credential: process.env.PEAR_TURN_CRED || ''
      })
    }
    return { iceServers }
  })(),

  // 外链媒体映射：key = `{视频host}{视频path}`（播放器 urlObj.host + urlObj.path，无协议）
  // value.localFile = mediaRoot 下的本地副本（用于 seed/torrent/校验），remoteUrl = 完整外链
  // 播放器把外链当 video.src → 节点 API 识别映射 → 节点指向本地 → http-media 回源转发外链
  remoteMedia: {
    'vodcdn.sg.kaltura.com/p/117/sp/11700/serveFlavor/entryId/0_9311zvk2/v/2/ev/2/flavorId/0_xdkx0iet/name/a.mp4': {
      localFile: 'kaltura.mp4',
      remoteUrl:
        'https://vodcdn.sg.kaltura.com/p/117/sp/11700/serveFlavor/entryId/0_9311zvk2/v/2/ev/2/flavorId/0_xdkx0iet/name/a.mp4'
    }
  }
}
