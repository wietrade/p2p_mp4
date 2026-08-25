/**
 * 为 server/media/ 下的视频生成 torrent 文件 + magnetURI（pieceLength=512KB，与播放器一致）
 * 用法: node gen-torrent.js [文件名]   （默认 demo.mp4，输出到 server/torrents/）
 */
const fs = require('fs')
const path = require('path')
const createTorrent = require('create-torrent')
const parseTorrentFile = require('parse-torrent-file')

const fileName = process.argv[2] || 'demo.mp4'
const mediaFile = path.join(__dirname, 'media', fileName)
const outDir = path.join(__dirname, 'torrents')
const outFile = path.join(outDir, fileName + '.torrent')
const pieceLength = 512 * 1024

// 种子内置 tracker（标准做法）：WebTorrent add(.torrent) 会自动使用；外部 tracker 仅作补充。
//  - wss://  → WebTorrent（浏览器/Node）
//  - udp:// http:// → 传统 BT 客户端（uTorrent/qBittorrent 等不支持 wss://，必须带标准 tracker）
const ANNOUNCE = [
  'wss://bot3.1230sb.com/tracker',
  'wss://tracker.openwebtorrent.com',
  'udp://tracker.opentrackr.org:1337/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://exodus.desync.com:6969/announce'
]

if (!fs.existsSync(mediaFile)) {
  console.error('媒体文件不存在:', mediaFile)
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })

createTorrent(mediaFile, { pieceLength, announce: ANNOUNCE }, (err, torrentBuf) => {
  if (err) {
    console.error('create-torrent 失败:', err)
    process.exit(1)
  }
  fs.writeFileSync(outFile, torrentBuf)
  const parsed = parseTorrentFile(torrentBuf)
  const infoHash = parsed.infoHash
  const magnet =
    'magnet:?xt=urn:btih:' + infoHash +
    '&dn=' + encodeURIComponent(parsed.name) +
    ANNOUNCE.map(function (t) { return '&tr=' + encodeURIComponent(t) }).join('')
  console.log('✅ torrent 已生成:', outFile)
  console.log('  name      :', parsed.name)
  console.log('  length    :', parsed.length, '字节')
  console.log('  pieceLength:', parsed.pieceLength)
  console.log('  pieces    :', parsed.pieces.length)
  console.log('  infoHash  :', infoHash)
  console.log('  magnetURI :', magnet)
})
