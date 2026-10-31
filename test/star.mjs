// 星级：初始一星、返还重抽一次升一星、三星封顶
import { loadCards, createGame, applyAction } from '../game.js'

const path = new URL('../data/cards.json', import.meta.url).pathname.replace(/^\//, '')
const cards = loadCards(decodeURIComponent(path))
const g = createGame({ players: [{ name: '甲' }, { name: '乙' }], cards })

const seat = g.seats[0]
console.log('抽到的角色', g.pending?.name, '星级', g.pending?.starRank)

let r = applyAction(g, 0, { type: 'reroll' }, cards)
console.log('返还 ->', r.error ?? 'ok')
console.log('重抽后', g.pending?.name, '星级', g.pending?.starRank)

r = applyAction(g, 0, { type: 'reroll' }, cards)
console.log('同回合再返还 ->', r.error ?? 'ok（应当被拦住）')

const r2 = applyAction(g, 0, { type: 'acceptDraw' }, cards)
console.log('阅读 ->', r2.error ?? 'ok', '场上星级', seat.characters.map((c) => `${c.name}★${c.starRank}`))
