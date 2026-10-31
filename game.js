// 文学杀 · 规则引擎（服务端权威）
// 规则来自《游戏规则.docx》，卡池来自《角色.docx》《卡：.doc》。
// 目标：一副能完整打完的版本。规则文档没写的几处，取了下限默认，标在 DEFAULTS 里。

import { readFileSync } from 'node:fs'

export function loadCards(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return {
    characters: raw.characters ?? [],
    handcards: raw.handcards ?? [],
    victoryConditions: raw.victoryConditions ?? {},
  }
}

/** 规则文档没写的，先按这组默认走，随时可改 */
export const DEFAULTS = {
  shieldPerTrait: 100,   // 每点适性 = 100 点护盾，伤害先扣盾
  startHand: 3,          // 起手手牌
  realDamageRatio: 0.8,  // 普攻造成攻击力 80% 的现实伤害
}

let uidSeq = 0
const nextUid = () => `u${++uidSeq}`

const HAND_PER_AP = 3
const AP_CAP = 12
const AP_PER_TURN = 3
const MAX_READ = 4
const DEBUFFS = new Set(['易伤100', '攻-100', '嘲讽', '饥饿'])

const pickLevel = () => {
  const r = Math.random()
  if (r < 0.6) return 3
  if (r < 0.95) return 4
  return 5
}

function makeCharacter(card, starRank = 1) {
  const hp = Number(card.hp ?? card.level * 100)
  const traits = Array.isArray(card.traits) ? [...card.traits] : []
  const rank = Math.min(3, Math.max(1, starRank))
  const ch = {
    uid: nextUid(),
    cardId: card.id,
    name: card.name,
    title: card.title ?? '',
    level: card.level,
    attack: Number(card.attack ?? 0),
    baseAttack: Number(card.attack ?? 0),
    traits,
    active: card.active ?? null,
    passive: card.passive ?? null,
    extra: Array.isArray(card.extra) ? [...card.extra] : [],
    stars: Array.isArray(card.stars) ? [...card.stars] : [],
    isPhilosopher: Boolean(card.isPhilosopher),
    hp,
    maxHp: hp,
    shield: traits.length * DEFAULTS.shieldPerTrait,
    shieldMax: traits.length * DEFAULTS.shieldPerTrait,
    cd: 0,
    statuses: [],
    tricks: [],
    starRank: rank,
    starDamage: 0,   // 星级带来的固定加成
    healBonus: 0,
  }
  // 星级效果：先接数值那几条
  if (card.id === 'dickens' && rank >= 1) ch.starDamage = 100        // 所有现实伤害加 100
  if (card.id === 'murakami' && rank >= 1) ch.healBonus = 100        // 治疗量上升 100
  if (card.id === 'shitietesheng' && rank >= 1) ch.friendship = true // 友谊
  // 余华：锋利 / 共情 / 文学阶段
  if (card.id === 'yuhua') {
    ch.sharp = 0
    ch.empathy = 0
    ch.phase = 'early'          // 前期
    ch.turnsOnField = 0
    ch.sharpCap = rank >= 1 ? 8 : 8
  }
  // 舒尔茨：人偶次数
  if (card.id === 'schulz') ch.dolls = 5
  // 普鲁斯特：追忆
  if (card.id === 'proust') {
    ch.turnsOnField = 0
    ch.noSingleTarget = false
  }
  return ch
}

/** 特殊卡不进普通牌堆：角色到达某星级才发到手牌里（按角色星级效果那条「加入手牌」） */
const STAR_GRANTS = {
  murakami: { 3: ['shijie'] },
  moyan: { 2: ['wa'] },
  hemingway: { 2: ['bubu'] },
  miyazawa: { 1: ['yaoqiu'], 2: ['yinhe'] },
  shitietesheng: { 2: ['fulun', 'wuxu', 'bingxi', 'chuangshang'], 3: ['zaijian-tiesheng'] },
  proust: { 2: ['yewan'] },
  yuhua: { 2: ['yizhiyou'] },
}

function makeSeat(name, cards) {
  const handPool = []
  for (const c of cards.handcards) {
    if (c.type === '特殊') continue // 特殊卡只靠星级发放，不进牌堆
    const n = Math.max(1, Number(c.count ?? 1))
    for (let i = 0; i < n; i += 1) handPool.push(c.id)
  }
  return {
    name,
    ap: 0,
    handCredits: 0,
    characters: [],
    hand: [],
    charPool: cards.characters.map((c) => c.id),
    handPool,
    rerolledThisTurn: false,
    starBonus: 0,        // 本回合返还重抽了几次：抽到的角色按 1+次数 算星，溢出作废
    pendingDamage: null,
    extraTurn: false,
    finalDouble: false,
    lastHandCardId: null,
    foodThisTurn: 0,
    sealed: [],          // 被封印的牌：{ cardId, untilRound }
    graveyard: [],       // 退场的人，等银河铁道之夜拉回来
    blocked: {},         // 被针对的回合：{ skillUntil, foodUntil, buffUntil }
  }
}

export function createGame({ players, cards, victory = 'reality' }) {
  uidSeq = 0
  const state = {
    phase: 'playing',
    round: 1,
    turnSeat: 0,
    victory,
    winner: null,
    log: [],
    cards,               // 引擎内部用，服务端广播前会剥掉
    seats: players.map((p) => makeSeat(p.name, cards)),
    pending: null,
  }
  // 开局不先发手牌：先抽角色，落定之后再抽三张（2026-10-31 晚按他的规则改）
  startTurn(state)
  return state
}

function log(state, text) {
  state.log.unshift(text)
  if (state.log.length > 100) state.log.length = 100
}

function cardOf(state, id) {
  return state.cards.handcards.find((c) => c.id === id) ?? null
}

function drawCharacter(seat, state, starRank = 1) {
  if (seat.charPool.length === 0) return null
  const level = pickLevel()
  const same = state.cards.characters.filter((c) => c.level === level && seat.charPool.includes(c.id))
  const pool = same.length > 0 ? same : state.cards.characters.filter((c) => seat.charPool.includes(c.id))
  if (pool.length === 0) return null
  const card = pool[Math.floor(Math.random() * pool.length)]
  seat.charPool = seat.charPool.filter((id) => id !== card.id)
  // 星级由调用处显式给：回合开头的抽牌永远一星，只有返还重抽才加
  return makeCharacter(card, Math.min(3, Math.max(1, starRank)))
}

function drawHand(seat, state) {
  if (seat.handPool.length === 0) return null
  const id = seat.handPool[Math.floor(Math.random() * seat.handPool.length)]
  seat.handPool = seat.handPool.filter((x) => x !== id)
  // 金瓶梅：抽到的人全队掉一半血，牌洗回池里等下一个人（2026-11-01 改）
  if (id === 'jinpingmei' && state) {
    for (const c of seat.characters) {
      if (c.hp > 0) hurt(c, Math.round(c.hp * 0.5), state)
    }
    seat.handPool.push(id)
    log(state, `${seat.name} 抽到金瓶梅：全队各掉一半血，这张又放回去了`)
    return id
  }
  seat.hand.push(id)
  return id
}

const statusOf = (ch, name) => ch.statuses.find((s) => s.name === name) ?? null
const hasStatus = (ch, name) => Boolean(statusOf(ch, name))

function isDebuff(name) {
  return DEBUFFS.has(name)
}

// 「增益」只算加攻、加伤害这一类；血量变化不算（2026-11-01 他定的）
const BUFF_STATUSES = new Set(['梦想', '幸福', '天之苍苍', '万物与我为一', '养生主', '养生主回血'])

