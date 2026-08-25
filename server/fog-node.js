/**
 * Fog 节点 —— 服务端 WebRTC DataChannel 文件服务
 *
 * 协议（来自 src/webrtc-downloader-bin.js / simple-RTC.js，已确认）：
 *  - 本节点是 WebRTC initiator：createDataChannel → 自动协商出 offer
 *  - 浏览器（RTCDownloader）是 answerer：makeCandidateArr 从 offer SDP 提取 a=candidate 行，
 *    因此必须等 ICE gathering complete 后把候选注入 offer SDP 再注册到信令服务器
 *  - 浏览器回 answer/candidate，由信令服务器转发过来
 *  - 浏览器请求消息（DC 上收到的 JSON 字符串）：
 *      {host, uri, action:"get", response_type:"binary", start, end}
 *    心跳：{action:"ping"}（忽略）
 *  - 响应协议：按 32KB 分块，每块 = [256 字节扁平 JSON 头][数据]
 *     首块头 {begin:true,start,end}（无数据，触发客户端清空缓冲）
 *     数据块头 {value:true,start,end}（start/end 为该块文件字节范围，256 头后是 32KB 数据）
 *     末块头 {done:true,start,end}（无数据，触发客户端拼接提交）
 *     —— 注意头必须是扁平 JSON（不能有嵌套对象，否则客户端 split('}')[0] 截断出错）
 */
const dc = require('node-datachannel')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const media = require('./media')

const BLOCK_LENGTH = 32 * 1024 // 与播放器 src/worker.js BLOCK_LENGTH 一致
const HEADER_LENGTH = 256 // 与播放器 webrtc-downloader-bin.js 的 256 字节头一致

class FogNode {
  /**
   * @param {object} opts
   * @param {string} opts.peerId   Fog 节点 peer_id（唯一）
   * @param {string} opts.host     注册用 host（= 播放器 urlObj.host，如 "127.0.0.1:8000"）
   * @param {string} opts.uri      注册用 uri（= 播放器 urlObj.path，如 "/demo.mp4"）
   * @param {object} opts.signaling createSignaling() 的返回值
   */
  constructor(opts) {
    this.peerId = opts.peerId
    this.host = opts.host
    this.uri = opts.uri
    this.signaling = opts.signaling
    this.pc = null
    this.dc = null
    this.candidates = []
    this.offer = null
    this.registered = false
  }

  start() {
    this.pc = new dc.PeerConnection('fog-' + this.peerId, { iceServers: [] })

    // 注意：必须先注册 PC 事件，再 createDataChannel
    // （node-datachannel 在 createDataChannel 时会同步触发自动协商，后注册会丢失 offer 回调）
    this.pc.onLocalCandidate((cand) => {
      console.log(`[fog] ${this.peerId} candidate:`, cand.slice(0, 60))
      if (cand.startsWith('a=candidate')) {
        this.candidates.push(cand)
        // 候选在 gathering=complete 后仍会异步到达：收到候选就重置注册计时器
        if (this.offer && !this.registered) this._scheduleRegister()
      }
    })
    this.pc.onLocalDescription((sdp, type) => {
      console.log(`[fog] ${this.peerId} onLocalDescription type=${type} len=${sdp.length}`)
      if (String(type).toLowerCase() === 'offer') this.offer = sdp
    })
    this.pc.onGatheringStateChange((s) => {
      console.log(`[fog] ${this.peerId} gathering=${s} offer=${!!this.offer} candidates=${this.candidates.length}`)
      if (s === 'complete' && this.offer && !this.registered) {
        this._scheduleRegister()
      }
    })

    // 服务端创建 DataChannel（label 与播放器 simple-RTC.js 的 'dataChannel' 一致）
    this.dc = this.pc.createDataChannel('dataChannel')
    this.dc.onOpen(() => console.log(`[fog] ${this.peerId} DC open (${this.host}${this.uri})`))
    this.dc.onClosed(() => console.log(`[fog] ${this.peerId} DC closed`))
    this.dc.onError((e) => console.error(`[fog] ${this.peerId} DC error:`, e))
    this.dc.onMessage((msg) => this._onDCMessage(msg))
  }

  /** 候选/收集完成后注册 offer（debounce，确保候选回调全部到达） */
  _scheduleRegister() {
    clearTimeout(this._regTimer)
    this._regTimer = setTimeout(() => {
      if (this.registered) return
      this.registered = true
      const offerWithCandidates = this._injectCandidates(this.offer)
      console.log(`[fog] ${this.peerId} 注册 offer（候选 ${this.candidates.length} 个）`)
      this.signaling.registerFog(
        this.peerId,
        this.host,
        this.uri,
        { type: 'offer', sdp: offerWithCandidates },
        (msg) => this._onSignal(msg)
      )
    }, 800)
  }

  /** 把 a=candidate 行追加到 offer SDP 末尾（浏览器 makeCandidateArr 需要） */
  _injectCandidates(sdp) {
    const candLines = this.candidates.filter((c) => c.startsWith('a=candidate'))
    if (candLines.length === 0) return sdp
    // 去掉 SDP 末尾空行，追加候选行
    return sdp.replace(/\r?\n$/, '') + '\r\n' + candLines.join('\r\n') + '\r\n'
  }

