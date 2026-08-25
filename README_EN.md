# PearPlayer External-Video Web Player (HTTP + P2P dual-channel)

Give any **HTTP video URL + magnet hash**, and a browser user opens one page to play via **HTTP direct + WebRTC P2P dual channels**, auto-seeding after download. All data is shared between user clients; the server only registers videos, generates/hosts `.torrent` files, and coordinates the tracker.

A second development based on [PearPlayer.js](https://github.com/PearInc/PearPlayer.js) (MIT): fixed 5 player bugs, added the "external URL + magnet" secondary scheme, and a self-built Node backend.

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │                Browser (client)             │
                    │  ┌─────────┐   ┌────────────────────────┐   │
                    │  │ <video> │◄──┤ MSE multi-source player │   │
                    │  └─────────┘   └──────────┬─────────────┘   │
                    │                           │                 │
        HTTP path ──┼── direct external CDN ◄───┤                 │
        P2P path  ──┼── WebRTC (WebTorrent) ◄───┘                 │
                    └───────────┬────────────────────────┬────────┘
                                │ register/API/torrent   │ announce/peers
                    ┌───────────▼──────────┐   ┌─────────▼─────────┐
                    │  Node backend        │   │  Tracker (wt)     │
                    │  register/API/host   │   │  peer discovery   │
                    └───────────────────────┘   └───────────────────┘
```

- **HTTP path**: `<video>` connects the external URL directly (cross-origin, no media proxy)
- **P2P path**: WebTorrent (browser WebRTC), peers discovered via tracker, blocks shared between users
- **The server never uploads video data**, only a few KB of `.torrent` / magnet / node info

---

## Quick Start (local)

```powershell
cd server
$env:PEAR_FOG_COUNT='0'; node index.js
```

Open the test bench (recommended entry):

```
http://127.0.0.1:8000/test.html
```

It is pre-filled with the kaltura 100MB video by default — click "Register → Play" to see HTTP + P2P working together.

Or open the player page directly:

```
http://127.0.0.1:8000/?url=<external>&magnet=<magnet>&torrent=<.torrent URL>&tracker=<tracker server>
```

All four params are optional; the backend fills them in via API (`magnetURI` / `torrentUrl` / `trackers`).

### Player params (`?` query string)

| Param | Description | Required |
|:--|:--|:--:|
| `url` | HTTP video URL | ✅ |
| `magnet` | magnet link (btih), P2P channel | ⚠️ else HTTP-only |
| `torrent` | `.torrent` direct URL (instant bootstrap, no metadata exchange wait) | optional |
| `tracker` | tracker server, **comma-separated for multiple** (API `trackers` takes priority) | optional |

---

## Backend API

| Route | Method | Purpose |
|:--|:--|:--|
| `/v1/videos` | POST | register `{url, magnet?, torrentUrl?, name?}`, returns `magnetURI/torrentUrl/trackers/hasTorrent/metaSource` |
| `/v1/videos?url=` | GET | query by url |
| `/v1/videos` | GET | list all registered videos |
| `/v1/customer/nodes` | GET | node API (PearPlayer protocol): size + HTTP node + WebTorrent magnet node |
| `/boot/{name}.torrent` | GET | hosted `.torrent` for players / bootstrap pages |
| `/v1/stats` | POST/GET | stats report / aggregate (API-driven panel) |
| `/proxy/{id}` | GET | secondary scheme: origin-fetch HTTP proxy (Range supported) |
| `/` `/test.html` `/metadata.html` `/seed.html` | GET | player / test bench / metadata bootstrap / seed page |

### `.torrent` bootstrap (reliability order)

```
① local .torrent (torrents/)                    → metaSource: local
② magnet xs= link or registered torrentUrl      → download + verify infoHash → metaSource: xs
③ otherwise → fetch metadata from peers         → metaSource: downloadmeta (best effort)
   on success, host to torrents/ → /boot/{name}.torrent available
```

---

## Directory

```
pearplayer/
├─ server/                       # ← backend (Node)
│  ├─ index.js                   # entry: HTTP 8000 + WS 8001 + routes
│  ├─ config.js                  # ports / media / tracker / nodes / PEAR_* config
│  ├─ video-service.js           # video register (url+magnet), HEAD size, .torrent host/bootstrap
│  ├─ nodes-api.js               # node API (magnet/size)
│  ├─ http-media.js              # media service + origin proxy proxyRequest
│  ├─ media.js                   # media path resolution (strip {host:port})
│  ├─ torrent-service.js         # torrent generate/cache (when source exists)
│  ├─ gen-torrent.js             # CLI to generate .torrent + magnet
│  ├─ signaling.js / fog-node.js # Fog signaling (not needed for secondary scheme)
│  ├─ metadata-node.js           # Node metadata bootstrap (Node↔browser caveat; prefer browser)
│  ├─ nginx-pear.conf            # production nginx reverse proxy sample (TLS + /tracker)
│  ├─ media/  torrents/  public/ # local sources / hosted .torrents / static pages
├─ src/                          # ← player source (browserify → dist/pear-player.js)
│  ├─ worker.js                  # WebTorrent: magnet / .torrent URL + uploadspeed
│  ├─ dispatcher.js              # multi-source scheduling + bitfield sync (seeding key)
│  ├─ simple-RTC.js / piece-validator.js / http-downloader.js ...
├─ index.player.js               # player entry (window.PearConfig)
├─ dist/pear-player.js           # built bundle (npm run build-player)
└─ docs/web-p2p-solution.md      # full solution doc (frontend/backend/sequence/reliability/tests)
```

### Static pages (`server/public/`)

| Page | Purpose |
|:--|:--|
| `index.html` | player: stats panel + `?url=&magnet=&torrent=&tracker=` auto-register/play |
| `test.html` | **test bench**: register / bootstrap source / node API / iframe play |
| `metadata.html` | browser metadata bootstrap (fallback when no `.torrent`) |
| `seed.html` | browser seeding page (can be merged into player) |
| `webtorrent.min.js` | WebTorrent browser bundle |

---

## Build

```powershell
npm run build-player          # rebuild player after editing src/*.js → dist/pear-player.js
```

Backend needs no build, run `node index.js` directly.

---

## Measured Results (browser)

| Test | Video | Result |
|:--|:--|:--|
| Multi-user P2P (kaltura external) | 100MB | P2P 94.8% (182/192 blocks) |
| Secondary scheme (bbb + magnet) | 30MB | P2P 96.8% (60/62 blocks) |
| Pure user-side P2P (no seed page) | 100MB | user 1 seeds → user 2 P2P 95.8% |
| Full params (url+magnet+torrent+tracker) | 100MB | P2P 97.4% (184/189 blocks) |

---

## License

MIT. Player part Copyright (c) [Pear Limited](https://pear.hk); this solution is a second development.
