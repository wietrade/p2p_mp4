/**
 * tracker-swarm.js — 真实 P2P 在线人数探针
 *
 * 原理：连接自建 wss tracker（bittorrent-tracker server），发送 WebSocket scrape
 *       请求，从响应读取 { complete, incomplete }：
 *         - complete   = 已持有完整数据、正在做种的 peer 数
 *         - incomplete = 下载中（缺数据）的 peer 数
 *       两者之和 = 当前加入该 infoHash swarm 的真实 P2P 连接人数。
 *
 * 为什么这才是"在线用户"：
 *   - statsStore 按"打开的播放页"计数：刷新时旧页残留 30s + 新页进入 → 人数虚增
 *   - tracker swarm 按真实 WS 连接计数：刷新 = 旧连接断开(-1) + 新连接建立(+1)，人数不变
 *   - scrape 只查询、不加入 swarm（无需 announce/peer_id），不会污染计数
 */
const WebSocket = require('ws')

const TRACKER_URL = process.env.PEAR_TRACKER_URL || 'wss://bot3.1230sb.com/tracker'
const TIMEOUT = 6000
const REFRESH_MS = 15000

// infoHash(hex) -> { count, complete, incomplete, ts }
const cache = new Map()

// hex(40) -> 20 字节 binary 字符串（ws 协议 info_hash 格式）
function toBinary20(hex) {
  if (typeof hex !== 'string' || hex.length !== 40) return null
  return Buffer.from(hex, 'hex').toString('binary')
}

// 单次 scrape：连接 → 发请求 → 收响应 → 关闭（不加入 swarm）
function scrape(infoHashHex) {
  return new Promise((resolve) => {
    const bin = toBinary20(infoHashHex)
    if (!bin) { resolve(null); return }
    let ws
    try { ws = new WebSocket(TRACKER_URL) } catch (e) { resolve(null); return }
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close() } catch (e) {} resolve(null) }
    }, TIMEOUT)
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch (e) {}
      resolve(v)
    }
    ws.on('open', () => {
      try { ws.send(JSON.stringify({ action: 'scrape', info_hash: bin })) } catch (e) { done(null) }
    })
    ws.on('message', (data) => {
      try {
        const r = JSON.parse(String(data))
        if (r && r.action === 'scrape' && r.files && r.files[bin]) {
          const f = r.files[bin]
          done({ count: (f.complete || 0) + (f.incomplete || 0), complete: f.complete || 0, incomplete: f.incomplete || 0 })
          return
        }
      } catch (e) { /* 忽略坏响应 */ }
      done(null)
    })
    ws.on('error', () => done(null))
    ws.on('close', () => done(null))
  })
}

// 刷新单个 infoHash 缓存（失败保留旧值）
async function refresh(infoHashHex) {
  const r = await scrape(infoHashHex)
  if (r) cache.set(infoHashHex, { count: r.count, complete: r.complete, incomplete: r.incomplete, ts: Date.now() })
  return r
}

function get(infoHashHex) {
  return cache.get(infoHashHex) || null
}

// 全量快照（供 /v1/stats 返回）
function snapshot() {
  const out = {}
  for (const [h, c] of cache) out[h] = { count: c.count, complete: c.complete, incomplete: c.incomplete, ts: c.ts }
  return out
}

module.exports = { scrape, refresh, get, snapshot, REFRESH_MS }
