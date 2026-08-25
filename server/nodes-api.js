/**
 * 节点发现 API —— GET /v1/customer/nodes
 *
 * 协议确认（src/worker.js _getNodes）：
 *  - 客户端: GET {getNodesUrl}?host={host}&uri={path}，Header: X-Pear-Token
 *  - 响应 JSON:
 *    {
 *      "size": <文件字节数>,
 *      "torrents": { "512": "<torrent 下载 URL>" },
 *      "nodes": [ { "protocol": "http", "http_port": n, "https_port": n,
 *                   "host": "x", "type": "node"|"server", "capacity": n } ]
 *    }
 *  - 客户端用 size>0 判断成功；下载 torrents["512"] 构建 PieceValidator
 *  - http 节点最终 uri = protocol://host:http_port/{视频host}{视频path}
 */
const url = require('url')
const media = require('./media')
const config = require('./config')
const torrent = require('./torrent-service')
const videoService = require('./video-service')

async function handleNodesApi(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Pear-Token, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const parsed = url.parse(req.url, true)
  const host = parsed.query.host
  const uri = parsed.query.uri

  // 校验 token（配置为空表示不校验）
  if (config.token && req.headers['x-pear-token'] !== config.token) {
    res.statusCode = 401
    res.end(JSON.stringify({ error: 'invalid token' }))
    return
  }

  // 从 uri（视频路径，如 /media/demo.mp4）解析出媒体文件
  let rel = media.resolveMediaPath(uri)
  let info = rel ? media.statMedia(rel) : null

  // 本地无此文件 → 查外链媒体映射（key = {视频host}{视频path}）
  if (!info) {
    const rm = config.remoteMedia[(host || '') + (uri || '')]
    if (rm && rm.localFile) {
      rel = rm.localFile
      info = media.statMedia(rel)
    }
  }

  // 次级方案：/proxy/{videoId} → 已注册视频（无本地文件，HTTP 走代理 + P2P 走 magnet）
  // 用结尾匹配（兼容外网部署时 uri 带前缀，如 /p2p_mp4/proxy/{id}）
  let secondaryVid = null
  if (!info) {
    const pm = /\/proxy\/([0-9a-f]{10})$/.exec(uri || '')
    if (pm) secondaryVid = videoService.getVideoById(pm[1])
  }
  // 直连外链场景：uri=外链路径、host=外链域名 → 反查已注册视频（HTTP 直连 CDN，服务端零上行）
  if (!secondaryVid) {
    secondaryVid = videoService.getVideoByExternalHost(host, uri)
  }

  if (!info && !secondaryVid) {
    // size=0 时客户端会 cb(null) 走降级；这里明确返回 404 更清晰
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'media not found', host, uri }))
    return
  }

  try {
    let body
    if (info) {
      // 本地文件：预生成 torrent + HTTP 节点 + WebTorrent 节点
      await torrent.getTorrent(info.relPath, info.size)
      const vid = videoService.getVideoByMediaPath(info.relPath)
      const nodes = config.nodes.concat([
        { protocol: 'webtorrent', magnet_uri: vid ? vid.magnetURI : config.magnetURI }
      ])
      body = {
        size: info.size,
        torrents: { '512': torrent.torrentUrl(info.relPath) },
        nodes
      }
    } else {
      // 次级方案：无本地文件。size 用 HEAD 拿（播放器判断 size>0 才继续），
      // HTTP 节点走本地代理（/proxy/{id} 回源原链接），P2P 用注册的 magnet
      const size = await videoService.fetchVideoSize(secondaryVid)
      if (!size) {
        res.statusCode = 502
        res.end(JSON.stringify({ error: 'cannot get video size from origin', url: secondaryVid.url }))
        return
      }
      const nodes = config.nodes.concat([
        { protocol: 'webtorrent', magnet_uri: secondaryVid.magnetURI }
      ])
      body = {
        size,
        torrents: { '512': '' },
        nodes
      }
    }
    res.statusCode = 200
    res.end(JSON.stringify(body))
  } catch (e) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: 'torrent generate failed: ' + e.message }))
  }
}

module.exports = { handleNodesApi }
