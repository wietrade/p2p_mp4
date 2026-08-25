/**
 * 视频注册/处理服务（站长提供 HTTP 视频 + 磁力/种子）
 *
 * 【P2P 必需】HTTP 视频直链 + 站长提供的磁力（magnet，或 .torrent 直链 xs）
 *   有磁力 → 服务端不下载视频，解析磁力 → 获取/托管种子 → 播放器 P2P
 *   无磁力 → 纯 HTTP 注册（不下载生成种子：大文件不可行），播放器仅 HTTP 播放
 *
 * 多个视频：任意数量，各自独立注册
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const parseTorrentFile = require('parse-torrent-file')
const config = require('./config')
const torrentService = require('./torrent-service')

// 注册表持久化：已注册的视频记录存到 data/videos.json，重启后自动恢复，直接跳过种子处理
const dataDir = path.join(__dirname, 'data')
const videosFile = path.join(dataDir, 'videos.json')

/** url -> { id, url, rel, name, size, infoHash, magnetURI } */
const videos = new Map()

/** 种子 hash 索引：infoHash -> 已处理的种子记录（以种子为中心，同一种子只处理一次） */
const infoHashes = new Map()

/** 启动时加载注册记录 */
function loadVideos() {
  try {
    if (fs.existsSync(videosFile)) {
      const arr = JSON.parse(fs.readFileSync(videosFile, 'utf8'))
      for (const v of arr) {
        if (v && v.url) videos.set(v.url, v)
        if (v && v.infoHash) infoHashes.set(v.infoHash, v)   // 重建种子索引
      }
      console.log('[video-service] 已加载注册记录:', videos.size, '条 / 种子:', infoHashes.size, '个（重启后直接跳过种子处理）')
    }
  } catch (e) {
    console.warn('[video-service] 加载注册记录失败:', e.message)
  }
}

/** 注册后保存记录到磁盘（临时文件 + rename 原子替换，防崩溃损坏） */
function saveVideos() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = videosFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(Array.from(videos.values()), null, 2))
    fs.renameSync(tmp, videosFile)
  } catch (e) {
    console.warn('[video-service] 保存注册记录失败:', e.message)
  }
}

loadVideos()

function sanitize(name) {
  // 防路径穿越：去掉首尾点号，并把 ".." 替换为 "_"（种子 name 可能被攻击者控制）
  return String(name || '')
    .replace(/[^\w.\-]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.\./g, '_')
}

/** SSRF 防护：host 是否为内网/回环/链路本地地址（域名形式放行，外链通常为域名） */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').split(':')[0]
  if (!h) return true
  if (h === 'localhost' || h === '::1') return true
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false   // 非 IPv4 字面量（域名/IPv6）放行
  const p = h.split('.').map(Number)
  if (p.some((n) => n > 255)) return true                // 非法 IPv4 视为可疑
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||        // CGNAT 100.64/10
    (p[0] === 169 && p[1] === 254) ||                     // 链路本地 169.254/16
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||         // 172.16/12
    (p[0] === 192 && p[1] === 168)                        // 192.168/16
  )
}

/** SSRF 防护（通用）：校验任意 http/https 直链的 host 不是内网/回环/链路本地，返回 URL 对象 */
function assertPublicHttpUrl(u) {
  let p
  try {
    p = new URL(u)
  } catch (e) {
    throw new Error('invalid url: ' + u)
  }
  if (!/^https?:$/.test(p.protocol)) throw new Error('only http/https url supported')
  if (isPrivateHost(p.hostname)) throw new Error('private/internal address not allowed: ' + p.host)
  return p
}

// 同一 url 并发注册去重（单飞：并发 POST 只处理一次）
const registerInFlight = new Map()

/**
 * 注册一个 HTTP 视频（P2P 需要站长提供磁力/种子参数）
 * @param {string} url HTTP 视频直链（必要）
 * @param {string} [name] 可选文件名
 * @param {string} [magnet] 磁力链接（站长提供，P2P 必需；提供则不下载视频）
 * @param {string} [torrentUrl] 外部 .torrent 直链（可选，加速引导）
 */
