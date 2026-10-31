// 自动把一整局打完：两个机器人轮流行动，看能不能走到结束
import WebSocket from '../node_modules/ws/index.js'

const URL = 'ws://127.0.0.1:8899'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient(tag) {
  const ws = new WebSocket(URL)
  const c = { ws, tag, seat: null, room: null, state: null, err: null }
  c.open = new Promise((res) => ws.on('open', res))
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.type === 'joined') { c.seat = m.seat; c.room = m.room }
    if (m.type === 'state') { c.state = m.state; c.err = null }
    if (m.type === 'error') c.err = m.message
  })
  c.send = (m) => ws.send(JSON.stringify(m))
  c.act = async (action) => {
    c.err = null
    ws.send(JSON.stringify({ type: 'action', action }))
    await wait(140)
    return c.err
  }
  return c
}

const A = makeClient('甲')
const B = makeClient('乙')
await Promise.all([A.open, B.open])

A.send({ type: 'create', name: '甲' })
for (let i = 0; i < 50 && !A.room; i += 1) await wait(40)
B.send({ type: 'join', room: A.room, name: '乙' })
for (let i = 0; i < 50 && !B.state; i += 1) await wait(40)

console.log('房间', A.room, '| 甲 seat', A.seat, '| 乙 seat', B.seat)

const me = (c) => c.state.seats[c.seat]
const foe = (c) => c.state.seats[1 - c.seat]

/** 一个机器人的一回合：读牌、打分、出牌、普攻、结束 */
async function takeTurn(c) {
  const st = () => c.state
  if (st().phase === 'over') return 'over'

  // 1. 有牌就读
  if (st().pending && !st().pending.hidden) {
    await c.act({ type: 'acceptDraw' })
  }
  // 2. 手牌能打就打一张（省着行动值去打人）
  const seat = me(c)
  if (seat.hand.length > 0 && seat.ap >= 2) {
    const cardId = seat.hand[0]
    const target = seat.characters[0]?.uid
    await c.act({ type: 'playHand', cardId, targetId: target })
  }
  // 3. 普攻
  for (let i = 0; i < 3; i += 1) {
    const mine = me(c).characters
    const theirs = foe(c).characters
    if (mine.length === 0 || theirs.length === 0) break
    if (me(c).ap < 1) break
    const err = await c.act({ type: 'attack', attackerId: mine[0].uid, targetId: theirs[0].uid })
    if (err) break
    if (c.state.phase === 'over') return 'over'
  }
  // 4. 主动技（有余力就放）
  const actor = me(c).characters.find((x) => x.active && x.cd === 0)
  if (actor && me(c).ap >= 1) {
    await c.act({ type: 'skill', actorId: actor.uid, enemyTargetId: foe(c).characters[0]?.uid })
  }
  // 5. 收手
  await c.act({ type: 'endTurn' })
  return c.state.phase
}

let result = 'playing'
for (let round = 0; round < 60 && result === 'playing'; round += 1) {
  const turnSeat = A.state.turnSeat
  const who = turnSeat === A.seat ? A : B
  result = await takeTurn(who)
  if (result === 'over') break
  // 保险：如果回合还停在同一方（额外回合），再动一次
  if (A.state.turnSeat === who.seat && A.state.phase === 'playing') {
    await takeTurn(who)
  }
}

console.log('结束状态', A.state.phase, '胜者 seat', A.state.winner)
console.log('--- 最后 12 条日志 ---')
for (const line of (A.state.log ?? []).slice(0, 12)) console.log('·', line)
console.log('场上：甲', A.state.seats[0].characters.map((c) => `${c.name}(${c.hp})`))
console.log('场上：乙', A.state.seats[1].characters.map((c) => `${c.name}(${c.hp})`))
console.log('角色池剩余：甲', A.state.seats[0].charPool?.length ?? '隐藏', '乙', A.state.seats[1].charPool?.length ?? '隐藏')

A.ws.close()
B.ws.close()
