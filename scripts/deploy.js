/**
 * 部署脚本：把 server/public + dist/pear-player.js + server/torrents 同步到 deploy/p2p_mp4/
 * （GitHub Pages 部署包）。前端页面已按 location.hostname 自适应本地/外网，无需注入 backend。
 * 用法: npm run deploy
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC_PUBLIC = path.join(ROOT, 'server', 'public')
const SRC_DIST = path.join(ROOT, 'dist', 'pear-player.js')
const SRC_TORRENTS = path.join(ROOT, 'server', 'torrents')
const DEST = path.join(ROOT, 'deploy', 'p2p_mp4')

const STATIC = ['index.html', 'test.html', 'metadata.html', 'seed.html', 'webtorrent.min.js']

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  console.log('  →', path.relative(ROOT, dest))
}

console.log('部署 p2p_mp4（GitHub Pages）:')
// 1. 前端页面
for (const f of STATIC) {
  const src = path.join(SRC_PUBLIC, f)
  if (!fs.existsSync(src)) {
    console.warn('  ⚠ 缺失:', path.relative(ROOT, src))
    continue
  }
  copyFile(src, path.join(DEST, f))
}
// 2. 播放器构建产物
copyFile(SRC_DIST, path.join(DEST, 'pear-player.js'))
// 3. 种子文件（排除 .bak 备份）
if (fs.existsSync(SRC_TORRENTS)) {
  for (const f of fs.readdirSync(SRC_TORRENTS)) {
    if (f.endsWith('.torrent') && !f.endsWith('.bak.torrent')) copyFile(path.join(SRC_TORRENTS, f), path.join(DEST, 'torrents', f))
  }
}
console.log('完成 ✅ 现在可 git add deploy/p2p_mp4 && git push 到 GitHub Pages 分支')