function addStatus(ch, name, turns, state) {
  if (isDebuff(name) && hasStatus(ch, '幸福')) {
    log(state, `${ch.name} 正在『幸福』里，${name} 落不下去`)
    return
  }
  // 海明威：自身所受的增益转化为对应回合数的嘲讽
  if (ch.cardId === 'hemingway' && BUFF_STATUSES.has(name)) {
    if (state) log(state, `${ch.name} 把『${name}』转成了 ${turns} 回合嘲讽`)
    addStatus(ch, '嘲讽', turns, state)
    return
  }
  // 余华：每获得一层增益，额外攒一层锋利
  if (ch.cardId === 'yuhua' && BUFF_STATUSES.has(name) && ch.phase === 'early') {
    ch.sharp = Math.min(ch.sharpCap ?? 8, (ch.sharp ?? 0) + 1)
    if (state) log(state, `${ch.name} 拿到增益，锋利 +1（${ch.sharp}）`)
  }
  const existing = statusOf(ch, name)
  if (existing) existing.turns = Math.max(existing.turns, turns)
  else ch.statuses.push({ name, turns })
}

/** 齐物论：单体治疗时，其余队友回其治疗量的 30% */
function shareHeal(seat, healed, amount, state) {
  if (!seat.characters.some((c) => hasStatus(c, '万物与我为一'))) return
  const share = Math.round(amount * 0.3)
  if (share <= 0) return
  for (const c of seat.characters) {
    if (c.uid !== healed.uid && c.hp > 0) {
      heal(c, share)
      log(state, `万物与我为一：${c.name} 分到 ${share} 点`)
    }
  }
}

function heal(ch, amount) {
  // 余华不可被治疗（一星效果，永远成立）
  if (ch.cardId === 'yuhua') return
  const amt = Math.max(0, Math.round(amount))
  // 硬汉状态：所有恢复量转化为攻击力
  if (hasStatus(ch, '硬汉')) {
    ch.attack += amt
    return
  }
  ch.hp = Math.min(ch.maxHp, ch.hp + amt)
}

function hurt(ch, amount, state, source = '') {
  let dmg = Math.max(0, Math.round(amount))
  // 天之苍苍：免伤 20%（三星后 40%）
  if (hasStatus(ch, '天之苍苍')) {
    const cut = (ch.starRank ?? 1) >= 3 ? 0.4 : 0.2
    const reduce = Math.round(dmg * cut)
    dmg -= reduce
    if (state) log(state, `${ch.name} 的「天之苍苍」抵掉 ${reduce}`)
  }
  if (ch.shield > 0) {
    const absorbed = Math.min(ch.shield, dmg)
    ch.shield -= absorbed
    dmg -= absorbed
    if (absorbed > 0 && state) log(state, `${ch.name} 的护盾抵掉 ${absorbed}`)
  }
  ch.hp -= dmg
  if (ch.hp <= 0) {
    if (hasStatus(ch, '蜘蛛丝')) {
      ch.hp = 1
      ch.statuses = ch.statuses.filter((s) => s.name !== '蜘蛛丝')
      if (state) log(state, `蜘蛛丝把 ${ch.name} 从死亡边上拉了回来`)
    }
  }
  if (state && source) log(state, `${ch.name} 受到 ${dmg} 点伤害（${source}）`)
}

function changeMaxHp(ch, delta, state) {
  ch.maxHp = Math.max(1, ch.maxHp + delta)
  if (ch.hp > ch.maxHp) ch.hp = ch.maxHp
  if (state) log(state, `${ch.name} 的血量上限 ${delta >= 0 ? '+' : ''}${delta}（现 ${ch.maxHp}）`)
}

/**
 * 全体累计伤害：把所有本方角色的血量加在一起算池子。
 * 这一击若不能把总池消耗完，谁都不会死（这是他的规则，2026-10-31 晚）。
 */
function hurtTeam(team, total, state, source, attackerTeam = null) {
  const alive = team.filter((c) => c.hp > 0)
  if (alive.length === 0) return
  const pool = alive.reduce((s, c) => s + c.hp, 0)
  const dmg = Math.max(0, Math.round(total))
  const hitOne = (c, take) => {
    hurt(c, take, null)
    // 受击被动：海明威挨打就反一记全体（只有一层，不再往回弹）
    if (c.cardId === 'hemingway' && attackerTeam && attackerTeam.length > 0) {
      const back = Math.round(c.attack)
      if (state) log(state, `${c.name} 挨打，丧钟为谁而鸣：${back} 点摊回对面全体`)
      hurtTeam(attackerTeam, back, state, '丧钟为谁而鸣', null)
    }
  }
  if (dmg >= pool) {
    for (const c of alive) hitOne(c, c.hp)
    if (state) log(state, `${source}：${dmg} 点打穿了全队（总血量 ${pool}）`)
    return
  }
  let left = dmg
  for (const c of alive) {
    const share = Math.round((c.hp / pool) * dmg)
    const take = Math.min(Math.max(0, c.hp - 1), share) // 留着 1 点，不致死
    hitOne(c, take)
    left -= take
  }
  if (state) log(state, `${source}：${dmg} 点摊到全体，总血量还剩 ${pool - dmg}`)
  void left
}

/** 蛙造出来的娃娃：2000 血上限，没有技能 */
function makeDoll(state) {
  uidSeq += 1
  return {
    uid: `doll-${uidSeq}`,
    cardId: 'doll',
    name: '娃娃',
    title: '蛙造出来的',
    level: 0,
    hp: 2000,
    maxHp: 2000,
    attack: 0,
    shield: 0,
    shieldMax: 0,
    traits: [],
    statuses: [],
    starRank: 0,
    cd: 0,
    active: null,
    passive: null,
    tricks: [],
    isPhilosopher: false,
  }
}

function killCharacter(ch, state, reason) {
  if (ch.tricks.includes('即死免疫') || ch.cardId === 'hemingway') return false
  // 庄子天下（四星）：处于万物与我为一的人免疫即死
  if (hasStatus(ch, '万物与我为一')) {
    const seat = state?.seats?.find((s) => s.characters.includes(ch))
    if (seat?.characters.some((c) => c.cardId === 'zhuangzi' && (c.starRank ?? 1) >= 4)) {
      if (state) log(state, `天下：${ch.name} 免于即死`)
      return false
    }
  }
  ch.hp = 0
  // 留下的尸体记着，银河铁道之夜能把一个拉回来
  const seat = state?.seats?.find((s) => s.characters.includes(ch))
  if (seat) seat.graveyard.push({ ...ch })
  if (state) log(state, `${ch.name} 退场（${reason}）`)
  return true
}

function grantStarCards(seat, state, cardId, starRank) {
  const grants = STAR_GRANTS[cardId]
  if (!grants) return
  for (const [lv, ids] of Object.entries(grants)) {
    if (starRank < Number(lv)) continue
    for (const id of ids) {
      const card = state.cards.handcards.find((h) => h.id === id)
      if (!card) continue
      // 进己方卡池，之后按正常抽牌几率抽到；已经在池里或手里就不重复塞
      if (seat.handPool.includes(id) || seat.hand.includes(id)) continue
      seat.handPool.push(id)
      log(state, `${card.name} 进入 ${seat.name} 的卡池（${lv} 星奖励）`)
    }
  }
}

