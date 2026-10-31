// 更完整的一轮：阅读、打手牌、主动技、攻击
import WebSocket from '../node_modules/ws/index.js'

const URL = 'ws://127.0.0.1:8899'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function client() {
  const ws = new WebSocket(URL)
  const inbox = []
  ws.on('message', (raw) => inbox.push(JSON.parse(String(raw))))
  const open = new Promise((res) => ws.on('open', res))
  return {
    ws,
    open,
    async last(type, timeout = 3000) {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        const f = [...inbox].reverse().find((m) => m.type === type)
        if (f) return f
        await wait(40)
      }
      return null
    },
    clear: () => (inbox.length = 0),
    send: (m) => ws.send(JSON.stringify(m)),
    act: async (action) => {
      ws.send(JSON.stringify({ type: 'action', action }))
      await wait(150)
      return [...inbox].reverse().find((m) => m.type === 'state' || m.type === 'error')
    },
  }
}

const A = client()
const B = client()
await Promise.all([A.open, B.open])

A.send({ type: 'create', name: '甲' })
const room = (await A.last('joined')).room
B.send({ type: 'join', room, name: '乙' })
await B.last('joined')
let snap = await A.last('state')
const cards = (await A.last('joined'))?.cards ?? null

// 甲：阅读
let r = await A.act({ type: 'acceptDraw' })
console.log('阅读 ->', r.message ?? 'ok')
// 甲：打一张手牌
snap = await A.last('state')
const myHand = snap.state.seats[snap.seat].hand
console.log('手牌', myHand.slice(0, 5))
for (const id of myHand) {
  const res = await A.act({ type: 'playHand', cardId: id })
  if (!res.message) {
    console.log('打出成功', id)
    break
  }
  console.log('打不动', id, res.message)
}
// 甲：发动主动技（如果有）
snap = await A.last('state')
const mine = snap.state.seats[snap.seat]
const withSkill = mine.characters.find((c) => c.active)
if (withSkill) {
  const res = await A.act({ type: 'skill', actorId: withSkill.uid })
  console.log('主动技', withSkill.name, '->', res.message ?? 'ok')
}
// 换手给乙
await A.act({ type: 'endTurn' })
snap = await B.last('state')
console.log('轮到谁', snap.state.turnSeat === snap.seat ? '乙' : '甲')
await B.act({ type: 'acceptDraw' })
snap = await B.last('state')
// 乙场上有了角色，换回甲去攻击
await B.act({ type: 'endTurn' })
snap = await A.last('state')
const aSeat = snap.state.seats[snap.seat]
const bSeat = snap.state.seats[1 - snap.seat]
if (aSeat.characters.length && bSeat.characters.length) {
  const res = await A.act({
    type: 'attack',
    attackerId: aSeat.characters[0].uid,
    targetId: bSeat.characters[0].uid,
  })
  console.log('攻击 ->', res.message ?? 'ok')
}

snap = await A.last('state')
console.log('--- 日志 ---')
for (const line of snap.state.log.slice(0, 10)) console.log('·', line)

A.ws.close()
B.ws.close()