function registerVideo(url, name, magnet, torrentUrl) {
  if (videos.has(url)) return Promise.resolve(videos.get(url))
  if (registerInFlight.has(url)) return registerInFlight.get(url)
  const p = _registerVideo(url, name, magnet, torrentUrl).finally(() => registerInFlight.delete(url))
  registerInFlight.set(url, p)
  return p
}

async function _registerVideo(url, name, magnet, torrentUrl) {
  // SSRF 防护：视频直链 host 必须是公网（防止通过 /proxy/{id} 探测内网）
  assertPublicHttpUrl(url)

  const id = crypto.createHash('md5').update(url).digest('hex').slice(0, 10)

  if (magnet) {
    // ===== 有磁力：服务端不下载视频，解析磁力 → 获取/托管种子 → P2P =====
    // 以种子为中心：同一种子（infoHash）已处理过 → 直接复用历史种子处理结果，跳过下载/解析
    const ih = extractInfoHash(magnet)
    if (ih && infoHashes.has(ih)) {
      const prev = infoHashes.get(ih)
      const info = Object.assign({}, prev, { url, id, registeredAt: Date.now() })
      videos.set(url, info)
      saveVideos()
      console.log('[video-service] 复用已有种子处理记录（infoHash=' + ih.slice(0, 12) + '，' + (prev.hasTorrent ? 'torrent=' + prev.torrentUrl : '无 torrent') + '），跳过种子下载')
      return info
    }
    return registerWithMagnet(url, id, magnet, name, torrentUrl)
  }
  // ===== 无磁力但有 .torrent 直链（HTTP 格式）：下载种子 → 代码解析出 magnet → P2P =====
  if (torrentUrl) {
    // SSRF：.torrent 直链 host 也必须是公网（防止服务器下载内网种子探测内网）
    assertPublicHttpUrl(torrentUrl)
    return registerWithTorrentUrl(url, id, name, torrentUrl)
  }
  // ===== 无种子参数：纯 HTTP 注册（P2P 需站长提供 .torrent 直链） =====
  return registerHttpOnly(url, id, name)
}

/** 从 magnet 提取 infoHash（btih） */
function extractInfoHash(magnet) {
  const m = /btih:([0-9a-fA-F]{40})/.exec(magnet)
  return m ? m[1].toLowerCase() : null
}

/** 从 magnet 提取 xs 参数（.torrent 直链地址） */
function extractXs(magnet) {
  const m = /[?&]xs=([^&]+)/.exec(magnet)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch (e) {
    return m[1]
  }
}

/** 下载任意 URL 到 Buffer（跟随重定向） */
function downloadBuffer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return downloadBuffer(res.headers.location, timeout).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => {
      req.destroy(new Error('download timeout'))
    })
  })
}

/**
 * 尝试从 peer 交换 metadata（downloadmeta 方式，webtorrent-cli 同款机制）。
 * Node 端用 wrtc，成功返回 .torrent Buffer，失败返回 null（best effort，不阻塞注册）。
 */
function tryFetchMetadata(magnet) {
  return new Promise((resolve) => {
    try {
      const WebTorrent = require('webtorrent')
      const wrtc = require('@roamhq/wrtc')
      const client = new WebTorrent({ tracker: { wrtc } })
      const timer = setTimeout(() => {
        try { client.destroy() } catch (e) { /* ignore */ }
        resolve(null)
      }, 25000)
      client.add(magnet, { announce: ['wss://bot3.1230sb.com/tracker'] }, (torrent) => {
        clearTimeout(timer)
        const buf = torrent.torrentFile
        setTimeout(() => { try { client.destroy() } catch (e) { /* ignore */ } }, 1500)
        resolve(buf ? Buffer.from(buf) : null)
      })
      client.on('error', () => {})
      client.on('warning', () => {})
    } catch (e) {
      resolve(null)
    }
  })
}