function startTurn(state) {
  const seat = state.seats[state.turnSeat]
  const foe = state.seats[other(state.turnSeat)]
  pruneDead(state)
  seat.ap = Math.min(AP_CAP, seat.ap + AP_PER_TURN)
  seat.handCredits = 0
  seat.rerolledThisTurn = false
  seat.starBonus = 0
  seat.finalDouble = false
  seat.foodThisTurn = 0

  for (const ch of seat.characters) {
    if (ch.cd > 0) ch.cd -= 1
    if (hasStatus(ch, '畜生道')) {
      ch.hp = ch.maxHp
      log(state, `${ch.name} 在畜生道里，每回合回满`)
    }
    if (ch.cardId === 'hemingway' && hasStatus(ch, '硬汉')) {
      // 每回合加的 500 点不转化为攻击力，所以直接加血
      ch.hp = Math.min(ch.maxHp, ch.hp + 500)
      log(state, `${ch.name} 硬汉状态，血量 +500`)
    }
    if (ch.cardId === 'miyazawa') {
      hurt(ch, 100, null)
      log(state, `${ch.name} 银河铁道之夜：自扣 100`)
    }
    if (ch.cardId === 'shitietesheng') {
      ch.disability = (ch.disability ?? 0) + 1
      for (const ally of seat.characters) addStatus(ally, '梦想', 99, null)
      log(state, `史铁生：残疾 ${ch.disability} 层`)
      if (ch.disability >= 6 && !hasStatus(ch, '友谊')) {
        ch.hp = 0
        log(state, '史铁生的残疾到六层，退场')
      }
    }
    // 余华：锋利每回合 +1；上场五回合转后期
    if (ch.cardId === 'yuhua') {
      ch.turnsOnField = (ch.turnsOnField ?? 0) + 1
      if (ch.phase === 'early') {
        ch.sharp = Math.min(ch.sharpCap ?? 8, (ch.sharp ?? 0) + 1)
        log(state, `${ch.name} 攒下一层锋利（${ch.sharp}/${ch.sharpCap ?? 8}）`)
        if (ch.turnsOnField >= 5) {
          ch.phase = 'late'
          ch.empathy = ch.sharp
          log(state, `${ch.name} 进入后期，《活着》与《兄弟》开了；共情 ${ch.empathy} 层`)
        }
      }
    }
    // 舒尔茨的鸟（一星）：召唤计数每回合重置
    if (seat.schulzStar >= 1) {
      seat.summonCount = 0
    }
    // 普鲁斯特：场上计数
    if (ch.cardId === 'proust') ch.turnsOnField = (ch.turnsOnField ?? 0) + 1
    // 养生主：血量上限够了的那批，每回合回一半
    if (hasStatus(ch, '养生主回血')) {
      ch.hp = Math.min(ch.maxHp, ch.hp + Math.round(ch.maxHp * 0.5))
      log(state, `${ch.name} 养生主：回了半个上限`)
    }
    // 庄子二星：每回合全体 +500
    if (ch.cardId === 'zhuangzi' && (ch.starRank ?? 1) >= 2) {
      for (const ally of seat.characters) {
        if (ally.hp > 0) ally.hp = Math.min(ally.maxHp, ally.hp + 500)
      }
      log(state, '达生：我方全体恢复 500')
    }
  }
  seat.characters = seat.characters.filter((c) => c.hp > 0)

  // 父亲的最后逃亡：父亲死后一回合回归，血限扣 500，随机一个敌方单位打回一星
  if (seat.fatherDeadAt && state.round >= seat.fatherDeadAt + 1) {
    seat.fatherDeadAt = null
    const max = Math.max(500, seat.fatherMax ?? 3000)
    seat.summon = { uid: 'father', cardId: 'father', name: '父亲', hp: max, maxHp: max, attack: 0, shield: 0, statuses: [], traits: [], starRank: 1, tricks: [], hideout: 0, rounds: 5 }
    const rand = foe.characters[Math.floor(Math.random() * foe.characters.length)]
    if (rand) {
      rand.starRank = 1
      log(state, `${rand.name} 被打回一星初始状态`)
    }
    log(state, '父亲逃回来了：血限扣 500，五回合后又要散')
  }
  // 舒尔茨的疗养院：父亲每回合扣 600；五回合后散场，蛰居兑现
  if (seat.summon) {
    seat.summon.hp -= 600
    // 肉桂店（四星）：疗养院一直开，回合不再倒数
    if ((seat.schulzStar ?? 1) < 4) seat.summon.rounds -= 1
    log(state, `父亲在疗养院又瘦了 600（${seat.summon.hp}）`)
    if (seat.summon.hp <= 0) {
      log(state, '父亲死了，人偶次数重置')
      seat.dolls = 5
      // 蟑螂（二星）：召唤物死亡，人偶再加 2
      if ((seat.schulzStar ?? 1) >= 2) {
        seat.dolls += 2
        log(state, '蟑螂：召唤物死了，人偶 +2')
      }
      // 肉桂店（四星）：死去的召唤物扣 10% 血限回归，直到血限为零
      if ((seat.schulzStar ?? 1) >= 4 && (seat.fatherMax ?? 3000) > 0) {
        const nextMax = Math.round((seat.fatherMax ?? 3000) * 0.9)
        seat.fatherMax = nextMax
        if (nextMax > 0) {
          seat.fatherDeadAt = state.round
          log(state, `肉桂店：父亲会带着 ${nextMax} 血限回来`)
        }
      } else {
        seat.fatherDeadAt = state.round
      }
      seat.summon = null
    } else if (seat.summon.rounds <= 0) {
      const layers = seat.summon.hideout
      if (layers > 0) hurtTeam(foe, layers * 500, state, '蛰居：疗养院散场的荒诞伤害')
      log(state, '疗养院关了')
      seat.summon = null
    }
  }
  // 鳄鱼街：三回合到期，把吞掉的伤害一并奉还
  if (seat.crocodile) {
    seat.crocodile.rounds -= 1
    if (seat.crocodile.rounds <= 0) {
      const back = Math.min(20000, seat.crocodile.bank)
      if (back > 0) hurtTeam(foe.characters, back, state, '鳄鱼街奉还')
      log(state, `鳄鱼街收街：奉还 ${back} 点`)
      seat.crocodile = null
    }
  }
  // 庄子蝴蝶：移出场外的人，两回合后回来
  for (const away of seat.away ?? []) {
    away.turnsLeft -= 1
    if (away.turnsLeft <= 0) {
      seat.characters.push(away.ch)
      log(state, `${away.ch.name} 从蝴蝶里回来了`)
    }
  }
  seat.away = (seat.away ?? []).filter((a) => a.turnsLeft > 0)

  state.pending = drawCharacter(seat, state)
  // 手牌要等角色牌落下之后才抽：这里只标记本回合还没抽手牌
  seat.drewHandThisTurn = false
  if (state.pending) log(state, `${seat.name} 抽到角色 ${state.pending.name}（${state.pending.level} 级）`)
  else drawRoundHand(seat, state)
}

/** 佛跳墙：抽到手就封起来，三回合后才能用 */
function sealDrawnCards(seat, state) {
  for (const id of seat.hand) {
    const card = cardOf(state, id)
    if (!card) continue
    const effects = Array.isArray(card.effects) ? card.effects : []
    const wantsSeal = effects.some((e) => e.kind === 'seal')
    if (!wantsSeal) continue
    if (seat.sealed.some((s) => s.cardId === id)) continue
    const turns = effects.find((e) => e.kind === 'seal')?.turns ?? 3
    seat.sealed.push({ cardId: id, untilRound: state.round + turns })
    log(state, `${card.name} 封住了，第 ${state.round + turns} 轮才解`)
  }
}

/** 角色牌落定（读或不读）之后再抽三张手牌，每回合一次 */
function drawRoundHand(seat, state) {
  if (seat.drewHandThisTurn) return
  seat.drewHandThisTurn = true
  for (let i = 0; i < HAND_PER_AP; i += 1) drawHand(seat, state)
  log(state, `${seat.name} 抽三张手牌`)
  sealDrawnCards(seat, state)
}

function spendAp(seat) {
  if (seat.ap < 1) return false
  seat.ap -= 1
  return true
}

function spendHand(seat) {
  if (seat.handCredits > 0) {
    seat.handCredits -= 1
    return true
  }
  if (seat.ap < 1) return false
  seat.ap -= 1
  seat.handCredits = HAND_PER_AP - 1
  return true
}

const other = (i) => 1 - i

/** 把血量归零的角色从场上清掉，免得判胜时还当他在 */
function pruneDead(state) {
  for (const side of state.seats) {
    const dead = side.characters.filter((c) => c.hp <= 0)
    if (dead.length > 0) {
      for (const c of dead) log(state, `${c.name} 退场`)
      side.characters = side.characters.filter((c) => c.hp > 0)
    }
  }
}

