/**
 * 媒体目录管理
 *
 * 播放器节点 uri 形如：{protocol}://{host}:{port}/{视频host}{视频path}
 * 例如视频 src = http://127.0.0.1:8000/media/demo.mp4，则节点 uri =
 *   http://127.0.0.1:8000/127.0.0.1:8000/media/demo.mp4
 *
 * 因此 HTTP 服务收到的路径 = "/" + {视频host} + {视频path}。
 * 这里把 "/{视频host}" 前缀剥掉，剩下 {视频path} 再映射到 mediaRoot 下的文件。
 */
const fs = require('fs')
const path = require('path')
const config = require('./config')

/** 解析请求路径为媒体文件（相对 mediaRoot 的路径）。失败返回 null */
function resolveMediaPath(requestPath) {
  if (typeof requestPath !== 'string') return null

  let rest = requestPath

  // 节点 uri 形如 "/{host:port}/media/demo.mp4"，剥掉 "/{host:port}" 前缀
  // （播放器 node uri = protocol://host:port/{urlObj.host}{urlObj.path}，urlObj.host 带端口）
  const prefixes = ['/' + config.sourceHostWithPort, '/' + config.sourceHost]
  for (const p of prefixes) {
    if (rest.indexOf(p) === 0) {
      rest = rest.slice(p.length)
      break
    }
  }

  // rest 现在形如 "/media/demo.mp4"
  if (!rest || rest === '/') return null

  // 防目录穿越
  const rel = path.normalize(rest).replace(/^([/\\])+/, '')
  if (rel.indexOf('..') === 0 || path.isAbsolute(rel)) return null

  return rel
}

/** 检查文件是否存在并返回统计信息 */
function statMedia(relPath) {
  const full = path.join(config.mediaRoot, relPath)
  try {
    const st = fs.statSync(full)
    if (!st.isFile()) return null
    return { size: st.size, fullPath: full, relPath }
  } catch (e) {
    return null
  }
}

module.exports = { resolveMediaPath, statMedia }
