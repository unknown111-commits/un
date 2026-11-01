// 文学杀 · 联机服务
// 静态站点 + WebSocket 房间。服务端持有唯一的状态，前端只发意图、收快照。

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { loadCards, createGame, applyAction } from './game.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = resolve(here, 'public')
const PORT = Number(process.env.PORT || 8899)
const CARDS = loadCards(resolve(here, 'data/cards.json'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/api/cards') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(CARDS))
      return
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname
    const full = resolve(join(PUBLIC, file))
    if (!full.startsWith(PUBLIC) || !existsSync(full)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('没有这个文件')
      return
    }
    const body = await readFile(full)
    res.writeHead(200, {
      'content-type': MIME[extname(full)] ?? 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    })
    res.end(body)
  } catch (err) {
    if (!res.headersSent) res.writeHead(500)
    res.end('服务抽了一下')
    console.error('[http]', err.message)
  }
})

const wss = new WebSocketServer({ server })
const rooms = new Map()
const waiting = [] // 随机匹配的队列

/** 离线模式的对手：抽牌、打最虚的、有招就放，然后交回合 */
function maybeAi(room) {
  if (!room?.vsAi || !room.state || room.state.phase !== 'playing') return
  if (room.state.turnSeat !== 1) return
  const s = room.state
  try {
    if (s.pending && !s.pending.hidden) {
      applyAction(s, 1, { type: 'acceptDraw' }, CARDS)
    } else {
      const me = s.seats[1]
      const foe = s.seats[0]
      const hit = [...foe.characters].filter((c) => c.hp > 0).sort((a, b) => a.hp - b.hp)[0]
      const atk = [...me.characters].filter((c) => c.hp > 0).sort((a, b) => b.attack - a.attack)[0]
      let acted = false
      if (me.ap > 0 && atk && hit) {
        const r = applyAction(s, 1, { type: 'attack', attackerId: atk.uid, targetId: hit.uid }, CARDS)
        acted = !r?.error
      }
      if (!acted && me.ap > 0 && atk?.active && s.phase === 'playing') {
        const r = applyAction(s, 1, { type: 'skill', actorId: atk.uid, skillKey: atk.active.key, enemyTargetId: hit?.uid }, CARDS)
        acted = !r?.error
      }
      if (!acted) applyAction(s, 1, { type: 'endTurn' }, CARDS)
    }
  } catch (err) {
    console.error('[ai]', err.message)
  }
  broadcast(room)
  if (room.state?.phase === 'playing' && room.state.turnSeat === 1) {
    setTimeout(() => maybeAi(room), 1100)
  }
}

// 每 30 秒扫一遍：回收没人要的房间，掐掉没心跳的连接
setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    for (const p of [...room.players]) {
      // 心跳超时：掐断连接（close 事件里再走离开流程）
      if (p.ws.readyState === 1 && now - p.ws.lastSeen > 90_000) {
        p.ws.terminate()
      }
    }
    // 开局后两分钟还没凑齐人，或者所有人都断了 10 分钟：拆房
    const allGone = room.players.length === 0
    const allOffline = room.players.length > 0 && room.players.every((p) => p.ws.readyState !== 1)
    const staleEmpty = allGone && now - room.createdAt > 2 * 60_000
    const staleOffline = allOffline && now - room.lastActive > 10 * 60_000
    const gameOver = room.state?.phase === 'over' && now - room.lastActive > 10 * 60_000
    if (staleEmpty || staleOffline || gameOver) {
      rooms.delete(code)
      console.log(`[房间回收] ${code}`)
    }
  }
}, 30_000).unref()

function makeCode() {
  for (;;) {
    const code = String(Math.floor(1000 + Math.random() * 9000))
    if (!rooms.has(code)) return code
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.ws.readyState === 1) {
      send(p.ws, { type: 'state', room: room.code, seat: p.seat, state: publicState(room, p.seat) })
    }
  }
}

// 前端只看得见该看的：对手手牌数量而不是内容，引擎内部的卡表也不外发
function publicState(room, seatIndex) {
  const s = room.state
  if (!s) return null
  return {
    phase: s.phase,
    round: s.round,
    turnSeat: s.turnSeat,
    victory: s.victory,
    winner: s.winner,
    log: s.log,
    seats: s.seats.map((seat, i) => ({
      ...seat,
      hand: i === seatIndex ? seat.hand : seat.hand.map(() => 'hidden'),
      charPool: undefined,
      handPool: undefined,
      pendingDamage: i === seatIndex ? seat.pendingDamage : undefined,
    })),
    pending: seatIndex === s.turnSeat ? s.pending : (s.pending ? { hidden: true } : null),
  }
}