function checkVictory(state) {
  pruneDead(state)
  for (const side of state.seats) if (side.characters.length > 0) side.hadCharacters = true
  for (let i = 0; i < 2; i += 1) {
    const foe = state.seats[other(i)]
    // 只看场上：上过场的人全没了就算输，不管角色池还剩几张
    if (foe.hadCharacters && foe.characters.length === 0) {
      state.phase = 'over'
      state.winner = i
      log(state, `${state.seats[i].name} 胜利`)
      return
    }
  }
}

/** 手牌加成可以叠着等下一次攻击／伤害型主动技：用一个数组攒着，不互相覆盖 */
function addPendingDamage(seat, part) {
  if (!seat.pendingDamage || !Array.isArray(seat.pendingDamage.parts)) {
    seat.pendingDamage = { parts: [] }
  }
  seat.pendingDamage.parts.push(part)
  // 余华：每获得一层增益（手牌加成也算），额外攒一层锋利
  const yuhua = seat.characters.find((c) => c.cardId === 'yuhua' && c.phase === 'early')
  if (yuhua) {
    yuhua.sharp = Math.min(yuhua.sharpCap ?? 8, (yuhua.sharp ?? 0) + 1)
  }
}

function readPendingDamage(seat) {
  const pd = seat.pendingDamage
  const out = { damageType: '现实', bonusPct: 0, flat: 0, convertRatioPct: null, fixedBonus: 0 }
  if (!pd) return out
  if (Array.isArray(pd.parts)) {
    for (const p of pd.parts) {
      if (p.damageType) out.damageType = p.damageType
      out.bonusPct += p.bonusPct ?? 0
      out.flat += p.flat ?? 0
      if (p.convertRatioPct) out.convertRatioPct = p.convertRatioPct
      if (p.fixedBonus) out.fixedBonus += p.fixedBonus
    }
    return out
  }
  // 旧结构兜底
  out.damageType = pd.damageType ?? '现实'
  out.bonusPct = pd.bonusPct ?? 0
  out.flat = pd.flat ?? 0
  out.convertRatioPct = pd.convertRatioPct ?? null
  return out
}
function applyHandEffects(state, seat, foe, card, drop) {
  const target = drop && seat.characters.includes(drop) ? drop : null
  const effects = Array.isArray(card.effects) ? card.effects : []
  if (effects.length === 0) return '这张牌的效果还没接进引擎'

  const NEED_ALLY = ['heal', 'healPct', 'healToFull', 'damageSelf', 'maxHpFlat', 'maxHpPct', 'statusSelf', 'sacrificeAlly', 'sellBlood']
  if (!target && effects.some((e) => NEED_ALLY.includes(e.kind))) {
    return `「${card.name}」要拖到自己场上的角色身上`
  }
  if (effects.some((e) => e.kind === 'taunt') && !drop) {
    return '恋爱的犀牛：要拖到一个角色上判定'
  }

  for (const eff of effects) {
    switch (eff.kind) {
      case 'heal':
        if (target) {
          heal(target, eff.amount)
          log(state, `${target.name} 回血 ${eff.amount}`)
          shareHeal(seat, target, eff.amount, state)
        }
        break
      case 'healPct': {
        if (!target) return '这张牌要先选一个自己场上的角色'
        const pct = eff.doubleIfLast && seat.lastHandCardId === eff.doubleIfLast ? eff.pct * 2 : eff.pct
        const amt = (target.maxHp * pct) / 100
        heal(target, amt)
        log(state, `${target.name} 回复 ${pct}% 血量上限`)
        shareHeal(seat, target, amt, state)
        break
      }
      case 'healToFull':
        if (!target) return '这张牌要先选一个自己场上的角色'
        target.hp = target.maxHp
        log(state, `${target.name} 回满`)
        break
      case 'damageSelf':
        if (!target) return '这张牌要先选一个自己场上的角色'
        hurt(target, eff.amount, state)
        break
      case 'maxHpFlat':
        if (!target) return '这张牌要先选一个自己场上的角色'
        changeMaxHp(target, eff.amount, state)
        break
      case 'maxHpPct':
        if (!target) return '这张牌要先选一个自己场上的角色'
        changeMaxHp(target, Math.round((target.maxHp * eff.pct) / 100), state)
        break
      case 'statusSelf':
        if (!target) return '这张牌要先选一个自己场上的角色'
        addStatus(target, eff.status, eff.turns, state)
        log(state, `${target.name} 获得『${eff.status}』`)
        break
      case 'nextDamage':
        addPendingDamage(seat, { damageType: eff.damageType, bonusPct: eff.bonusPct })
        log(state, `${seat.name} 攒下一层加成：${eff.damageType} +${eff.bonusPct}%`)
        break
      case 'nextDamageConvert':
        addPendingDamage(seat, { damageType: eff.damageType, convertRatioPct: eff.ratioPct })
        break
      case 'extraTurn':
        // 额外回合：只有 1 点行动值、不回血不抽牌；结束之后回到原来那一步
        if (!seat.inExtra) {
          seat.savedAp = seat.ap
          seat.inExtra = true
          seat.ap = 1
          log(state, `${seat.name} 拿到一个额外回合（1 点行动值，结束就交回去）`)
        }
        break
      case 'finalDouble':
        seat.finalDouble = true
        log(state, `${seat.name} 本回合最终伤害翻倍`)
        break
      case 'nextDamageFlat':
        addPendingDamage(seat, { damageType: eff.damageType, flat: eff.amount })
        log(state, `下一击额外附带 ${eff.amount} 点${eff.damageType}伤害`)
        break
      case 'clearDreams':
        for (const side of state.seats) {
          for (const c of side.characters) c.statuses = c.statuses.filter((s) => s.name !== '梦想')
        }
        log(state, '所有『梦想』被抹掉了')
        break
      case 'dreamCap':
        seat.dreamCap = eff.cap
        log(state, `梦想上限提到 ${eff.cap} 层`)
        break
      case 'purgeTiesheng':
        for (const c of seat.characters) {
          if (c.cardId === 'shitietesheng') {
            c.statuses = []
            c.disability = 0
          }
        }
        log(state, '史铁生的残疾与梦想都清空了')
        break
      case 'drawHands':
        for (let i = 0; i < eff.count; i += 1) drawHand(seat, state)
        log(state, `抽了 ${eff.count} 张牌`)
        break
      case 'purgeBuffs':
        for (const side of state.seats) {
          for (const c of side.characters) {
            c.statuses = c.statuses.filter((s) => DEBUFFS.has(s.name))
          }
        }
        log(state, '双方的增益全被抹掉了')
        break
      case 'cdDown':
        for (const c of seat.characters) if (c.cd > 0) c.cd = Math.max(0, c.cd - eff.amount)
        log(state, `我方主动技冷却减了 ${eff.amount} 回合`)
        break
      case 'unmovable': {
        const t = drop ?? foe.characters[0]
        if (!t) return '不屈的雄狮：场上没有目标'
        addStatus(t, '不可行动', eff.turns ?? 1, state)
        log(state, `${t.name} 陷入不可行动，${eff.turns ?? 1} 回合`)
        break
      }
      case 'restaurant':
        foe.blocked = foe.blocked ?? {}
        foe.blocked.skillUntil = state.round + (eff.turns ?? 1) - 1
        foe.blocked.foodUntil = state.round + (eff.turns ?? 1) - 1
        foe.blocked.buffUntil = state.round + (eff.turns ?? 1) - 1
        log(state, '要求多多的餐厅：对方这回合不能用主动技、不能吃食物、拿不到增益')
        break
      case 'doll': {
        for (let i = 0; i < 2; i += 1) seat.characters.push(makeDoll(state))
        log(state, '蛙：两个娃娃上场（各 2000 血）')
        break
      }
      case 'memory': {
        const t = drop ?? seat.characters[0]
        if (!t) return '夜晚于童年安眠：没有可判定的角色'
        addStatus(t, '追忆', 99, state)
        log(state, `${t.name} 进入『追忆』`)
        break
      }
      case 'railway': {
        const mine = drop && seat.characters.includes(drop) ? drop : seat.characters[0]
        const theirs = foe.characters[0]
        if (!mine) return '银河铁道之夜：自己场上没有角色'
        addStatus(mine, '不可行动', 3, state)
        if (theirs) {
          addStatus(theirs, '不可行动', 3, state)
          killCharacter(theirs, state, '银河铁道之夜')
        }
        const back = seat.graveyard.pop()
        if (back) {
          back.hp = back.maxHp
          back.statuses = []
          back.uid = `${back.uid}-back`
          seat.characters.push(back)
          log(state, `${back.name} 从银河那头回来了`)
        }
        log(state, '银河铁道之夜：两边各有人被定住三回合')
        break
      }
      case 'sacrificeAlly':
        if (!target) return '父亲：要先选一个己方角色献掉'
        if (killCharacter(target, state, '父亲')) seat.characters = seat.characters.filter((c) => c.uid !== target.uid)
        break
      case 'seal':
        seat.sealed.push({ cardId: card.id, untilRound: state.round + eff.turns })
        log(state, `${card.name} 被封印，${eff.turns} 回合后解封`)
        break
      case 'poison':
        seat.poisoned = true
        seat.handPool.push(card.id)
        log(state, `砒霜种下了，牌回了牌堆`)
        break
      case 'galacticEmpire': {
        const best = seat.characters.reduce((m, c) => Math.max(m, c.maxHp), 0)
        const per = Math.round(best * 0.2)
        for (const ally of seat.characters) {
          const layers = (ally.empire ?? 0) + 1
          ally.empire = layers
          ally.shield += per
          ally.shieldMax += per
        }
        log(state, `银河帝国：每人 +${per} 点现实适性`)
        break
      }
      case 'taunt': {
        // 点谁判谁，己方也可以（嘲讽自己，把对面的火引过来）
        const t = drop ?? foe.characters[0]
        if (!t) return '恋爱的犀牛：场上没有可判定的角色'
        if (t.hp > t.maxHp * 0.5) {
          addStatus(t, '嘲讽', 5, state)
          log(state, `${t.name} 被判定『嘲讽』五回合`)
        } else {
          log(state, `${t.name} 血量不过半，犀牛没认下来`)
        }
        break
      }
      case 'stitch': {
        if (seat.characters.length < 2) return '弗兰肯斯坦：自己场上至少要有两个角色'
        const [a, b] = seat.characters
        const share = Math.max(a.maxHp, b.maxHp)
        a.maxHp = share
        b.maxHp = share
        a.stitched = b.uid
        b.stitched = a.uid
        a.statuses.push({ name: '缝合', turns: 3 })
        b.statuses.push({ name: '缝合', turns: 3 })
        log(state, `${a.name} 与 ${b.name} 缝合，共享上限 ${share}`)
        break
      }
      case 'sellBlood': {
        if (!target) return '许三观卖血记：要先选一个己方角色'
        const loss = Math.round(target.hp * 0.5)
        hurt(target, loss, state)
        const bonus = Math.floor(loss / 100) * 10
        seat.pendingDamage = { damageType: '现实', bonusPct: (seat.pendingDamage?.bonusPct ?? 0) + bonus }
        log(state, `${target.name} 卖了 ${loss} 血，下一击现实 +${bonus}%`)
        break
      }
      default:
        break
    }
  }
  seat.lastHandCardId = card.id
  return null
}

