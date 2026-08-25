/**
 * metadata 引导节点（轻量做种：只提供 piece 哈希/metadata，不做视频数据上行）
 *
 * 作用：让"纯 magnet"方案成立。
 *  - 后端生成 .torrent（含 piece 哈希）→ 本节点用 .torrent 加载 → 持有 metadata
 *  - 在 tracker 上 announce → 播放器 add(magnet) 时通过 BEP9 metadata 交换拿到 piece 哈希
 *  - 不 select 数据 → 不承担任何视频上行（数据仍走外链/用户间 P2P）
 *  - 动态扫描 server/torrents/ 目录：新视频注册后自动加载（多视频）
 *
 * 运行: node metadata-node.js   （server 目录）
 */
const WebTorrent = require('webtorrent') // 根 node_modules（0.98）
const wrtc = require('@roamhq/wrtc') // server/node_modules
const fs = require('fs')
const path = require('path')

const TRACKER = 'wss://bot3.1230sb.com/tracker'
const TORRENTS_DIR = path.join(__dirname, 'torrents')

const client = new WebTorrent({
  tracker: { wrtc } // Node 端启用 WebRTC（浏览器 peer 可连）
})

client.on('error', (e) => console.error('[metadata-node] client error:', e.message))

const watched = new Set()

function scanAndAdd() {
  let files = []
  try {
    files = fs.readdirSync(TORRENTS_DIR).filter((f) => f.endsWith('.torrent'))
  } catch (e) {
    return
  }
  files.forEach((file) => {
    if (watched.has(file)) return
    const full = path.join(TORRENTS_DIR, file)
    try {
      client.add(fs.readFileSync(full), { announce: [TRACKER] }, (torrent) => {
        watched.add(file)
        console.log(
          `[metadata-node] ${torrent.name} metadata 就绪 infoHash=${torrent.infoHash} pieces=${torrent.pieces.length}`
        )
        // 关键：不 select 任何 piece —— 不拉数据、不做视频上行，只做 metadata 引导
      })
    } catch (e) {
      console.error('[metadata-node] add 失败:', file, e.message)
    }
  })
}

// 每 5 秒扫描一次 torrents/ 目录，动态加载新注册的视频
scanAndAdd()
setInterval(scanAndAdd, 5000)

setInterval(() => {
  const total = client.torrents.reduce((a, t) => a + t.numPeers, 0)
  console.log(
    `[metadata-node] 运行中，持 metadata 视频数=${client.torrents.length}，peers=${total}`
  )
}, 15000)