wss.on('connection', (ws) => {
  ws.roomCode = null
  ws.seat = null
  ws.lastSeen = Date.now()

  ws.on('message', (raw) => {
    ws.lastSeen = Date.now()
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }

    // 心跳：前端每 15 秒来一声，防着半死不断的连接
    if (msg.type === 'ping') return

    if (msg.type === 'create') {
      const code = makeCode()
      const room = { code, players: [], state: null, createdAt: Date.now(), lastActive: Date.now() }
      room.players.push({ ws, seat: 0, name: String(msg.name || '玩家一').slice(0, 12) })
      rooms.set(code, room)
      ws.roomCode = code
      ws.seat = 0
      // 单人模式：第二座位交给一个简单的 AI
      if (msg.solo) {
        room.vsAi = true
        room.players.push({ ws: null, seat: 1, name: '汐（离线）' })
        room.state = createGame({ players: room.players.map((p) => ({ name: p.name })), cards: CARDS })
        send(ws, { type: 'joined', room: code, seat: 0, cards: CARDS })
        broadcast(room)
        setTimeout(() => maybeAi(room), 1200)
        return
      }
      send(ws, { type: 'joined', room: code, seat: 0, cards: CARDS })
      return
    }

    // 随机匹配：进队列，凑到两个人就自动建房
    if (msg.type === 'queue') {
      const name = String(msg.name || '玩家').slice(0, 12)
      const i = waiting.findIndex((w) => w.ws.readyState !== 1)
      if (i >= 0) {
        const other = waiting.splice(i, 1)[0]
        const code = makeCode()
        const room = { code, players: [], state: null, createdAt: Date.now(), lastActive: Date.now() }
        room.players.push({ ws: other.ws, seat: 0, name: other.name })
        room.players.push({ ws, seat: 1, name })
        rooms.set(code, room)
        for (const p of room.players) {
          p.ws.roomCode = code
          p.ws.seat = p.seat
          send(p.ws, { type: 'joined', room: code, seat: p.seat, cards: CARDS })
        }
        room.state = createGame({ players: room.players.map((p) => ({ name: p.name })), cards: CARDS })
        broadcast(room)
        return
      }
      waiting.push({ ws, name })
      send(ws, { type: 'waiting' })
      return
    }

    if (msg.type === 'dequeue') {
      const i = waiting.findIndex((w) => w.ws === ws)
      if (i >= 0) waiting.splice(i, 1)
      return
    }

    if (msg.type === 'join') {
      const room = rooms.get(String(msg.room))
      if (!room) return send(ws, { type: 'error', message: '没有这个房间' })
      const name = String(msg.name || '玩家二').slice(0, 12)
      // 断线重连：同一个名字回来，就坐回原来的位置
      const ghost = room.players.find((p) => p.name === name && p.ws.readyState !== 1)
      if (ghost) {
        ghost.ws = ws
        ws.roomCode = room.code
        ws.seat = ghost.seat
        send(ws, { type: 'joined', room: room.code, seat: ghost.seat, cards: CARDS })
        broadcast(room)
        return
      }
      if (room.players.length >= 2) return send(ws, { type: 'error', message: '房间已经坐满了' })
      room.players.push({ ws, seat: 1, name })
      ws.roomCode = room.code
      ws.seat = 1
      room.state = createGame({ players: room.players.map((p) => ({ name: p.name })), cards: CARDS })
      send(ws, { type: 'joined', room: room.code, seat: 1, cards: CARDS })
      broadcast(room)
      return
    }

    const room = rooms.get(ws.roomCode)
    if (!room || !room.state) return
    room.lastActive = Date.now()

    if (msg.type === 'restart') {
      if (room.players.length < 2) return send(ws, { type: 'error', message: '对手还没进来' })
      room.state = createGame({ players: room.players.map((p) => ({ name: p.name })), cards: CARDS })
      broadcast(room)
      if (room.vsAi) setTimeout(() => maybeAi(room), 1200)
      return
    }

    if (msg.type === 'action') {
      let result
      try {
        result = applyAction(room.state, ws.seat, msg.action, CARDS)
      } catch (err) {
        console.error('[action 崩了]', err.message)
        result = { error: '这一手卡住了，再试一次' }
      }
      if (result?.error) send(ws, { type: 'error', message: result.error })
      broadcast(room)
      if (room.vsAi) setTimeout(() => maybeAi(room), 900)
    }
  })

  ws.on('close', () => {
    // 从匹配队列里拿掉
    const qi = waiting.findIndex((w) => w.ws === ws)
    if (qi >= 0) waiting.splice(qi, 1)
    const room = rooms.get(ws.roomCode)
    if (!room) return
    // 把断了的人从玩家列表拿掉（重连靠 ghost 匹配，只在没连上时才算离开）
    const me = room.players.find((p) => p.ws === ws)
    if (!me) return
    room.players = room.players.filter((p) => p.ws !== ws)
    room.lastActive = Date.now()
    if (room.players.length === 0) {
      // 不立刻拆：留两分钟等房主回来
    } else {
      for (const p of room.players) send(p.ws, { type: 'peerLeft' })
    }
  })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占着：多半是上一份服务还活着。先关掉旧的再起。`)
  } else {
    console.error('[服务]', err)
  }
  process.exit(1)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`文学杀 服务已起：http://127.0.0.1:${PORT}`)
})
