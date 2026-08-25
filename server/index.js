/**
 * 后端入口：HTTP 服务（媒体 + 节点 API + torrent + 播放器页）+ WebSocket 信令
 *
 * 路由：
 *   GET  /v1/customer/nodes          节点发现 API（播放器 _getNodes）
 *   GET  /torrent/{enc}.torrent      torrent 下载（播放器 PieceValidator）
 *   GET  /                           播放器测试页
 *   GET  /pear-player.js             dist 构建产物
 *   GET  /{视频host}{视频path}        媒体文件（Range / HEAD）
 */
const http = require('http')
const path = require('path')
const fs = require('fs')
const config = require('./config')
const media = require('./media')
const httpMedia = require('./http-media')
const nodesApi = require('./nodes-api')
const torrent = require('./torrent-service')
const videoService = require('./video-service')
const { createSignaling } = require('./signaling')

const ROOT = path.join(__dirname, '..') // 仓库根

// 实时统计存储：user → 最近上报的统计数据（供 /v1/stats 聚合）
const statsStore = new Map()

function sendFile(res, filePath, mime, status = 200) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.statusCode = status
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Length', st.size)
    fs.createReadStream(filePath).pipe(res)
  })
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = u.pathname

  // 1. 节点发现 API
  if (pathname === '/v1/customer/nodes') {
    nodesApi.handleNodesApi(req, res)
    return
  }

  // 1.03 健康检查（进程守护/监控用）
  if (pathname === '/health' || pathname === '/healthz') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 200
    res.end(JSON.stringify({ ok: true, ts: Date.now(), registered: videoService.listVideos().length }))
    return
  }

  // 1.02 WebRTC 配置动态下发（多 STUN/TURN，模仿 instant.io /__rtcConfig__；前端播放器启动前拉取）
  if (pathname === '/rtc_config' || pathname === '/__rtcConfig__') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    res.statusCode = 200
    res.end(JSON.stringify({ rtcConfig: config.rtcConfig }))
    return
  }

  // 1.0 实时统计 API：播放器页 POST 上报本页数据，GET 返回聚合（供统计面板轮询）
  if (pathname === '/v1/stats') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 1e6) req.destroy()
      })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data && data.user) {
            data.updatedAt = Date.now()
            statsStore.set(data.user, data)
          }
        } catch (e) { /* ignore bad json */ }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end('{"ok":true}')
      })
      return
    }
    if (req.method === 'GET') {
      const now = Date.now()
      for (const [k, v] of statsStore) {
        if (now - v.updatedAt > 30000) statsStore.delete(k) // 30s 未上报视为离线
      }
      const users = Array.from(statsStore.values()).sort((a, b) => (a.user || '').localeCompare(b.user || ''))
      const agg = users.reduce(
        (a, u) => {
          a.p2pBlocks += u.p2pBlocks || 0
          a.httpBlocks += u.httpBlocks || 0
          a.p2pDl += u.p2pDlSpeed || 0
          a.httpDl += u.httpSpeed || 0
          a.p2pUp += u.p2pUpSpeed || 0
          a.bytes += u.p2pBytes || 0
          a.bytes += u.httpBytes || 0
          return a
        },
        { p2pBlocks: 0, httpBlocks: 0, p2pDl: 0, httpDl: 0, p2pUp: 0, bytes: 0 }
      )
      const total = agg.p2pBlocks + agg.httpBlocks
      agg.p2pRatio = total ? +((agg.p2pBlocks / total) * 100).toFixed(1) : 0
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ users, aggregate: agg, ts: now }))
      return
    }
    res.statusCode = 405
    res.end()
    return
  }

  // 1.05 视频注册/处理 API（最佳方案：HTTP 视频链接 → 自动生成种子/metadata）
  //   POST /v1/videos   body: { url, name? }  注册并处理视频，返回 magnet/torrent/infoHash
  //   GET  /v1/videos?url=xxx                 查询（url 已注册则直接返回）
  //   GET  /v1/videos                         列出所有已注册视频
  if (pathname === '/v1/videos') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 1e6) req.destroy()
      })
      req.on('end', async () => {
        try {
          const data = JSON.parse(body)
          const info = await videoService.registerVideo(data.url, data.name, data.magnet, data.torrentUrl)
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, video: info }))
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: e.message }))
        }
      })
      return
    }
    if (req.method === 'GET') {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      const qurl = u.searchParams.get('url')
      if (qurl) {
        const vid = videoService.getVideoByUrl(qurl)
        if (!vid) {
          res.statusCode = 404
          res.end(JSON.stringify({ ok: false, error: 'not registered, POST /v1/videos first' }))
          return
        }
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, video: vid }))
        return
      }
      res.statusCode = 200
      res.end(JSON.stringify({ ok: true, videos: videoService.listVideos() }))
      return
    }
    res.statusCode = 405
    res.end()
    return
  }

  // 1.1 统计上报桩（reporter.js 会 POST /traffic 与 /v2/customer/stats/nodes/capacity）
  if (pathname === '/traffic' || pathname === '/v2/customer/stats/nodes/capacity') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method === 'POST') {
      req.resume()
      req.on('end', () => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end('{}')
      })
      return
    }
    res.statusCode = 405
    res.end()
    return
  }

  // 2. torrent 下载
  if (pathname.startsWith('/torrent/') && pathname.endsWith('.torrent')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const raw = pathname.slice('/torrent/'.length, -'.torrent'.length)
    let mediaPath
    try {
      mediaPath = decodeURIComponent(raw)
    } catch (e) {
      res.statusCode = 400
      res.end('bad request')
      return
    }
    const info = media.statMedia(mediaPath)
    if (!info) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    torrent
      .getTorrent(mediaPath, info.size)
      .then((buf) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-bittorrent')
        res.setHeader('Content-Length', buf.length)
        res.end(buf)
      })
      .catch((e) => {
        res.statusCode = 500
        res.end('torrent error: ' + e.message)
      })
    return
  }

  // 3. 播放器测试页
  if (config.servePlayerPage && (pathname === '/' || pathname === '/index.html')) {
    sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8')
    return
  }

  // 3.1 WebTorrent seed 页面
  if (config.servePlayerPage && pathname === '/seed.html') {
    sendFile(res, path.join(__dirname, 'public', 'seed.html'), 'text/html; charset=utf-8')
    return
  }
  // 3.11 浏览器 metadata 引导页（用户端，只广播 piece 哈希，不做数据上行）
  if (config.servePlayerPage && pathname === '/metadata.html') {
    sendFile(res, path.join(__dirname, 'public', 'metadata.html'), 'text/html; charset=utf-8')
    return
  }
  // 3.12 功能测试台（注册 / 引导来源 / 节点 API / 播放，纯前端）
  if (config.servePlayerPage && pathname === '/test.html') {
    sendFile(res, path.join(__dirname, 'public', 'test.html'), 'text/html; charset=utf-8')
    return
  }
  if (config.servePlayerPage && pathname === '/webtorrent.min.js') {
    sendFile(res, path.join(__dirname, 'public', 'webtorrent.min.js'), 'application/javascript')
    return
  }

  // 4. 播放器构建产物（dist）
  if (pathname === '/pear-player.js' || pathname === '/dist/pear-player.js') {
    sendFile(res, path.join(ROOT, 'dist', 'pear-player.js'), 'application/javascript')
    return
  }

  // 4.5 次级方案：已注册视频的 HTTP 代理（回源原 HTTP 链接，支持 Range，浏览器可直连）
  // 播放器节点 uri 会带 {host:port} 前缀（如 /127.0.0.1:8000/proxy/{id}），用结尾匹配
  const proxyMatch = /\/proxy\/([0-9a-f]{10})$/.exec(pathname)
  if (proxyMatch) {
    console.log('[proxy]', req.method, pathname, 'range=' + JSON.stringify(req.headers.range), 'ua=' + (req.headers['user-agent'] || '').slice(0, 20))
    const vid = videoService.getVideoById(proxyMatch[1])
    if (!vid || !vid.url) {
      res.statusCode = 404
      res.end('video not found')
      return
    }
    // SSRF 防护：注册时已校验过，转发前再校验一次目标地址（防注册记录被注入/篡改）
    let target
    try {
      target = new URL(vid.url)
    } catch (e) { /* 非法 url 走 502 */ }
    if (!target || videoService.isPrivateHost(target.hostname)) {
      res.statusCode = 502
      res.end('proxy target not allowed')
      return
    }
    httpMedia.proxyRequest(req, res, vid.url)
    return
  }

  // 4.6 浏览器 metadata 引导：服务 torrents/ 目录的 .torrent 文件（供 metadata.html 加载，跨域部署需 CORS）
  const bootMatch = /^\/boot\/([^/]+\.torrent)$/.exec(pathname)
  if (bootMatch) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    const f = path.join(__dirname, 'torrents', decodeURIComponent(bootMatch[1]))
    if (fs.existsSync(f)) {
      sendFile(res, f, 'application/x-bittorrent')
    } else {
      res.statusCode = 404
      res.end('torrent not found')
    }
    return
  }

  // 5. 其它一律按媒体文件处理（Range / HEAD / CORS）
  httpMedia.handleMediaRequest(req, res, pathname)})

// WebSocket 信令
const { WebSocketServer } = require('ws')
const wss = new WebSocketServer({ port: config.wsPort })
const signaling = createSignaling(wss)
console.log(`[signaling] WebSocket listening on ws://127.0.0.1:${config.wsPort}/wss`)

// Fog 节点（服务端 WebRTC DataChannel 文件服务）
const { startFogNodes } = require('./fog-node')
const fogNodes = startFogNodes(signaling, config.fogCountPerMedia)
if (fogNodes.length === 0) {
  console.warn('[fog] 没有启动任何 Fog 节点（media 目录无 mp4 文件？）')
}

server.listen(config.httpPort, () => {
  console.log(`[http] media/nodes/torrent server listening on http://${config.sourceHost}:${config.httpPort}`)
  console.log(`[http] player page:  http://${config.sourceHost}:${config.httpPort}/`)
  console.log(`[http] media root:   ${config.mediaRoot}`)
})

module.exports = { server, wss }
