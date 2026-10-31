// 手牌洗回卡池的检查
import { loadCards, createGame, applyAction } from '../game.js'

const cards = loadCards(new URL('../data/cards.json', import.meta.url).pathname.replace(/^\//, ''))
const g = createGame({ players: [{ name: '甲' }, { name: '乙' }], cards })

const seat = g.seats[0]
const before = seat.handPool.length
const cardId = seat.hand[0]
const played = cards.handcards.find((c) => c.id === cardId)

const r = applyAction(g, 0, { type: 'playHand', cardId }, cards)
console.log('打出结果', r, '打的是', played?.name, 'once=', played?.once ?? false)
console.log('池子：打之前', before, '打之后', seat.handPool.length)
console.log('手里还剩', seat.hand.length, '行动值', seat.ap, '剩余手牌额度', seat.handCredits)
console.log(seat.handPool.length > before - 1 ? '已洗回卡池 ✓' : '没有洗回 ✗')