/** 托管 .torrent 到 torrents/ 目录（供 /boot/ 下载 + 前端 metadata 引导） */
function saveTorrent(torrentBuf) {
  try {
    const parsed = parseTorrentFile(torrentBuf)
    const dir = path.join(__dirname, 'torrents')
    fs.mkdirSync(dir, { recursive: true })
    const tf = path.join(dir, sanitize(parsed.name) + '.torrent')
    if (!fs.existsSync(tf)) fs.writeFileSync(tf, torrentBuf)
    return parsed
  } catch (e) {
    return null
  }
}

/** 在 torrents/ 目录查找 infoHash 匹配的 .torrent 文件（供 metadata 引导） */
function findLocalTorrentByHash(infoHash) {
  const dir = path.join(__dirname, 'torrents')
  if (!fs.existsSync(dir)) return null
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.torrent')) continue
    try {
      const buf = fs.readFileSync(path.join(dir, f))
      if (parseTorrentFile(buf).infoHash === infoHash) return buf
    } catch (e) { /* ignore */ }
  }
  return null
}

/** 次级方案：用已有 magnet 注册（不下载视频）
 * @param {string} [torrentUrl] 外部传入的 .torrent 直链（与磁力 xs 同源，可省略）
 */
async function registerWithMagnet(url, id, magnet, name, torrentUrl) {
  const infoHash = extractInfoHash(magnet)
  if (!infoHash) throw new Error('magnet 缺少 btih（磁力 hash）')

  // 1. 获取 .torrent（metadata 引导），按可靠性顺序：本地已有 → xs/外部直链 → 从 peer 交换
  let torrentBuf = findLocalTorrentByHash(infoHash)
  let metaSource = torrentBuf ? 'local' : null
  if (!torrentBuf) {
    // xs 候选：磁力自带 xs + 外部传入的 torrentUrl（.torrent 直链）
    const xsCandidates = []
    const xs = extractXs(magnet)
    if (xs) xsCandidates.push(xs)
    if (torrentUrl) xsCandidates.push(torrentUrl)
    for (const u of xsCandidates) {
      // SSRF：直链 host 必须是公网（磁力 xs / 外部 torrentUrl 可能是内网地址）
      try {
        assertPublicHttpUrl(u)
      } catch (e) {
        console.warn('[video-service] 跳过内网/非法直链:', u)
        continue
      }
      console.log('[video-service] 从直链下载 .torrent:', u)
      try {
        const buf = await downloadBuffer(u)
        const parsed = parseTorrentFile(buf)
        if (parsed.infoHash === infoHash) {
          torrentBuf = buf
          metaSource = 'xs'
          break
        } else {
          console.warn('[video-service] 下载的 torrent infoHash 不匹配，丢弃')
        }
      } catch (e) {
        console.warn('[video-service] xs 下载失败:', e.message)
      }
    }
  }
  if (!torrentBuf) {
    console.log('[video-service] 尝试从 peer 交换 metadata（downloadmeta）...')
    torrentBuf = await tryFetchMetadata(magnet)
    if (torrentBuf) metaSource = 'downloadmeta'
  }

  // 2. 托管 .torrent（供 /boot/ + 前端 metadata 引导）
  let parsedName = null
  let seedAnnounce = []   // 种子自带的 tracker（announce）
  if (torrentBuf) {
    const parsed = saveTorrent(torrentBuf)
    if (parsed) {
      parsedName = parsed.name
      if (Array.isArray(parsed.announce)) seedAnnounce = parsed.announce
    }
  }

  // trackers：种子自带 announce + 配置补充（去重）
  const trackers = []
  for (const t of seedAnnounce.concat(config.webTorrentTrackers || [])) {
    if (t && trackers.indexOf(t) === -1) trackers.push(t)
  }

  // 3. 注册
  const info = {
    id,
    url,
    rel: null, // 无本地文件
    localFile: null,
    name: name || parsedName || 'video_' + infoHash.slice(0, 8),
    size: null, // 服务端不下载，大小由节点 API HEAD 获取
    infoHash,
    magnetURI: magnet,
    hasTorrent: !!torrentBuf,
    metaSource,
    trackers,
    torrentUrl: torrentBuf && parsedName
      ? (config.torrentPublicBase
          ? config.torrentPublicBase + '/' + encodeURIComponent(parsedName + '.torrent')          // 种子在 GitHub
          : (config.publicBase || 'http://' + config.sourceHostWithPort) + '/boot/' + encodeURIComponent(parsedName + '.torrent'))  // 服务器 /boot/ 兜底
      : null,
    registeredAt: Date.now()
  }
  videos.set(url, info)
  infoHashes.set(infoHash, info)   // 以种子 hash 为索引，供后续复用
  saveVideos()
  console.log('[video-service] 次级方案注册:', info.name, 'infoHash=' + infoHash, 'torrent引导:', metaSource || '无（仅磁力）')
  return info
}

