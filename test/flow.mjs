// 端到端冒烟测试：两个客户端把一局的开头走一遍
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
        const found = [...inbox].reverse().find((m) => m.type === type)
        if (found) return found
        await wait(50)
      }
      return null
    },
    clear: () => (inbox.length = 0),
    send: (m) => ws.send(JSON.stringify(m)),
  }
}

const A = client()
const B = client()
await Promise.all([A.open, B.open])

A.send({ type: 'create', name: '甲' })
const joinedA = await A.last('joined')
console.log('房间号', joinedA?.room)
const room = joinedA.room

B.send({ type: 'join', room, name: '乙' })
const joinedB = await B.last('joined')
console.log('乙落座 seat', joinedB?.seat)

const stA = await A.last('state')
console.log('A 看到座位数', stA?.state?.seats?.length, '回合', stA?.state?.turnSeat)
console.log('A 待读角色', stA?.state?.pending?.name ?? '(无)')
console.log('A 手牌', stA?.state?.seats?.[stA.seat]?.hand?.length)
console.log('B 手牌(应为隐藏)', stA?.state?.seats?.[1 - stA.seat]?.hand)

A.clear()
A.send({ type: 'action', action: { type: 'acceptDraw' } })
const afterRead = await A.last('state')
const mine = afterRead.state.seats[afterRead.seat]
console.log('阅读后 A 场上', mine.characters.map((c) => c.name))
console.log('阅读后 A 行动值', mine.ap)

A.clear()
A.send({ type: 'action', action: { type: 'endTurn' } })
await wait(200)
const stB = [...(await (async () => { const list = []; const t0 = Date.now(); while (Date.now() - t0 < 2000) { list.push(await B.last('state')); break } return list })())]
const lastB = await B.last('state')
console.log('换手后回合', lastB?.state?.turnSeat)
console.log('B 这一轮的待读', lastB?.state?.pending?.name ?? '(无)')
console.log('日志前三条', lastB?.state?.log?.slice(-3))

A.ws.close()
B.ws.close()
console.log('冒烟测试结束')