  /** 信令服务器转发的 answer / candidate */
  _onSignal(msg) {
    if (msg.action === 'answer' && msg.sdps && msg.sdps.sdp) {
      console.log(`[fog] ${this.peerId} 收到 answer`)
      try {
        this.pc.setRemoteDescription(msg.sdps.sdp, 'Answer')
      } catch (e) {
        console.error(`[fog] ${this.peerId} setRemoteDescription(answer) 失败:`, e.message)
      }
      return
    }
    if (msg.action === 'candidate' && msg.candidates) {
      const c = msg.candidates
      if (c.candidate && c.candidate !== 'completed') {
        try {
          this.pc.addRemoteCandidate(c.candidate, c.sdpMid || '0')
        } catch (e) {
          console.error(`[fog] ${this.peerId} addRemoteCandidate 失败:`, e.message)
        }
      }
      return
    }
  }

  /** DC 上收到的浏览器消息 */
  _onDCMessage(msg) {
    let req
    try {
      req = typeof msg === 'string' ? JSON.parse(msg) : JSON.parse(msg.toString())
    } catch (e) {
      return // 非 JSON 忽略
    }
    if (req.action === 'ping') return // 心跳
    if (req.action !== 'get') return

    const start = Number(req.start)
    const end = Number(req.end)
    if (!(Number.isFinite(start) && Number.isFinite(end)) || end < start) return

    // 用请求里的 uri 定位文件（与媒体 HTTP 服务同一套解析）
    const rel = media.resolveMediaPath(req.uri || this.uri)
    const info = rel ? media.statMedia(rel) : null
    if (!info) {
      console.error(`[fog] ${this.peerId} 文件不存在:`, req.uri)
      return
    }
    if (start >= info.size) return

    const realEnd = Math.min(end, info.size - 1)
    console.log(`[fog] ${this.peerId} get ${rel} bytes=${start}-${realEnd}`)
    this._sendRange(info.fullPath, start, realEnd)
  }

  /** 按 32KB 块 + 256 字节头发送 [start, end] */
  _sendRange(fullPath, start, end) {
    for (const p of buildPackets(fullPath, start, end)) {
      if (p.data) {
        this.dc.sendMessageBinary(Buffer.concat([p.header, p.data]))
      } else {
        this.dc.sendMessageBinary(p.header)
      }
    }
  }

  close() {
    try {
      if (this.dc) this.dc.close()
      if (this.pc) this.pc.close()
    } catch (e) {
      /* ignore */
    }
  }
}

/** 构造 256 字节扁平 JSON 头（空格填充） */
function header(obj) {
  const json = JSON.stringify(obj)
  const buf = Buffer.alloc(HEADER_LENGTH, 0x20) // 空格填充到 256 字节
  buf.write(json, 0, 'utf8')
  return buf
}

/**
 * 生成发送 [start, end] 文件片段的完整消息包序列：
 *   [{header, data?}] —— 首块 begin（无数据）、中间 value 块、末块 done（无数据）
 * 供 _sendRange 发送，也可被协议测试直接验证。
 */
function buildPackets(fullPath, start, end) {
  const packets = []
  const fd = fs.openSync(fullPath, 'r')

  // 首块：begin 头（触发客户端 chunkStore 清空）
  packets.push({ header: header({ begin: true, start, end }), data: null })

  let pos = start
  while (pos <= end) {
    const chunkEnd = Math.min(pos + BLOCK_LENGTH - 1, end)
    const len = chunkEnd - pos + 1
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, pos)
    packets.push({ header: header({ value: true, start: pos, end: chunkEnd }), data: buf })
    pos = chunkEnd + 1
  }

  // 末块：done 头（触发客户端拼接提交）
  packets.push({ header: header({ done: true, start, end }), data: null })
  fs.closeSync(fd)
  return packets
}

/**
 * 为 media 目录下的每个媒体文件创建 fogCount 个 Fog 节点并注册。
 * @param {object} signaling
 * @param {number} fogCount 每个媒体几个 Fog 节点
 */
function startFogNodes(signaling, fogCount) {
  const host = config.sourceHostWithPort
  const created = []
  let files = []
  try {
    files = fs.readdirSync(config.mediaRoot).filter((f) => {
      const full = path.join(config.mediaRoot, f)
      return fs.statSync(full).isFile() && f.toLowerCase().endsWith('.mp4')
    })
  } catch (e) {
    console.error('[fog] 读取媒体目录失败:', e.message)
    return created
  }

  for (const file of files) {
    const uri = '/' + file
    for (let i = 0; i < fogCount; i++) {
      const node = new FogNode({
        peerId: `fog-${file}-${i}-${Math.random().toString(16).slice(2, 8)}`,
        host,
        uri,
        signaling
      })
      node.start()
      created.push(node)
    }
    console.log(`[fog] 已为 ${file} 启动 ${fogCount} 个 Fog 节点`)
  }
  return created
}

module.exports = { FogNode, startFogNodes, buildPackets, header, HEADER_LENGTH, BLOCK_LENGTH }
