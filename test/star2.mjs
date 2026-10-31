// 复现：上一回合返还过，下一回合抽到的角色应该还是一星
import { loadCards, createGame, applyAction } from '../game.js'

const path = new URL('../data/cards.json', import.meta.url).pathname.replace(/^\//, '')
const cards = loadCards(decodeURIComponent(path))
const g = createGame({ players: [{ name: '甲' }, { name: '乙' }], cards })

const s0 = g.seats[0]
console.log('回合1 甲 抽到', g.pending?.name, '★', g.pending?.starRank, '| starBonus', s0.starBonus)

let r = applyAction(g, 0, { type: 'reroll' }, cards)
console.log('返还 ->', r.error ?? 'ok', '| starBonus', s0.starBonus)
console.log('返还后抽到', g.pending?.name, '★', g.pending?.starRank)

applyAction(g, 0, { type: 'acceptDraw' }, cards)
console.log('上场后 starBonus', s0.starBonus, '| 手牌', s0.hand.length)

applyAction(g, 0, { type: 'endTurn' }, cards)
console.log('换手后 turnSeat', g.turnSeat, '| 甲 starBonus', s0.starBonus)

applyAction(g, 1, { type: 'acceptDraw' }, cards)
applyAction(g, 1, { type: 'endTurn' }, cards)

console.log('回到甲，turnSeat', g.turnSeat)
console.log('甲 这回合抽到', g.pending?.name, '★', g.pending?.starRank, '（应当是 1）', '| starBonus', s0.starBonus)
