// 用命令行客户端坐进一个房间，按局面出牌。房间号从参数进来。
import WebSocket from '../node_modules/ws/index.js'

const room = process.argv[2]
const name = process.argv[3] || '汐'
if (!room) {
  console.log('用法: node test/bot.mjs 1234 名字')
  process.exit(1)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ws = new WebSocket('ws://127.0.0.1:8899')
const me = { seat: null, state: null, err: null, phase: 'idle' }

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.type !== 'state') console.log('[收到]', m.type, m.message ?? m.room ?? '')
  if (m.type === 'joined') {
    me.seat = m.seat
    console.log(`坐进去了：${name} · seat ${me.seat} · 房间 ${m.room}`)
  }
  if (m.type === 'state') me.state = m.state
  if (m.type === 'error') me.err = m.message
  if (m.type === 'peerLeft') console.log('对面走了')
})

const act = async (action) => {
  me.err = null
  ws.send(JSON.stringify({ type: 'action', action }))
  // 出手之间留出看清的时间
  await wait(1500)
  return me.err
}

await new Promise((res) => ws.on('open', res))
ws.send(JSON.stringify({ type: 'join', room, name }))

const mine = () => me.state.seats[me.seat]
const foe = () => me.state.seats[1 - me.seat]

function pickTarget() {
  const theirs = foe().characters
  if (theirs.length === 0) return null
  return [...theirs].sort((a, b) => a.hp - b.hp)[0]
}

function pickHandToPlay() {
  const myChars = mine().characters
  if (myChars.length === 0) return null
  const weakest = [...myChars].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]
  const hand = mine().hand
  // 优先把人/入/熟牛肉这类喂给最虚的那个
  const priority = ['niurou', 'ren', 'shenghao', 'huangjiu', 'wandouhuang', 'ru', 'qianhong', 'zunni']
  for (const id of priority) {
    if (hand.includes(id)) return { cardId: id, targetId: weakest.uid }
  }
  return null
}

async function myTurn() {
  if (me.state.phase !== 'playing') return
  if (me.state.turnSeat !== me.seat) return

  // 1. 抽到的角色：读
  if (me.state.pending && !me.state.pending.hidden) {
    const err = await act({ type: 'acceptDraw' })
    if (err) console.log('读牌没成：', err)
  }

  // 2. 打一张手牌（留行动值打人）
  if (mine().ap >= 2) {
    const pick = pickHandToPlay()
    if (pick) {
      const err = await act({ type: 'playHand', ...pick })
      if (err) console.log('出牌没成：', err, pick.cardId)
    }
  }

  // 3. 普攻，打到对面最虚的
  for (let i = 0; i < 3; i += 1) {
    if (me.state.phase !== 'playing') break
    if (me.state.turnSeat !== me.seat) break
    const myChars = mine().characters
    const t = pickTarget()
    if (myChars.length === 0 || !t) break
    if (mine().ap < 1) break
    const attacker = [...myChars].sort((a, b) => b.attack - a.attack)[0]
    const err = await act({ type: 'attack', attackerId: attacker.uid, targetId: t.uid })
    if (err) { console.log('打不动：', err); break }
  }

  // 4. 还有行动值就放主动技
  if (me.state.phase === 'playing' && mine().ap >= 1) {
    const actor = mine().characters.find((c) => c.active && c.cd === 0)
    if (actor) {
      const err = await act({
        type: 'skill',
        actorId: actor.uid,
        targetId: mine().characters[0]?.uid,
        enemyTargetId: pickTarget()?.uid,
      })
      if (err) console.log('技能没放出来：', err)
    }
  }

  // 5. 收手
  if (me.state.phase === 'playing' && me.state.turnSeat === me.seat) {
    await act({ type: 'endTurn' })
  }
}

// 每 900ms 看一次，轮到自己就动
let busy = false
setInterval(async () => {
  if (busy || !me.state || me.seat === null) return
  if (me.state.phase === 'over') {
    const win = me.state.winner === me.seat
    console.log(win ? '这一局我赢了' : '这一局输了')
    me.state = null
    setTimeout(() => process.exit(0), 3000)
    return
  }
  if (me.state.turnSeat !== me.seat) return
  busy = true
  try { await myTurn() } finally { busy = false }
}, 900)

console.log('在房间里等着了')