function activeBlocked(ch) {
  return hasStatus(ch, '畜生道')
}

function useSkill(state, seat, foe, actor, allyTarget, enemyTarget, skillKey = null) {
  if (!actor.active) return '这个角色没有主动技'
  if (activeBlocked(actor)) return '它的主动技被封住了'
  if (actor.cd > 0) return `还要等 ${actor.cd} 回合`
  if (!spendAp(seat)) return '行动值不够'

  switch (actor.cardId) {
    case 'dickens':
      seat.pendingDamage = {
        damageType: '现实',
        bonusPct: (seat.pendingDamage?.bonusPct ?? 0) + 100,
        fixedBonus: 100,
      }
      log(state, `${actor.name} 发动大卫科波菲尔：下一击现实 +100%`)
      break
    case 'murakami':
      for (const c of seat.characters) {
        heal(c, c.maxHp * 0.2 + (actor.healBonus ?? 0))
        changeMaxHp(c, 200, null)
      }
      log(state, `${actor.name} 发动挪威的森林：全体回血 20%（+${actor.healBonus ?? 0}），上限 +200`)
      break
    case 'moyan': {
      // 指定的目标由玩家自己点，不替他挑第一个
      if (!allyTarget) return '莫言：先点一名己方角色，再发动'
      const t = allyTarget
      t.maxHp = Math.max(t.maxHp, 3000)
      t.hp = t.maxHp
      addStatus(t, '畜生道', 6, state)
      log(state, `${t.name} 落进畜生道（六回合）`)
      break
    }
    case 'schulz': {
      const key = skillKey ?? 'renou'
      if (key === 'liaoyang') {
        if (seat.summon) return '疗养院已经开着'
        seat.summon = { uid: 'father', cardId: 'father', name: '父亲', hp: 3000, maxHp: 3000, attack: 0, shield: 0, statuses: [], traits: [], starRank: 1, tricks: [], hideout: 0, rounds: 5 }
        seat.summonCount = (seat.summonCount ?? 0) + 1
        log(state, '疗养院开了：父亲 3000 血，每回合扣 600，挨打攒蛰居')
        break
      }
      if (key === 'eyu') {
        if (seat.crocodile) return '鳄鱼街已经开着'
        seat.crocodile = { rounds: 3, bank: 0 }
        log(state, '鳄鱼街开了：接下来三回合，对面的技能全被吞掉')
        break
      }
      // 裁缝的人偶：挂在座位上自动挡对方的技能
      seat.dolls = seat.dolls ?? 5
      if (seat.dolls <= 0) return '人偶用完了'
      log(state, `${actor.name} 手上还留着 ${seat.dolls} 个人偶（自动挡对方的技能）`)
      break
    }
    case 'proust': {
      // 追忆似水年华：全队 +500 现实适性，自己进入追忆
      for (const c of seat.characters) {
        c.shield += 500
        c.shieldMax += 500
      }
      addStatus(actor, '追忆', 99, state)
      log(state, `${actor.name} 进了追忆：全队各 +500 现实适性，他不再被单体选中，也不再出手`)
      break
    }
    case 'yuhua': {
      // 单体伤害也打不着追忆里的人
      const pickable = foe.characters.filter((c) => !hasStatus(c, '追忆'))
      const t = (enemyTarget && !hasStatus(enemyTarget, '追忆') ? enemyTarget : null) ?? pickable[0]
      if (!t) return '余华：对面没人可打'
      const key = skillKey ?? (actor.phase === 'late' ? 'huozhe' : 'xianshi')
      if (actor.phase === 'early') {
        // 前期：现实一种 / 鲜血梅花，各 500 点，消耗两层锋利
        const used = Math.min(2, actor.sharp ?? 0)
        actor.sharp = Math.max(0, (actor.sharp ?? 0) - 2)
        const type = key === 'xianxue' ? '超现实' : '现实'
        const dmg = 500 + used * 100
        hurt(t, dmg, state, key === 'xianxue' ? '鲜血梅花' : '现实一种')
        log(state, `${actor.name} 用『${key === 'xianxue' ? '鲜血梅花' : '现实一种'}』打了 ${dmg} 点${type}伤害（耗 ${used} 层锋利）`)
        break
      }
      // 后期
      if (key === 'xiongdi') {
        const layers = actor.empathy ?? 0
        if (layers <= 0) return '兄弟：没有共情可用'
        const dmg = Math.round(t.maxHp * 0.1 * layers)
        actor.empathy = 0
        hurt(t, dmg, state, '兄弟')
        log(state, `${actor.name} 用『兄弟』按 ${layers} 层共情打了 ${dmg} 点荒诞伤害`)
        break
      }
      const layers = actor.empathy ?? 0
      // 活着：一次行动里连打——共情几层就打几刀，每一刀都吃到手牌加成
      const hits = Math.max(1, layers)
      const pending = readPendingDamage(seat)
      let total = 0
      for (let i = 0; i < hits; i += 1) {
        let one = Math.round(100 * (1 + (pending.bonusPct ?? 0) / 100)) + (pending.flat ?? 0)
        if (hasStatus(actor, '攻-100')) one -= 100
        if (hasStatus(actor, '梦想')) one += 100
        one = Math.max(1, one)
        hurt(t, one, state, '活着')
        total += one
      }
      actor.empathy = 0
      log(state, `${actor.name} 连打 ${hits} 刀，共 ${total} 点现实伤害`)
      break
    }
    case 'zhuangzi': {
      const key = skillKey ?? 'xiaoyao'
      if (key === 'qiwu') {
        for (const c of seat.characters) addStatus(c, '万物与我为一', 2, state)
        log(state, `${actor.name} 用『齐物论』：我方全体进入万物与我为一`)
        break
      }
      if (key === 'yangsheng') {
        for (const c of seat.characters) {
          if (c.maxHp < 2000) {
            c.maxHp = 2000
            if (c.hp > c.maxHp) c.hp = c.maxHp
            addStatus(c, '养生主', 3, state)
          } else {
            addStatus(c, '养生主回血', 2, state)
          }
        }
        log(state, `${actor.name} 用『养生主』：上限不到两千的抬到两千，够的每回合回一半`)
        break
      }
      const t = allyTarget ?? actor
      addStatus(t, '天之苍苍', 2, state)
      log(state, `${t.name} 得了『天之苍苍』：免伤 20%，现实伤害 +200`)
      break
    }
    case 'hemingway': {
      // 老人与海：护盾（现实适性）转成血量，血量提到 4000 以上
      const shieldToHp = actor.shield ?? 0
      actor.maxHp = 4000 + shieldToHp
      actor.hp = actor.maxHp
      actor.shield = 0
      actor.shieldMax = 0
      addStatus(actor, '硬汉', 99, state)
      log(state, `${actor.name} 进入硬汉：护盾 ${shieldToHp} 转成血，血量 ${actor.maxHp}，之后所有恢复变攻击力`)
      break
    }
    case 'miyazawa': {
      // 嘲讽挂在自己身上：对面只能打他（2026-11-01 改）
      addStatus(actor, '嘲讽', 3, state)
      const bad = ['攻-100', '易伤100', '减行动值']
      const pick = bad[Math.floor(Math.random() * bad.length)]
      if (pick === '减行动值') foe.ap = Math.max(0, foe.ap - 1)
      else for (const c of foe.characters) addStatus(c, pick, 3, state)
      log(state, `${actor.name} 春与阿修罗：自己挂上嘲讽三回合，敌方全体吃了『${pick}』`)
      break
    }
    default:
      return '这个主动技还没接进引擎'
  }
  actor.cd = Number(actor.active.cd ?? 0) + 1
  return null
}

