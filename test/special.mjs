// 检查：特殊卡不进牌堆；星级到了才发到手牌
import { loadCards, createGame, applyAction } from '../game.js'

const path = new URL('../data/cards.json', import.meta.url).pathname.replace(/^\//, '')
const cards = loadCards(decodeURIComponent(path))
const special = new Set(cards.handcards.filter((c) => c.type === '特殊').map((c) => c.id))

const g = createGame({ players: [{ name: '甲' }, { name: '乙' }], cards })
const s0 = g.seats[0]
const leaks = s0.handPool.filter((id) => special.has(id))
console.log('牌堆张数', s0.handPool.length, '| 混进牌堆的特殊卡', leaks.length ? leaks : '没有')

// 手动塞一个三星的宫泽贤治，看会不会发「要求多多的餐厅」
const card = cards.characters.find((c) => c.id === 'miyazawa')
g.pending = {
  ...card,
  cardId: card.id,
  uid: 'test',
  hp: card.hp,
  maxHp: card.hp,
  starRank: 3,
  traits: [],
  statuses: [],
  cd: 0,
  attack: card.attack,
}
const r = applyAction(g, 0, { type: 'acceptDraw' }, cards)
console.log('三星上场 ->', r.error ?? 'ok')
console.log('手牌里有无「要求多多的餐厅」：', s0.hand.includes('yaoqiu') ? '有' : '没有（应当没有）')
console.log('卡池里有无「要求多多的餐厅」：', s0.handPool.includes('yaoqiu') ? '有' : '没有')
