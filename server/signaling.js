/**
 * WebSocket 信令服务器
 *
 * 协议确认（src/worker.js _pearSignalHandshake / initDC / simple-RTC.js）：
 *
 * 浏览器端行为：
 *  1) 连接后发送 {action:"get", peer_id, host, uri, md5}，md5=md5(host+uri)
 *  2) 收到 {nodes:[{peer_id, offer_id, sdp:{type,sdp}, errorcode?}]}：
 *     - makeCandidateArr(offer.sdp.sdp) 提取 a=candidate 行缓存到 candidateMap
 *     - 把 offer.sdp 里的 a=candidate 行剥掉，交给 simpleRTC.signal()（非 initiator，收 offer 回 answer）
 *  3) 收到 {action:"candidate", peer_id, candidates:{type:"end"}}：
 *     - 把 candidateMap[peer_id] 里缓存的候选一次性 addIceCandidate
 *  4) 回 answer：{peer_id, to_peer_id, offer_id, action:"answer", sdps:{type,sdp}}
 *  5) 发 candidate：{peer_id, to_peer_id, offer_id, action:"candidate", candidates:{...}}
 *
 * 服务器职责：
 *  - 维护 (host,uri) 房间
 *  - 把 Fog 节点（服务端 WebRTC offerer）注册的 offer 分发给 get 请求方
 *  - 把 answer/candidate 转发回 offerer（Fog 节点或浏览器）
 */
const crypto = require('crypto')

/**
 * @param {import('ws').WebSocketServer} wss
 */
function createSignaling(wss) {
  // ws 连接 → 会话信息
  const wsSessions = new Map()

  // 已注册的 offer：key = `${host}|${uri}`，value = [{ offererId, offerId, sdp }]
  const offerRooms = new Map()

  // offererId → 转发目标。Fog 节点通过 registerFog 注册（内存回调）；浏览器通过 ws 连接
  const fogForwarders = new Map() // offererId -> (msg) => void

  function roomKey(host, uri) {
    return `${host}|${uri}`
  }

  function sendToWs(ws, obj) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj))
      } catch (e) {
        /* 忽略单个发送失败 */
      }
    }
  }

  function forwardTo(offererId, msg) {
    const fn = fogForwarders.get(offererId)
    if (fn) {
      fn(msg)
      return true
    }
    // 也可能是浏览器 offerer（本实现中浏览器不是 initiator，不会出现）
    for (const [ws, s] of wsSessions.entries()) {
      if (s.peer_id === offererId) {
        sendToWs(ws, msg)
        return true
      }
    }
    return false
  }

  function handleMessage(ws, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch (e) {
      return
    }

    if (msg.action === 'get') {
      const peer_id = msg.peer_id
      const host = msg.host
      const uri = msg.uri
      wsSessions.set(ws, { peer_id, host, uri, md5: msg.md5 })

      const key = roomKey(host, uri)
      const offers = offerRooms.get(key) || []
      // 只返回给对方（不把请求者自己的 offer 返回）
      const nodes = offers
        .filter((o) => o.offererId !== peer_id)
        .map((o) => ({
          peer_id: o.offererId,
          offer_id: o.offerId,
          sdp: o.sdp,
          errorcode: undefined
        }))

      sendToWs(ws, { nodes })

      // 协议要求：每个 offer 之后要发一条 "end" 候选触发信号，浏览器才 addIceCandidate
      for (const o of offers) {
        if (o.offererId !== peer_id) {
          sendToWs(ws, { action: 'candidate', peer_id: o.offererId, candidates: { type: 'end' } })
        }
      }
      return
    }

    if (msg.action === 'answer') {
      // 转发给 offerer
      forwardTo(msg.to_peer_id, msg)
      return
    }

    if (msg.action === 'candidate') {
      // 转发给 offerer
      forwardTo(msg.to_peer_id, msg)
      return
    }

    // 未知 action 忽略
  }

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      handleMessage(ws, data.toString())
    })
    ws.on('close', () => {
      wsSessions.delete(ws)
    })
    ws.on('error', () => {
      wsSessions.delete(ws)
    })
  })

  /**
   * Fog 节点注册：为该 (host, uri) 提供一个可被分发给浏览器的 offer。
   * @param {string} offererId   Fog 节点的 peer_id
   * @param {string} host
   * @param {string} uri
   * @param {object} sdp         {type:"offer", sdp:"..."}（须含 a=candidate 行）
   * @param {(msg:object)=>void} onSignal  接收 answer / candidate 的回调
   * @returns {string} offerId
   */
  function registerFog(offererId, host, uri, sdp, onSignal) {
    const offerId = crypto.randomBytes(8).toString('hex')
    const key = roomKey(host, uri)
    if (!offerRooms.has(key)) offerRooms.set(key, [])
    offerRooms.get(key).push({ offererId, offerId, sdp })
    fogForwarders.set(offererId, onSignal)
    return offerId
  }

  function unregisterFog(offererId, host, uri) {
    const key = roomKey(host, uri)
    const arr = offerRooms.get(key)
    if (arr) {
      offerRooms.set(
        key,
        arr.filter((o) => o.offererId !== offererId)
      )
    }
    fogForwarders.delete(offererId)
  }

  return { registerFog, unregisterFog, roomKey }
}

module.exports = { createSignaling }
