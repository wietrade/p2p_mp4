/**
 * HTTP 媒体文件服务
 *
 * 按播放器协议实现：
 *  - node-filter (src/node-filter.js) 用 HEAD 测速，要求 2xx + Content-Length
 *  - http-downloader (src/http-downloader.js) 用 GET + "Range: bytes=begin-end"
 *    - 要求响应 2xx，arraybuffer
 *    - 客户端从 "Content-Range" 头解析 start/end：
 *      getResponseHeader("Content-Range").split(" ",2)[1].split('/',1)[0]  -> "start-end"
 *  - CORS：页面与节点可能不同源，需要 Access-Control-Allow-Origin: *
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const media = require('./media')
const config = require('./config')

const MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.bin': 'application/octet-stream'
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Range, X-Pear-Token, Content-Type')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
}

function getMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

/**
 * 处理 GET / HEAD 请求。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} requestPath 未解码的原始 pathname
 */
function handleMediaRequest(req, res, requestPath) {
  setCors(res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  // 解码并规范化
  let decoded
  try {
    decoded = decodeURIComponent(requestPath)
  } catch (e) {
    res.statusCode = 400
    res.end('bad request')
    return
  }

  const rel = media.resolveMediaPath(decoded)
  const info = rel ? media.statMedia(rel) : null
  if (!info) {
    // 本地无此文件 → 查外链媒体映射。
    // 注意：key 用正斜杠形式（{视频host}{视频path}），不能用 path.normalize 后的反斜杠
    let remoteKey = decoded
    const prefix = '/' + config.sourceHostWithPort
    if (remoteKey.indexOf(prefix) === 0) remoteKey = remoteKey.slice(prefix.length)
    remoteKey = remoteKey.replace(/^[/\\]+/, '')
    const rm = config.remoteMedia[remoteKey]
    if (rm && rm.remoteUrl) {
      proxyRequest(req, res, rm.remoteUrl)
      return
    }
    res.statusCode = 404
    res.end('not found')
    return
  }

  const mime = getMime(info.fullPath)
  res.setHeader('Content-Type', mime)
  res.setHeader('Accept-Ranges', 'bytes')

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', info.size)
    res.statusCode = 200
    res.end()
    return
  }

  if (req.method !== 'GET') {
    res.statusCode = 405
    res.end('method not allowed')
    return
  }

  // Range 处理：bytes=begin-end（http-downloader 只发这种形式，但兼容 open 形式）
  const rangeHeader = req.headers.range
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (!m) {
      res.statusCode = 416
      res.end()
      return
    }
    let start = m[1] === '' ? null : parseInt(m[1], 10)
    let end = m[2] === '' ? null : parseInt(m[2], 10)
    if (start === null) {
      // 后缀范围 bytes=-N：最后 N 字节
      const suffix = end === null ? 0 : end
      start = Math.max(0, info.size - suffix)
      end = info.size - 1
    } else {
      if (end === null || end >= info.size) end = info.size - 1
    }
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${info.size}`)
      res.end()
      return
    }
    const len = end - start + 1
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('Content-Length', len)
    delayedStreamFile(res, info.fullPath, start, len)
    return
  }

  // 无 Range：整个文件
  res.statusCode = 200
  res.setHeader('Content-Length', info.size)
  delayedStreamFile(res, info.fullPath, 0, info.size)
}

/** 可选延迟后发送文件流（用于模拟慢 CDN，验证 DataChannel 抢跑） */
function delayedStreamFile(res, fullPath, start, length) {
  const delay = config.httpMediaDelayMs || 0
  if (delay > 0) {
    setTimeout(() => streamFile(res, fullPath, start, length), delay)
  } else {
    streamFile(res, fullPath, start, length)
  }
}

function streamFile(res, fullPath, start, length) {
  const stream = fs.createReadStream(fullPath, { start, end: start + length - 1 })
  stream.on('error', () => {
    if (!res.headersSent) res.statusCode = 500
    res.end()
  })
  stream.pipe(res)
}

/**
 * 外链回源转发：把本服务收到的请求（含 Range 头）原样转发到目标 URL，流式回传。
 * 用于 remoteMedia 映射——浏览器跨域请求本服务，本服务再回源外链 CDN。
 */
function proxyRequest(req, res, targetUrl) {
  let u
  try {
    u = new URL(targetUrl)
  } catch (e) {
    res.statusCode = 400
    res.end('bad proxy target')
    return
  }
  const lib = u.protocol === 'https:' ? https : http
  const headers = Object.assign({}, req.headers)
  headers.host = u.host
  delete headers.connection

  const preq = lib.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      method: req.method,
      path: u.pathname + u.search,
      headers
    },
    (pres) => {
      res.statusCode = pres.statusCode || 502
      // 复制响应头（Content-Range / Content-Length / Content-Type 等；CORS 头由 setCors 已设置）
      for (const [k, v] of Object.entries(pres.headers)) {
        try {
          res.setHeader(k, v)
        } catch (e) {
          /* 忽略非法头 */
        }
      }
      pres.pipe(res)
    }
  )
  preq.on('error', (e) => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.end('proxy error')
    } else {
      res.destroy()
    }
  })
  // 转发请求体（GET/HEAD 无 body，兼容其它方法）
  req.pipe(preq)
}

module.exports = { handleMediaRequest, proxyRequest }