/** 站长提供 .torrent 直链（HTTP 格式）：下载种子（几 KB，非视频）→ 代码解析出 magnet/infoHash → P2P 注册 */
async function registerWithTorrentUrl(url, id, name, torrentUrl) {
  // SSRF 双保险：直链 host 必须是公网
  assertPublicHttpUrl(torrentUrl)
  // 1. 下载 .torrent（小文件）并解析
  let buf, parsed
  try {
    buf = await downloadBuffer(torrentUrl)
    parsed = parseTorrentFile(buf)
  } catch (e) {
    throw new Error('torrent 下载/解析失败: ' + ((e && e.message) || e))
  }
  if (!parsed || !parsed.infoHash) throw new Error('无效的 .torrent 文件')
  const infoHash = parsed.infoHash

  // 2. 代码从种子解析出 magnet（含 infoHash + 种子自带 announce）
  const magnet =
    'magnet:?xt=urn:btih:' + infoHash +
    '&dn=' + encodeURIComponent(parsed.name || '') +
    (Array.isArray(parsed.announce) && parsed.announce.length
      ? parsed.announce.map((t) => '&tr=' + encodeURIComponent(t)).join('')
      : '')

  // 3. 同一种子已处理过 → 直接复用（以种子为中心）
  if (infoHashes.has(infoHash)) {
    const prev = infoHashes.get(infoHash)
    const info = Object.assign({}, prev, { url, id, registeredAt: Date.now() })
    videos.set(url, info)
    saveVideos()
    console.log('[video-service] 复用已有种子处理记录（infoHash=' + infoHash.slice(0, 12) + '），跳过种子下载')
    return info
  }

  // 4. 托管 .torrent（torrents/ 目录，供 /boot/ 下载 + metadata 引导）
  const saved = saveTorrent(buf)
  const parsedName = saved ? saved.name : parsed.name

  // 5. 注册
  const trackers = []
  const seedAnnounce = Array.isArray(parsed.announce) ? parsed.announce : []
  for (const t of seedAnnounce.concat(config.webTorrentTrackers || [])) {
    if (t && trackers.indexOf(t) === -1) trackers.push(t)
  }
  const info = {
    id,
    url,
    rel: null,
    localFile: null,
    name: name || parsedName,
    size: null,          // 服务端不下载视频，大小由 HTTP HEAD 获取
    infoHash,
    magnetURI: magnet,   // 代码从种子解析生成
    hasTorrent: true,
    metaSource: 'xs',
    trackers,
    torrentUrl: parsedName
      ? (config.torrentPublicBase
          ? config.torrentPublicBase + '/' + encodeURIComponent(parsedName + '.torrent')
          : (config.publicBase || 'http://' + config.sourceHostWithPort) + '/boot/' + encodeURIComponent(parsedName + '.torrent'))
      : null,
    registeredAt: Date.now()
  }
  videos.set(url, info)
  infoHashes.set(infoHash, info)   // 以种子 hash 为索引，供后续复用
  saveVideos()
  console.log('[video-service] 种子直链注册:', info.name, 'infoHash=' + infoHash, 'magnet 已由代码解析')
  return info
}

/** 纯 HTTP 注册（无磁力/种子参数）：不下载视频、不生成种子；P2P 不可用，播放器走纯 HTTP。
 *  P2P 需站长额外提供磁力（magnet）或 .torrent 直链（xs），由 registerWithMagnet 处理。 */