function tickStatuses(state) {
  for (const side of state.seats) {
    for (const ch of side.characters) {
      ch.statuses = ch.statuses
        .map((s) => (s.turns >= 99 ? s : { ...s, turns: s.turns - 1 }))
        .filter((s) => s.turns > 0)
    }
  }
}

export function applyAction(state, seatIndex, action, cards) {
  const result = runAction(state, seatIndex, action, cards)
  // 每一手落定之后统一看一眼胜负：普攻、技能、全体伤害、复活都走同一条路
  if (state.phase === 'playing') checkVictory(state)
  return result
}

function runAction(state, seatIndex, action, cards) {
  if (state.phase !== 'playing') return { error: '这一局已经结束了' }
  if (state.turnSeat !== seatIndex) return { error: '现在不是你的回合' }
  const seat = state.seats[seatIndex]
  const foe = state.seats[other(seatIndex)]
  state.cards = state.cards ?? cards

  const allyTarget = action.targetId ? seat.characters.find((c) => c.uid === action.targetId) : null
  const enemyTarget = action.enemyTargetId ? foe.characters.find((c) => c.uid === action.enemyTargetId) : null

  switch (action.type) {
    case 'acceptDraw': {
      if (!state.pending) return { error: '没有待定的角色牌' }
      // 场上已有同一个人：不新增，给场上那位升一星（三星封顶，溢出的作废）
      const same = seat.characters.find((c) => c.cardId === state.pending.cardId)
      if (same) {
        const before = same.starRank ?? 1
        if (before >= 3) {
          log(state, `${same.name} 已经三星，这张作废`)
        } else {
          same.starRank = before + 1
          log(state, `${same.name} 同名再抽到，升到 ${same.starRank} 星`)
        }
        // 升星用的这张也回池：还能再抽到，继续往上叠
        if (!seat.charPool.includes(state.pending.cardId)) seat.charPool.push(state.pending.cardId)
        state.pending = null
        drawRoundHand(seat, state)
        return { ok: true }
      }
      // 场上满员：得先指定换下谁（换下的回角色池，之后还能再抽到）
      if (seat.characters.length >= MAX_READ) {
        if (!action.replaceUid) return { error: '场上满了：先点一名场上角色，把他换下去' }
        const out = seat.characters.find((c) => c.uid === action.replaceUid)
        if (!out) return { error: '没找到要换下的那个角色' }
        if (state.pending.isPhilosopher && out.isPhilosopher === false && seat.characters.some((c) => c.isPhilosopher && c.uid !== out.uid)) {
          return { error: '哲学家只能有一位' }
        }
        seat.characters = seat.characters.filter((c) => c.uid !== out.uid)
        seat.charPool.push(out.cardId)
        log(state, `${seat.name} 把 ${out.name} 换下，回到角色池`)
      }
      if (state.pending.isPhilosopher && seat.characters.some((c) => c.isPhilosopher)) return { error: '哲学家只能有一位' }
      // 上场不耗行动值：抽牌落定是回合流程里的动作，不算行为（2026-10-31 晚改）
      seat.characters.push(state.pending)
      log(state, `${seat.name} 阅读 ${state.pending.name}（${state.pending.starRank} 星）`)
      // 上场的卡也回池：之后还能抽到同名，靠重复抽来升星
      if (!seat.charPool.includes(state.pending.cardId)) seat.charPool.push(state.pending.cardId)
      // 村上春树二星：全体血量上限上升 300
      if (state.pending.cardId === 'murakami' && state.pending.starRank >= 2) {
        for (const c of seat.characters) changeMaxHp(c, 300, null)
        log(state, '挪威的森林（二星）：全体血量上限 +300')
      }
      // 星级奖励的特殊卡
      grantStarCards(seat, state, state.pending.cardId, state.pending.starRank ?? 1)
      // 舒尔茨上场带着五个人偶
      if (state.pending.cardId === 'schulz') {
        seat.dolls = 5
        seat.schulzStar = state.pending.starRank ?? 1
        seat.summonCount = 0
        log(state, '裁缝的人偶：五个，能挡五次技能')
      }
      state.pending = null
      drawRoundHand(seat, state)
      return { ok: true }
    }
    case 'reroll': {
      if (!state.pending) return { error: '没有待定的角色牌' }
      if (seat.rerolledThisTurn) return { error: '这回合已经返还过一次' }
      if ((state.pending.starRank ?? 1) >= 3) return { error: '三星了，没有重抽机会' }
      if ((state.pending.level ?? 3) < 4) return { error: '三级角色不能返还' }
      // 返还是每次抽到都能做的选择：五级换两次重抽，其余换一次。
      // 2026-10-31 晚更正：重抽不升星，重抽出来的角色仍是一星。
      const times = state.pending.level === 5 ? 2 : 1
      seat.rerolledThisTurn = true
      log(state, `${seat.name} 返还 ${state.pending.name}，换 ${times} 次重抽`)
      // 返还的牌回池：之后还能再抽到
      if (!seat.charPool.includes(state.pending.cardId)) seat.charPool.push(state.pending.cardId)
      state.pending = null
      for (let i = 0; i < times; i += 1) {
        const c = drawCharacter(seat, state, 1)
        if (c) state.pending = c
      }
      return { ok: true }
    }
    case 'discardDraw':
      if (!state.pending) return { error: '没有待定的角色牌' }
      log(state, `${seat.name} 没读 ${state.pending.name}`)
      // 不读的牌也回池
      if (!seat.charPool.includes(state.pending.cardId)) seat.charPool.push(state.pending.cardId)
      state.pending = null
      drawRoundHand(seat, state)
      return { ok: true }

    case 'attack': {
      const attacker = seat.characters.find((c) => c.uid === action.attackerId)
      if (!attacker) return { error: '没有这个上场的角色' }
      if (hasStatus(attacker, '不可行动')) return { error: `${attacker.name} 不可行动，这一回合动不了` }
      // 追忆：自己在追忆里出不了手（三星之后才允许）
      if (hasStatus(attacker, '追忆') && (attacker.starRank ?? 1) < 3) {
        return { error: `${attacker.name} 在追忆里，出不了手` }
      }
      const taunted = foe.characters.filter((c) => hasStatus(c, '嘲讽') && !hasStatus(c, '追忆'))
      let target = foe.characters.find((c) => c.uid === action.targetId)
      // 疗养院的父亲也算一个可打的目标
      if (!target && action.targetId === 'father' && foe.summon) target = foe.summon
      // 追忆里的人不会被单体选中
      if (target && hasStatus(target, '追忆')) {
        log(state, `${target.name} 在追忆里，这一击够不着他`)
        target = null
      }
      // 三星后的后期余华：无视嘲讽
      const ignoresTaunt = attacker.cardId === 'yuhua' && (attacker.starRank ?? 1) >= 3 && attacker.phase === 'late'
      if (!target) {
        const pickable = foe.characters.filter((c) => !hasStatus(c, '追忆'))
        target = pickable[0] ?? null
      }
      if (taunted.length > 0 && (!target || !hasStatus(target, '嘲讽')) && !ignoresTaunt) {
        target = taunted[0]
        log(state, `嘲讽把这一击引到了 ${target.name}`)
      }
      if (!target) return { error: '对手场上没有这个角色' }
      if (!spendAp(seat)) return { error: '行动值不够' }

      // 普鲁斯特的普攻是治疗：全体回 100，不落伤害
      if (attacker.cardId === 'proust') {
        for (const c of seat.characters) heal(c, 100)
        log(state, `${attacker.name} 的普攻：我方全体治疗 100`)
        return { ok: true }
      }

      const pending = readPendingDamage(seat)
      let damageType = pending.damageType
      // 莫言艺术加工：开着就把现实伤害换成超现实
      if (seat.artConvert && damageType === '现实') damageType = '超现实'
      let dmg = attacker.attack * DEFAULTS.realDamageRatio
      if (pending.fixedBonus) dmg = attacker.attack * (DEFAULTS.realDamageRatio + pending.fixedBonus / 100)
      else if (pending.convertRatioPct) dmg = attacker.attack * (pending.convertRatioPct / 100)
      else dmg = dmg * (1 + pending.bonusPct / 100)
      if (hasStatus(target, '易伤100')) dmg += 100
      if (hasStatus(attacker, '梦想')) dmg += 100 // 梦想每层 +100（2026-11-01 上调）
      // 夜晚于童年安眠：有追忆、且带现实适性的单位，伤害附加 100
      if (hasStatus(attacker, '追忆') && (attacker.traits ?? []).includes('现实')) dmg += 100
      // 天之苍苍：现实伤害 +200
      if (hasStatus(attacker, '天之苍苍') && damageType === '现实') dmg += 200
      // 莫言的艺术加工：畜生道还在场上时，每一段攻击行为 +50
      if (seat.characters.some((c) => hasStatus(c, '畜生道'))) {
        dmg += 50
        log(state, '艺术加工：这一击 +50')
      }
      if (hasStatus(attacker, '攻-100')) dmg -= 100
      dmg += attacker.starDamage ?? 0
      dmg += pending.flat
      // 第2个秋天：场上有舒尔茨，一切伤害再 +100
      if (seat.characters.some((c) => c.cardId === 'schulz')) {
        dmg += 100
        log(state, '第2个秋天：这一击 +100')
      }
      // 鸟（一星）：这回合召唤过几次，敌方挨打就多受几次 100
      if ((seat.summonCount ?? 0) > 0) {
        dmg += seat.summonCount * 100
        log(state, `鸟：召唤 ${seat.summonCount} 次，这一击 +${seat.summonCount * 100}`)
      }
      // 余华一星：锋利无视 200 点现实适性（护盾）
      if (attacker.cardId === 'yuhua' && (target.shield ?? 0) > 0) {
        const bypass = Math.min(200, target.shield)
        target.shield -= bypass
        dmg += bypass
        log(state, `锋利无视了 ${bypass} 点现实适性`)
      }
      if (seat.finalDouble) { dmg *= 2; seat.finalDouble = false }
      seat.pendingDamage = null

      // 庄子的天下（四星）：血量低于一半时，最终伤害 +30%
      if (
        attacker.hp > 0 &&
        attacker.hp < attacker.maxHp * 0.5 &&
        seat.characters.some((c) => hasStatus(c, '万物与我为一') && (c.starRank ?? 1) >= 4)
      ) {
        dmg = Math.round(dmg * 1.3)
        log(state, '天下：这一击 +30%')
      }
      // 舒尔茨的春（三星）：自己一方每人单次受伤不超过 500
      if (foe.characters.some((c) => c.cardId === 'schulz' && (c.starRank ?? 1) >= 3)) {
        dmg = Math.min(dmg, 500)
      }

      // 打的是疗养院的父亲：攒一层蛰居（三星上限 3，否则 2）
      if (target?.uid === 'father' && foe.summon) {
        const cap = (target.starRank ?? 1) >= 3 ? 3 : 2
        foe.summon.hideout = Math.min(cap, (foe.summon.hideout ?? 0) + 1)
        log(state, `父亲受了这一下，蛰居 ${foe.summon.hideout} 层`)
      }
      // 余华四星：这一击超过他的血量上限，让血量最高的队友代受（冷却两回合）
      if (
        target &&
        target.cardId === 'yuhua' &&
        (target.starRank ?? 1) >= 4 &&
        dmg > target.maxHp &&
        state.round > (foe.yuhuaSubUntil ?? 0)
      ) {
        const standIn = foe.characters.filter((c) => c.uid !== target.uid && c.hp > 0).sort((a, b) => b.maxHp - a.maxHp)[0]
        if (standIn) {
          foe.yuhuaSubUntil = state.round + 2
          hurt(standIn, dmg, state, '替余华挡下的一击')
          log(state, `${standIn.name} 替余华挡下了这一击`)
          return { ok: true }
        }
      }

      // 村上春树被动：自己一方有人半血时，敌方这一击算作对全体（不打单点，改摊到所有人）
      const guardedByMurakami =
        foe.characters.some((c) => c.cardId === 'murakami') &&
        foe.characters.some((c) => c.hp <= c.maxHp * 0.5)
      if (guardedByMurakami) {
        hurtTeam(foe.characters, dmg, state, '世界尽头与冷酷仙境：这一击摊到全体', seat.characters)
      } else {
        hurt(target, dmg, state, attacker.name)
      }

      // 小马德莱娜时刻：挨了重击（血量掉到两成以下）还活着，回满，冷却六回合
      if (
        target &&
        target.hp > 0 &&
        target.hp <= target.maxHp * 0.2 &&
        foe.characters.some((c) => c.cardId === 'proust') &&
        state.round > (foe.madeleineUntil ?? 0)
      ) {
        foe.madeleineUntil = state.round + 6
        target.hp = target.maxHp
        log(state, `小马德莱娜时刻：${target.name} 缓过来了，血回满`)
      }
      // 普鲁斯特四星：每次挨打（损失现实适性），对方随机一个人丢一个增益
      if (
        target &&
        target.cardId === 'proust' &&
        (target.starRank ?? 1) >= 4 &&
        seat.characters.length > 0
      ) {
        const victim = seat.characters[Math.floor(Math.random() * seat.characters.length)]
        const buff = victim?.statuses.find((s) => BUFF_STATUSES.has(s.name))
        if (victim && buff) {
          victim.statuses = victim.statuses.filter((s) => s !== buff)
          log(state, `${victim.name} 丢了一个『${buff.name}』（每损失五百现实适性）`)
        }
      }
      // 蝴蝶亦周：队友被打到濒死，移出场外两回合，回来时剩两成血
      if (target && target.hp <= 0 && !target.flying && foe.characters.some((c) => c.cardId === 'zhuangzi') && state.round > (foe.butterflyUntil ?? 0)) {
        foe.butterflyUntil = state.round + 6
        target.flying = true
        target.hp = Math.round(target.maxHp * 0.2)
        foe.away = foe.away ?? []
        foe.away.push({ ch: target, turnsLeft: 2 })
        foe.characters = foe.characters.filter((c) => c.uid !== target.uid)
        log(state, `蝴蝶亦周：${target.name} 被带出场外，两回合后回来`)
        return { ok: true }
      }

      if (target.cardId === 'hemingway') {
        const back = Math.round(target.attack)
        hurtTeam(seat.characters, back, state, '丧钟为谁而鸣')
      }
      if (target.cardId === 'dickens') target.cd = 0

      if (target.hp <= 0) {
        const partner = target.stitched ? seat.characters.find((c) => c.uid === target.stitched) : null
        if (partner) {
          partner.hp = Math.max(0, partner.hp - Math.round(Math.abs(target.hp) * 0.5))
          log(state, `缝合断裂，${partner.name} 分担了一半`)
        }
        foe.characters = foe.characters.filter((c) => c.uid !== target.uid)
        log(state, `${target.name} 退场`)
        checkVictory(state)
      }
      return { ok: true }
    }

    case 'skill': {
      const actor = seat.characters.find((c) => c.uid === action.actorId)
      if (!actor) return { error: '没有这个角色' }
      if (hasStatus(actor, '不可行动')) return { error: `${actor.name} 不可行动，发不了主动技` }
      if (seat.blocked?.skillUntil && state.round <= seat.blocked.skillUntil) {
        return { error: '要求多多的餐厅还压着：这回合不能用主动技' }
      }
      // 对面的鳄鱼街：技能全被吞进账里，第三回合那一下直接作废
      if (foe.crocodile) {
        if (foe.crocodile.rounds <= 1) {
          log(state, '鳄鱼街的最后一回合：这次技能被无效化')
          return { ok: true }
        }
        foe.crocodile.bank += 500
        log(state, `鳄鱼街吞掉了这次技能（账上 ${foe.crocodile.bank}）`)
        return { ok: true }
      }
      // 对面有活人偶就抵消一次（舒尔茨的裁缝的人偶）
      if ((foe.dolls ?? 0) > 0) {
        foe.dolls -= 1
        log(state, `${foe.name} 的人偶替这次技能挡下了（剩 ${foe.dolls} 次）`)
        return { ok: true }
      }
      const err = useSkill(state, seat, foe, actor, allyTarget, enemyTarget, action.skillKey)
      if (err) return { error: err }
      return { ok: true }
    }

    case 'livingStrike': {
      // 《活着》：一刀一刀点，每刀选一个目标，每刀吃满手牌加成
      const actor = seat.characters.find((c) => c.uid === action.actorId)
      if (!actor || actor.cardId !== 'yuhua') return { error: '场上没有余华' }
      if (actor.phase !== 'late') return { error: '还停在前期' }
      if ((actor.empathy ?? 0) <= 0) return { error: '共情用完了，砍不动' }
      const pickable = foe.characters.filter((c) => !hasStatus(c, '追忆'))
      const t = (enemyTarget && !hasStatus(enemyTarget, '追忆') ? enemyTarget : null) ?? pickable[0]
      if (!t) return { error: '对面没人可砍' }
      const pending = readPendingDamage(seat)
      let one = Math.round(100 * (1 + (pending.bonusPct ?? 0) / 100)) + (pending.flat ?? 0)
      if (hasStatus(actor, '攻-100')) one -= 100
      if (hasStatus(actor, '梦想')) one += 100
      one = Math.max(1, one)
      actor.empathy -= 1
      hurt(t, one, state, '活着')
      log(state, `${actor.name} 砍了 ${t.name} 一刀：${one} 点现实伤害（共情剩 ${actor.empathy}）`)
      return { ok: true }
    }

    case 'drawExtra': {
      // 普鲁斯特的漫长的回溯之旅：多抽 n 张，自己受 200×n 荒诞伤害
      const proust = seat.characters.find((c) => c.cardId === 'proust')
      if (!proust) return { error: '场上没有普鲁斯特，这条走不通' }
      const n = Math.max(1, Math.min(3, Number(action.n) || 1))
      for (let i = 0; i < n; i += 1) drawHand(seat, state)
      const cost = 200 * n
      hurt(proust, cost, state, '漫长的回溯之旅')
      log(state, `漫长的回溯之旅：多抽 ${n} 张，普鲁斯特受 ${cost} 点荒诞伤害`)
      return { ok: true }
    }

    case 'toggleArt': {
      // 莫言的艺术加工：开／关伤害转化（荒诞除外，所以现实与超现实之间换）
      const moyanOnField = seat.characters.some((c) => c.cardId === 'moyan')
      if (!moyanOnField) return { error: '场上没有莫言，这条走不通' }
      seat.artConvert = !seat.artConvert
      log(state, `艺术加工：${seat.artConvert ? '开了，之后现实伤害转成超现实' : '关了，伤害照旧'}`)
      return { ok: true }
    }

    case 'playHand': {
      if (!seat.hand.includes(action.cardId)) return { error: '手里没有这张' }
      const card = cardOf(state, action.cardId)
      if (!card) return { error: '卡池里没这张' }
      const seal = seat.sealed.find((s) => s.cardId === card.id && state.round < s.untilRound)
      if (seal) return { error: `「${card.name}」还封着，第 ${seal.untilRound} 轮才解` }
      const drop =
        seat.characters.find((c) => c.uid === action.targetId) ??
        foe.characters.find((c) => c.uid === action.targetId) ??
        null
      if (!spendHand(seat)) return { error: '行动值不够' }
      const err = applyHandEffects(state, seat, foe, card, drop)
      if (err) return { error: err }
      seat.hand = seat.hand.filter((id) => id !== action.cardId)
      if (card.type === '食品') seat.foodThisTurn += 1
      const sealedBack = seat.sealed.some((s) => s.cardId === card.id)
      if (!card.once && !sealedBack && !card.effects?.some((e) => e.kind === 'poison')) {
        seat.handPool.push(action.cardId)
      }
      log(state, `${seat.name} 打出 ${card.name}`)
      return { ok: true }
    }

    case 'endTurn': {
      state.pending = null
      // 额外回合结束：交还行动值，不换手、不抽牌
      if (seat.inExtra) {
        seat.inExtra = false
        seat.ap = seat.savedAp ?? 0
        seat.savedAp = undefined
        log(state, `${seat.name} 的额外回合结束，回到原来的回合`)
        return { ok: true }
      }
      tickStatuses(state)
      checkVictory(state)
      if (state.phase !== 'playing') return { ok: true }
      if (seat.extraTurn) {
        seat.extraTurn = false
        log(state, `${seat.name} 的额外回合`)
        startTurn(state)
        return { ok: true }
      }
      state.turnSeat = other(seatIndex)
      if (state.turnSeat === 0) state.round += 1
      startTurn(state)
      return { ok: true }
    }

    case 'resign': {
      state.phase = 'over'
      state.winner = other(seatIndex)
      log(state, `${seat.name} 认输`)
      return { ok: true }
    }

    default:
      return { error: '不认识的动作' }
  }
}
