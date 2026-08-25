/**
 * torrent 生成与缓存服务
 *
 * 协议确认（src/worker.js + src/piece-validator.js + 实测）：
 *  - 节点 API 返回 torrents["512"] 的 URL，客户端用 XHR arraybuffer 下载
 *  - 客户端 parse-torrent-file 解析，pieces 为 40 字符 hex 字符串数组
 *  - validate: Rusha.sha1(data).hex === pieces[index]，index = floor(start/pieceLength)
 *  - 因此 pieceLength 必须等于播放器 Dispatcher 的 chunkSize（默认 512*1024）
 *
 * 用 create-torrent 生成标准 torrent（pieces 为 SHA-1，自动满足上述要求）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const createTorrent = require('create-torrent')
const config = require('./config')

const cache = new Map() // mediaPath -> Buffer(torrent 文件)

/**
 * 为媒体文件生成 torrent，带缓存。
 * @param {string} mediaPath 相对 mediaRoot 的路径，如 "media/demo.mp4"
 * @param {number} fileSize
 * @returns {Promise<Buffer>}
 */
function getTorrent(mediaPath, fileSize) {
  if (cache.has(mediaPath)) return Promise.resolve(cache.get(mediaPath))

  const full = path.join(config.mediaRoot, mediaPath)
  // create-torrent 需要可读文件；也支持直接传文件路径
  return new Promise((resolve, reject) => {
    createTorrent(full, { pieceLength: config.pieceLength, announce: [] }, (err, torrentBuf) => {
      if (err) return reject(err)
      if (!torrentBuf || torrentBuf.length === 0) return reject(new Error('create-torrent returned empty'))
      cache.set(mediaPath, torrentBuf)
      resolve(torrentBuf)
    })
  })
}

/** torrent 的下载 URL（供节点 API 的 torrents["512"] 使用） */
function torrentUrl(mediaPath) {
  const enc = encodeURIComponent(mediaPath)
  // 种子放 GitHub 静态托管时优先用 GitHub 外链；否则回退服务器 /torrent/
  if (config.torrentPublicBase) return `${config.torrentPublicBase}/${enc}.torrent`
  return `http://${config.sourceHost}:${config.httpPort}/torrent/${enc}.torrent`
}

module.exports = { getTorrent, torrentUrl }
