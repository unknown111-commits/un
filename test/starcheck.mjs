// 检查：不返还的情况下，会不会因为场上已有同名角色而抽到高星
import { loadCards, createGame, applyAction } from '../game.js'

const path = new URL('../data/cards.json', import.meta.url).pathname.replace(/^\//, '')
const cards = loadCards(decodeURIComponent(path))
const g = createGame({ players: [{ name: '甲' }, { name: '乙' }], cards })

let stars = []
let dupCases = []

for (let i = 0; i < 40; i += 1) {
  const seat = g.seats[g.turnSeat]
  const p = g.pending
  if (p) {
    // 场上是否已有同名
    const onField = seat.characters.map((c) => c.name)
    if (onField.includes(p.name)) dupCases.push(`${p.name} ★${p.starRank}（场上已有同名）`)
    stars.push(p.starRank)
    applyAction(g, g.turnSeat, { type: 'acceptDraw' }, cards)
  }
  applyAction(g, g.turnSeat, { type: 'endTurn' }, cards)
  // 场上最多四个，满了就不读，免得卡住
  for (const s of g.seats) {
    if (s.characters.length >= 4) s.characters = s.characters.slice(0, 3)
  }
  if (g.phase === 'over') break
}

console.log('共抽牌', stars.length, '次')
console.log('星级分布', stars.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}))
console.log('场上已有同名还抽到的情况：', dupCases.length ? dupCases : '一次都没有')