async function registerHttpOnly(url, id, name) {
  let baseName
  try {
    baseName = sanitize(name || path.basename(new URL(url).pathname) || 'video_' + id + '.mp4')
  } catch (e) {
    baseName = sanitize(name || 'video_' + id + '.mp4')
  }
  const info = {
    id,
    url,
    rel: null,
    localFile: null,
    name: baseName,
    size: null,          // 服务端不下载，大小由 HTTP HEAD 获取
    infoHash: null,
    magnetURI: null,     // 无种子 → 播放器不启用 P2P（纯 HTTP）
    hasTorrent: false,
    metaSource: null,
    trackers: (config.webTorrentTrackers || []).slice(),
    torrentUrl: null,
    registeredAt: Date.now()
  }
  videos.set(url, info)
  saveVideos()
  console.log('[video-service] 纯 HTTP 注册（无种子，P2P 关闭）:', info.name)
  return info
}

/** 返回时补全 trackers：合并当前 config 的 tracker（兼容旧注册记录持久化的旧 trackers） */
function withTrackers(v) {
  const list = (Array.isArray(v.trackers) ? v.trackers : []).slice()
  for (const t of config.webTorrentTrackers || []) {
    if (t && list.indexOf(t) === -1) list.push(t)
  }
  const out = Object.assign({}, v, { trackers: list })
  return out
}

function getVideoByUrl(url) {
  const v = videos.get(url)
  return v ? withTrackers(v) : null
}

function getVideoById(id) {
  for (const v of videos.values()) if (v.id === id) return v
  return null
}

/** HEAD 请求获取视频大小（Content-Length），失败返回 null */
function headContentLength(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        req.destroy()
        resolve(null)
      }
    }, 15000)
    const req = mod.request(url, { method: 'HEAD' }, (res) => {
      const len = parseInt(res.headers['content-length'] || '0', 10)
      res.resume()
      if (!done) {
        done = true
        clearTimeout(timer)
        resolve(len || null)
      }
    })
    req.on('error', () => {
      if (!done) {
        done = true
        clearTimeout(timer)
        resolve(null)
      }
    })
    req.end() // 关键：必须调用 end() 才会发出请求
  })
}

/** 获取视频大小（带缓存；次级方案无本地文件时用 HEAD 拿大小） */
async function fetchVideoSize(video) {
  if (video.size) return video.size
  const size = await headContentLength(video.url)
  if (size) video.size = size
  return size
}

/** 根据媒体路径（如 "videos/xxx.mp4" 或 "/videos/xxx.mp4"）找视频 */
function getVideoByMediaPath(mediaPath) {
  for (const v of videos.values()) {
    if (v.rel === mediaPath || '/' + v.rel === mediaPath) return v
  }
  return null
}

/** 按外链 host+path 反查已注册视频（直连外链场景：播放器节点 API 传 uri=外链路径、host=外链域名） */
function getVideoByExternalHost(host, uri) {
  if (!host || !uri) return null
  for (const v of videos.values()) {
    try {
      const u = new URL(v.url)
      if (u.host === host && u.pathname === uri) return v
    } catch (e) { /* 忽略非法 url */ }
  }
  return null
}

function listVideos() {
  // 以种子为中心：同 infoHash（同一视频的不同 url 镜像）只显示一条
  const seen = new Set()
  const out = []
  for (const v of videos.values()) {
    if (v.infoHash && seen.has(v.infoHash)) continue
    if (v.infoHash) seen.add(v.infoHash)
    out.push({
      id: v.id,
      name: v.name,
      url: v.url,
      size: v.size,
      infoHash: v.infoHash,
      magnetURI: v.magnetURI,
      torrentUrl: v.torrentUrl,
      hasTorrent: v.hasTorrent,
      metaSource: v.metaSource,
      trackers: withTrackers(v).trackers
    })
  }
  return out
}

module.exports = {
  registerVideo,
  getVideoByUrl,
  getVideoById,
  getVideoByMediaPath,
  getVideoByExternalHost,
  listVideos,
  fetchVideoSize,
  extractInfoHash,
  extractXs,
  downloadBuffer,
  tryFetchMetadata,
  saveTorrent,
  isPrivateHost
}
