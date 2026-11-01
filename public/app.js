const $ = (id) => document.getElementById(id)

let ws = null
let cards = { characters: [], handcards: [] }
let handById = new Map()
let mySeat = 0
let state = null
let selAlly = null    // 选中的自己角色
let selEnemy = null   // 选中的对手角色
let heldCard = null   // 拿在手上的那张牌（点击手牌选中，再点角色放上去）
let pendingSkill = null // 需要一个己方目标的主动技（莫言的生死疲劳）
let pendingReplace = false // 场上满了，等着点一个换下去的人
let livingActor = null
let lastLogLine = '' // 余华《活着》：正在一刀一刀砍

// 状态的说明：卡面上挂名字，鼠标停上去看这句
const STATUS_TEXT = {
  易伤100: '受到的伤害 +100',
  '攻-100': '攻击力 -100',
  嘲讽: '对面的攻击必须冲着它来',
  幸福: '期间免疫减益',
  饥饿: '三回合内没用两张食物就即死',
  醉酒: '攻击不再指定目标',
  缝合: '与另一名角色共享血量上限',
  畜生道: '主动技失效，血量按 3000 算',
  硬汉: '每回合开始 +500 血',
  梦想: '每层 +50 伤害',
  残疾: '到六层史铁生就死',
  银河帝国: '基地给的额外护盾',
  砒霜: '再抽到金瓶梅时全队掉一半血',
  蜘蛛丝: '受致命伤时留一点血',
}

/* ── 大厅 ── */
let lastRoom = null
let lastName = null
let heartbeat = null

$('create').onclick = () => {
  lastName = $('name').value || '玩家一'
  connect(() => send({ type: 'create', name: lastName }))
}
$('join').onclick = () => {
  const code = $('code').value.trim()
  if (!/^\d{4}$/.test(code)) return showLobbyMsg('房间号是四位数字')
  lastName = $('name').value || '玩家二'
  lastRoom = code
  connect(() => send({ type: 'join', room: code, name: lastName }))
}
// 随机匹配：进队列，凑齐两人自动开局
$('match').onclick = () => {
  lastName = $('name').value || '玩家'
  connect(() => send({ type: 'queue', name: lastName }))
  showLobbyMsg('正在找对手…')
}
// 单人离线：对面那个位置交给服务端的简单 AI
$('solo').onclick = () => {
  lastName = $('name').value || '玩家'
  connect(() => send({ type: 'create', name: lastName, solo: true }))
  showLobbyMsg('正在摆牌…')
}
function showLobbyMsg(t) { $('lobby-msg').textContent = t }

function connect(onOpen) {
  if (ws && ws.readyState === 1) return onOpen()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}`)
  ws.onopen = () => {
    onOpen()
    clearInterval(heartbeat)
    heartbeat = setInterval(() => send({ type: 'ping' }), 15000)
  }
  ws.onmessage = onMessage
  ws.onclose = () => {
    clearInterval(heartbeat)
    // 断了就自己爬回来，回原房间坐回原位
    if (lastRoom) {
      toast('连接断了，正在重连…')
      setTimeout(() => {
        if (ws.readyState !== 1) connect(() => send({ type: 'join', room: lastRoom, name: lastName }))
      }, 2000)
    } else {
      toast('连接断了，刷新一下页面重来')
    }
  }
  ws.onerror = () => showLobbyMsg('连不上服务')
}

const send = (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg))
const act = (action) => { heldCard = null; send({ type: 'action', action }) }

function onMessage(ev) {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'waiting') {
    showLobbyMsg('正在找对手…有人进来就开局')
    return
  }
  if (msg.type === 'joined') {
    mySeat = msg.seat
    cards = msg.cards
    lastRoom = msg.room
    handById = new Map(cards.handcards.map((c) => [c.id, c]))
    $('lobby').hidden = true
    $('table').hidden = false
    $('room-code').textContent = msg.room
    if (mySeat === 0) toast(`房间 ${msg.room}，把号给对面`)
    return
  }
  if (msg.type === 'state') {
    state = msg.state
    // 手牌和选中不跟着每次广播清掉，不然「拿着一张牌去点角色」走到一半就断了
    if (heldCard && !state.seats[mySeat].hand.includes(heldCard)) heldCard = null
    if (selAlly && !state.seats[mySeat].characters.some((c) => c.uid === selAlly)) selAlly = null
    if (selEnemy && !state.seats[1 - mySeat].characters.some((c) => c.uid === selEnemy)) selEnemy = null
    // 活着模式：余华不在了或者共情清空，就退出
    if (livingActor) {
      const yh = state.seats[mySeat].characters.find((c) => c.uid === livingActor)
      if (!yh || (yh.empathy ?? 0) <= 0) livingActor = null
    }
    // 鳄鱼街吞技能：整块画面压一层紫，写明被封了
    const latest = [...(state.log ?? [])].reverse().find((l) => typeof l === 'string' && (l.includes('鳄鱼街') || l.includes('时间错位')))
    if (latest && latest !== lastLogLine) {
      lastLogLine = latest
      if (latest.includes('推到下一回合') || latest.includes('推到下一回合')) flashScreen('surreal')
    }
    render()
    return
  }
  if (msg.type === 'error') {
    $('hint').textContent = `⚠ ${msg.message}`
    return toast(msg.message)
  }
  if (msg.type === 'peerLeft') return toast('对手离开了')
}

/* ── 渲染 ── */
let lastTopLog = null

function render() {
  if (!state) return
  const mine = state.seats[mySeat]
  const foe = state.seats[1 - mySeat]
  const over = state.phase === 'over'
  const myTurn = state.turnSeat === mySeat && !over

  // 有新的事件就飘一下，别让人猜刚才发生了什么
  const top = state.log?.[0]
  if (top && top !== lastTopLog) {
    lastTopLog = top
    flashEvent(top)
  }

  $('round').textContent = state.round
  $('turn-label').textContent = over
    ? (state.winner === mySeat ? '你赢了' : '你输了')
    : (myTurn ? '轮到你' : '等对面')
  $('ap').textContent = mine.ap
  const bits = []
  if (mine.handCredits > 0) bits.push(`手牌额度剩 ${mine.handCredits}`)
  if (mine.pendingDamage) {
    const p = mine.pendingDamage
    const bits2 = [`${p.damageType ?? '现实'}伤害`]
    if (p.bonusPct) bits2.push(`+${p.bonusPct}%`)
    if (p.fixedBonus) bits2.push(`固定 +${Math.round(p.fixedBonus)}%`)
    if (p.flat) bits2.push(`点数 +${p.flat}`)
    if (p.convertRatioPct) bits2.push(`转成 ${p.convertRatioPct}% 倍`)
    bits.push(`下一击：${bits2.join(' ')}`)
  }
  if (mine.inExtra) bits.push('额外回合（只有 1 点，结束交回）')
  if (mine.delayedSkills?.length) bits.push(`被鳄鱼街扣着 ${mine.delayedSkills.length} 手，下回合才发`)
  if (foe.crocodile) bits.push(`对面的鳄鱼街还开着（剩 ${foe.crocodile.rounds} 回合）`)
  $('credits').textContent = bits.length ? `（${bits.join(' · ')}）` : ''
  $('my-name').textContent = `我方 · ${mine.name}`
  $('my-ap').textContent = `行动值 ${mine.ap} · 场上 ${mine.characters.length}/4`
  $('foe-name').textContent = `对手 · ${foe.name}`
  $('foe-hand').textContent = `手牌 ${foe.hand.length}`
  $('end-turn').disabled = !myTurn

  $('hint').textContent = over
    ? '这一局完了'
    : (!myTurn
      ? '等对面出手'
      : (livingActor
        ? '《活着》：点对面一个角色，砍一刀（每刀一层共情）'
        : (pendingReplace
          ? '点你场上一个角色，把他换下去'
          : (pendingSkill
            ? '莫言在等人：点一名己方角色送进畜生道'
            : (heldCard
              ? `拿着「${esc(handById.get(heldCard)?.name ?? '')}」：点一个角色把它用出去（再点这张牌看详情）`
              : (selAlly
                ? '点对面一个角色就是普攻；或者点自己的「主动技」'
                : '点手牌拿起一张，再点角色放上去；拖也行；点角色看详情'))))))

  renderField($('foe-field'), foe.characters, true, myTurn)
  renderField($('my-field'), mine.characters, false, myTurn)
  renderPending(state.pending, myTurn)
  renderHand(mine.hand, myTurn)
  renderLog(state.log)
  renderOver(over, mySeat)
}

function statusChips(c) {
  if (!(c.statuses || []).length) return ''
  return `<div class="ctraits">${c.statuses
    .map((s) => {
      const label = `${esc(s.name)}${s.turns < 99 ? `·${s.turns}` : ''}`
      const tip = esc(STATUS_TEXT[s.name] ?? s.name)
      return `<span class="trait st" title="${tip}">${label}</span>`
    })
    .join('')}</div>`
}

/* ── 触摸拖拽：手机上 HTML5 拖拽不生效，自己接 pointer ── */
let touchDrag = null
let suppressClick = false

function pointerDown(ev, id, el) {
  if (ev.pointerType === 'mouse') return
  const rect = el.getBoundingClientRect()
  const ghost = el.cloneNode(true)
  ghost.classList.add('ghost')
  ghost.style.width = `${rect.width}px`
  ghost.style.left = `${rect.left}px`
  ghost.style.top = `${rect.top}px`
  document.body.appendChild(ghost)
  touchDrag = { id, ghost, sx: ev.clientX, sy: ev.clientY, moved: false }
  el.setPointerCapture?.(ev.pointerId)
}

function pointerMove(ev) {
  if (!touchDrag) return
  const dx = ev.clientX - touchDrag.sx
  const dy = ev.clientY - touchDrag.sy
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) touchDrag.moved = true
  touchDrag.ghost.style.transform = `translate(${dx}px, ${dy}px)`
  document.querySelectorAll('.card.dropok').forEach((x) => x.classList.remove('dropok'))
  const under = document.elementFromPoint(ev.clientX, ev.clientY)
  const cardEl = under?.closest('.card')
  if (cardEl?.dataset.uid) cardEl.classList.add('dropok')
}

function pointerUp(ev) {
  if (!touchDrag) return
  const { id, ghost, moved } = touchDrag
  ghost.remove()
  document.querySelectorAll('.card.dropok').forEach((x) => x.classList.remove('dropok'))
  touchDrag = null
  if (!moved) return // 没动＝点击，交给 onclick
  suppressClick = true
  setTimeout(() => { suppressClick = false }, 250)
  const under = document.elementFromPoint(ev.clientX, ev.clientY)
  const cardEl = under?.closest('.card')
  if (cardEl?.dataset.uid) useCardOn(id, cardEl.dataset.uid)
}

document.addEventListener('pointermove', pointerMove)
document.addEventListener('pointerup', pointerUp)
document.addEventListener('pointercancel', pointerUp)

let hpSnapshot = new Map() // uid -> 上次看到的血量，用来做受击特效

function renderField(el, list, isFoe, myTurn) {
  el.innerHTML = ''
  if (list.length === 0) {
    el.innerHTML = '<div class="pending-note">场上还空着</div>'
    return
  }
  for (const c of list) {
    const card = document.createElement('div')
    card.className = 'card lv' + (c.level ?? 3)
    card.dataset.uid = c.uid
    // 掉血了就抖一下，飘个伤害数字
    const prevHp = hpSnapshot.get(c.uid)
    const lost = prevHp !== undefined && c.hp < prevHp ? prevHp - c.hp : 0
    hpSnapshot.set(c.uid, c.hp)
    if (lost > 0) {
      card.classList.add('hit')
      const dmg = document.createElement('div')
      dmg.className = 'dmg'
      dmg.textContent = `-${lost}`
      card.appendChild(dmg)
      flashScreen()
    }
    if ((isFoe ? selEnemy : selAlly) === c.uid) card.classList.add('selected')
    if (myTurn) card.classList.add('clickable')

    // 手牌拖到任意角色身上就生效
    if (myTurn) {
      card.addEventListener('dragover', (ev) => { ev.preventDefault(); card.classList.add('dropok') })
      card.addEventListener('dragleave', () => card.classList.remove('dropok'))
      card.addEventListener('drop', (ev) => {
        ev.preventDefault()
        card.classList.remove('dropok')
        const id = ev.dataTransfer.getData('text/plain')
        if (id) useCardOn(id, c.uid)
      })
    }

    card.onclick = () => {
      if (!myTurn) return
      // 场上满了，点一个自己人换下去
      if (pendingReplace && !isFoe) {
        act({ type: 'acceptDraw', replaceUid: c.uid })
        pendingReplace = false
        return
      }
      // 主动技要点自己人（莫言）
      if (pendingSkill && !isFoe) {
        act({ type: 'skill', actorId: pendingSkill, targetId: c.uid })
        pendingSkill = null
        return
      }
      // 手机上拖不动，所以点选也能用：拿着牌点角色就生效
      if (heldCard) return useCardOn(heldCard, c.uid)
      if (isFoe) {
        // 活着：点谁砍谁，一刀一层共情
        if (livingActor) return act({ type: 'livingStrike', actorId: livingActor, targetId: c.uid })
        if (selAlly) return act({ type: 'attack', attackerId: selAlly, targetId: c.uid })
        selEnemy = selEnemy === c.uid ? null : c.uid
        render()
        return
      }
      selAlly = selAlly === c.uid ? null : c.uid
      render()
    }

    card.innerHTML = `
      <div class="cname">${esc(c.name)}<span class="star">${'★'.repeat(c.starRank ?? 1)}</span></div>
      <div class="cmate">${esc(c.title)} · ${c.level} 级 · 攻 ${c.attack}</div>
      <div class="cstats"><span>血 <b>${c.hp}</b>/${c.maxHp}</span>${c.shield > 0 ? `<span class="shield real">现实盾 ${c.shield}</span>` : ''}${(c.shieldSurreal ?? 0) > 0 ? `<span class="shield surreal">超现实盾 ${c.shieldSurreal}</span>` : ''}</div>
      <div class="hpbar${c.hp / c.maxHp < 0.35 ? ' low' : ''}"><i style="width:${Math.max(0, (c.hp / c.maxHp) * 100)}%"></i></div>
      ${(c.traits || []).length ? `<div class="ctraits">${c.traits.map((t) => `<span class="trait">${esc(t)}</span>`).join('')}</div>` : ''}
      ${statusChips(c)}
      ${c.cardId === 'yuhua' ? `<div class="cspecial muted">${c.phase === 'late' ? `共情 ${c.empathy ?? 0}` : `锋利 ${c.sharp ?? 0}/8`}</div>` : ''}
      ${c.disability ? `<div class="cspecial muted">残疾 ${c.disability} 层</div>` : ''}
      ${c.dreams ? `<div class="cspecial muted">梦想 ${c.dreams} 层</div>` : ''}
      ${c.active ? `<div class="cspecial">主动 · ${esc(c.active.name)}${c.cd > 0 ? ` · 冷却 ${c.cd}` : ''}</div>` : ''}
      ${c.passive ? `<div class="cspecial">被动 · ${esc(c.passive.name)}</div>` : ''}
    `

    const bar = document.createElement('div')
    bar.className = 'cardbar'
    const detailBtn = document.createElement('button')
    detailBtn.className = 'btn tiny'
    detailBtn.textContent = '详情'
    detailBtn.onclick = (ev) => { ev.stopPropagation(); showDetail(c) }
    bar.appendChild(detailBtn)

    // 在畜生道里的人，能自己走出来
    if (!isFoe && myTurn && (c.statuses || []).some((s) => s.name === '畜生道')) {
      const exit = document.createElement('button')
      exit.className = 'btn tiny'
      exit.textContent = '退出畜生道'
      exit.onclick = (ev) => { ev.stopPropagation(); act({ type: 'exitButchery', targetId: c.uid }) }
      bar.appendChild(exit)
    }

    if (!isFoe && myTurn) {
      const atk = document.createElement('button')
      atk.className = 'btn tiny'
      atk.textContent = '普攻'
      atk.onclick = (ev) => {
        ev.stopPropagation()
        selAlly = c.uid
        selEnemy = null
        render()
        toast(`用 ${c.name} 普攻：点对面一个角色`)
      }
      bar.appendChild(atk)

      // 海明威进了硬汉，这一招就封住了
      const hlocked = c.cardId === 'hemingway' && (c.statuses || []).some((s) => s.name === '硬汉')
      if (c.active && !hlocked) {
        const sk = document.createElement('button')
        sk.className = 'btn tiny'
        sk.textContent = c.cd > 0 ? `冷却 ${c.cd}` : '主动技'
        sk.disabled = c.cd > 0
        sk.onclick = (ev) => {
          ev.stopPropagation()
          // 莫言的生死疲劳要自己挑一个人送进畜生道
          if (c.cardId === 'moyan') {
            pendingSkill = c.uid
            render()
            toast('点一名己方角色，把他送进畜生道')
            return
          }
          // 有好几招的角色：先挑一招
          const opts = skillOptions(c)
          if (opts.length > 1) {
            pickSkill(c, opts)
            return
          }
          act({ type: 'skill', actorId: c.uid, skillKey: opts[0]?.key, targetId: selAlly === c.uid ? selAlly : undefined, enemyTargetId: selEnemy ?? undefined })
        }
        bar.appendChild(sk)
      }

      // 莫言在场就有这一档：要不要把这次伤害转成另一种
      if (c.cardId === 'moyan') {
        const art = document.createElement('button')
        const on = state.seats[mySeat].artConvert
        art.className = `btn tiny${on ? ' primary' : ''}`
        art.textContent = on ? '艺术加工：开' : '艺术加工：关'
        art.onclick = (ev) => { ev.stopPropagation(); act({ type: 'toggleArt' }) }
        bar.appendChild(art)
      }
    }
    card.appendChild(bar)
    el.appendChild(card)
  }
}

function useCardOn(cardId, targetUid) {
  act({ type: 'playHand', cardId, targetId: targetUid })
}

// 一个角色有几招可选
function skillOptions(c) {
  if (c.cardId === 'yuhua') {
    return c.phase === 'late'
      ? [{ key: 'huozhe', name: '活着' }, { key: 'xiongdi', name: '兄弟' }]
      : [{ key: 'xianshi', name: '现实一种' }, { key: 'xianxue', name: '鲜血梅花' }]
  }
  if (c.cardId === 'zhuangzi') {
    return [
      { key: 'xiaoyao', name: '逍遥游' },
      { key: 'qiwu', name: '齐物论' },
      { key: 'yangsheng', name: '养生主' },
    ]
  }
  if (c.cardId === 'schulz') {
    return [
      { key: 'renou', name: '裁缝的人偶' },
      { key: 'liaoyang', name: '疗养院' },
      { key: 'eyu', name: '鳄鱼街' },
    ]
  }
  return []
}

function pickExtra() {
  const btns = [1, 2, 3]
    .map((n) => `<button class="btn small${n === 1 ? ' primary' : ''}" data-n="${n}">${n} 张（受 ${200 * n} 荒诞伤害）</button>`)
    .join(' ')
  openPanel(`
    <div class="detail-head"><span>漫长的回溯之旅：多抽几张</span></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">${btns}</div>
  `)
  for (const b of $('detail').querySelectorAll('button[data-n]')) {
    b.onclick = () => {
      $('detail').hidden = true
      act({ type: 'drawExtra', n: Number(b.dataset.n) })
    }
  }
}

function pickSkill(c, opts) {  const btns = opts
    .map((o, i) => `<button class="btn small${i === 0 ? ' primary' : ''}" data-key="${o.key}">${o.name}</button>`)
    .join(' ')
  openPanel(`
    <div class="detail-head"><span>${esc(c.name)} 用哪一招</span></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">${btns}</div>
  `)
  for (const b of $('detail').querySelectorAll('button[data-key]')) {
    b.onclick = () => {
      const key = b.dataset.key
      $('detail').hidden = true
      // 活着：进入一刀一刀点的状态，每刀自己选目标
      if (c.cardId === 'yuhua' && key === 'huozhe') {
        livingActor = c.uid
        render()
        toast('《活着》：点对面一个角色，砍一刀')
        return
      }
      act({
        type: 'skill',
        actorId: c.uid,
        skillKey: key,
        targetId: selAlly === c.uid ? selAlly : undefined,
        enemyTargetId: selEnemy ?? undefined,
      })
    }
  }
}

function openPanel(html) {  const box = $('detail')
  box.innerHTML = `${html}<div style="margin-top:14px"><button class="btn small" id="detail-close">收起</button></div>`
  box.hidden = false
  $('detail-close').onclick = () => { box.hidden = true }
  box.onclick = (ev) => { if (ev.target === box) box.hidden = true }
}

function showCardDetail(c) {
  if (!c) return
  openPanel(`
    <div class="detail-head"><span>${esc(c.name)}　${esc(c.type ?? '')}</span></div>
    <div class="detail-block"><p>${esc(c.text ?? '')}</p>
    ${c.flavor ? `<p class="muted">${esc(c.flavor)}</p>` : ''}</div>
    <div class="detail-block muted">打出后洗回卡池${c.once ? '（这张用完不洗回）' : ''}${(c.effects || []).length ? '' : '；效果还没接进引擎'}</div>
    <div class="detail-block muted">用法：把它拖到自己或对面场上的角色身上</div>
  `)
}

function showDetail(c) {
  const box = $('detail')
  const stars = (c.stars || []).map((s, i) => `<li><b>★${i + 1}</b> ${esc(s)}</li>`).join('')
  const extra = (c.extra || []).map((e) => `<li><b>${esc(e.name)}</b> ${esc(e.text)}</li>`).join('')
  box.innerHTML = `
    <div class="detail-head">
      <span>${esc(c.name)}　${esc(c.title)} · ${c.level} 级 · ${'★'.repeat(c.starRank ?? 1)}</span>
      <button class="btn tiny" id="detail-close">收起</button>
    </div>
    <div class="detail-stats">血 ${c.hp}/${c.maxHp}　攻 ${c.attack}　护盾 ${c.shield}　适性 ${(c.traits || []).join('、') || '无'}</div>
    ${c.active ? `<div class="detail-block"><b>主动技 · ${esc(c.active.name)}</b>${c.active.cd ? `（CD ${c.active.cd}）` : ''}<p>${esc(c.active.text)}</p>${c.active.note ? `<p class="muted">${esc(c.active.note)}</p>` : ''}</div>` : ''}
    ${c.passive ? `<div class="detail-block"><b>被动 · ${esc(c.passive.name)}</b><p>${esc(c.passive.text)}</p></div>` : ''}
    ${extra ? `<div class="detail-block"><b>另外</b><ul>${extra}</ul></div>` : ''}
    ${stars ? `<div class="detail-block"><b>星级</b><ul>${stars}</ul></div>` : ''}
    ${(c.disability || c.dreams) ? `<div class="detail-block"><b>层数</b><p>${c.disability ? `残疾 ${c.disability} 层` : ''}${c.disability && c.dreams ? '　' : ''}${c.dreams ? `梦想 ${c.dreams} 层` : ''}</p></div>` : ''}
    ${(c.statuses || []).length ? `<div class="detail-block"><b>当前状态</b><p>${c.statuses.map((s) => `${esc(s.name)}${s.turns < 99 ? `（${s.turns} 回合）` : ''}：${esc(STATUS_TEXT[s.name] ?? '')}`).join('；')}</p></div>` : ''}
  `
  box.hidden = false
  $('detail-close').onclick = () => { box.hidden = true }
}

function renderPending(pending, myTurn) {
  const slot = $('pending-slot')
  slot.innerHTML = ''
  if (!pending) return
  if (pending.hidden) {
    slot.innerHTML = '<div class="pending-note">对面正在读一张牌……</div>'
    return
  }
  const card = document.createElement('div')
  card.className = 'card pending-card'
  card.onclick = () => showDetail(pending)
  card.innerHTML = `
    <div class="cname">${esc(pending.name)}<span class="star">${'★'.repeat(pending.starRank ?? 1)}</span></div>
    <div class="cmate">${esc(pending.title)} · ${pending.level} 级 · 攻 ${pending.attack}</div>
    <div class="cstats"><span>血 <b>${pending.hp}</b>/${pending.maxHp}</span><span>盾 ${pending.shield}</span></div>
    ${pending.active ? `<div class="cspecial">主动 · ${esc(pending.active.name)}</div>` : ''}
    ${pending.passive ? `<div class="cspecial">被动 · ${esc(pending.passive.name)}</div>` : ''}
    <div class="cspecial muted">点一下看全文</div>
  `
  slot.appendChild(card)
  if (!myTurn) return
  const actions = document.createElement('div')
  actions.className = 'pending-actions'
  const myChars = state.seats[mySeat].characters
  const full = myChars.length >= 4
  const dup = myChars.find((c) => c.cardId === pending.cardId)
  const read = document.createElement('button')
  read.className = 'btn small primary'
  if (dup) {
    const lv = dup.starRank ?? 1
    read.textContent = lv >= 3 ? '同名已三星（这张作废）' : `同名升星（${dup.name} → ${lv + 1} 星）`
  } else {
    read.textContent = full ? '替换一位上场' : '阅读（上场）'
  }
  read.onclick = () => {
    if (full && !dup) {
      pendingReplace = true
      render()
      toast('点你场上一个角色，把他换下去')
      return
    }
    act({ type: 'acceptDraw' })
  }
  actions.appendChild(read)

  if (pending.level >= 4 && (pending.starRank ?? 1) < 3) {
    const re = document.createElement('button')
    re.className = 'btn small'
    re.textContent = pending.level === 5 ? '返还，换两次重抽' : '返还重抽'
    re.onclick = () => act({ type: 'reroll' })
    actions.appendChild(re)
  } else {
    const note = document.createElement('div')
    note.className = 'pending-note'
    note.textContent = (pending.starRank ?? 1) >= 3 ? '三星了，没有重抽机会' : '三级角色不能返还'
    actions.appendChild(note)
  }

  const skip = document.createElement('button')
  skip.className = 'btn small'
  skip.textContent = '不读这张'
  skip.onclick = () => act({ type: 'discardDraw' })
  actions.appendChild(skip)
  slot.appendChild(actions)
}

function renderHand(hand, myTurn) {
  const row = $('hand')
  row.innerHTML = ''
  // 普鲁斯特在场：可以回溯抽牌
  if (myTurn && state?.seats?.[mySeat]?.characters?.some((c) => c.cardId === 'proust' && c.hp > 0)) {
    const btn = document.createElement('button')
    btn.className = 'btn small'
    btn.textContent = '+ 回溯抽牌'
    btn.onclick = () => pickExtra()
    row.appendChild(btn)
  }
  if (hand.length === 0) {
    row.innerHTML += '<div class="pending-note">手上没牌</div>'
    return
  }
  for (const id of hand) {
    if (id === 'hidden') {
      const back = document.createElement('div')
      back.className = 'handcard back'
      row.appendChild(back)
      continue
    }
    const c = handById.get(id)
    const el = document.createElement('div')
    // 食物和书用两种底子，一眼能分开
    const kind = (c?.type ?? '').includes('食') ? 'food' : ((c?.type ?? '').includes('书') ? 'book' : 'other')
    el.className = 'handcard ' + kind + (heldCard === id ? ' held' : '')
    el.innerHTML = `
      <div class="hname">${esc(c?.name ?? id)}</div>
      <div class="htype">${esc(c?.type ?? '')}</div>
      <div class="hnote">${esc((c?.text ?? '').slice(0, 40))}${(c?.text ?? '').length > 40 ? '…' : ''}</div>
    `
    if (myTurn) {
      el.draggable = true
      el.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', id)
        ev.dataTransfer.effectAllowed = 'move'
        el.classList.add('dragging')
        heldCard = id
      })
      el.addEventListener('dragend', () => el.classList.remove('dragging'))
      // 手机上用手指拖
      el.addEventListener('pointerdown', (ev) => pointerDown(ev, id, el))
      // 点一下先拿起这张牌；再点同一张才看详情
      el.onclick = () => {
        if (suppressClick) return
        if (heldCard === id) {
          heldCard = null
          render()
          showCardDetail(c)
          return
        }
        heldCard = id
        render()
        toast(`拿着「${c?.name ?? ''}」：点一个角色把它用出去`)
      }
    }
    row.appendChild(el)
  }
}

function renderLog(log = []) {
  const mine = state?.seats?.[mySeat]?.name ?? ''
  $('log').innerHTML = log
    .map((line) => `<li${mine && line.includes(mine) ? ' class="mine"' : ''}>${esc(line)}</li>`)
    .join('')
}

function renderOver(over, seat) {
  const box = $('over')
  if (!over) { box.hidden = true; return }
  const win = state.winner === seat
  box.hidden = false
  box.innerHTML = `
    <div class="over-title">${win ? '你赢了' : '你输了'}</div>
    <div class="over-sub">第 ${state.round} 轮结束</div>
  `
  const again = document.createElement('button')
  again.className = 'btn primary'
  again.textContent = '再来一局'
  again.onclick = () => send({ type: 'restart' })
  box.appendChild(again)
  const hide = document.createElement('button')
  hide.className = 'btn'
  hide.textContent = '收起来'
  hide.onclick = () => { box.hidden = true }
  box.appendChild(hide)
}

$('end-turn').onclick = () => {
  selAlly = null
  selEnemy = null
  heldCard = null
  act({ type: 'endTurn' })
}
$('resign').onclick = () => {
  if (confirm('认输这一局？')) act({ type: 'resign' })
}

/* ── 小工具 ── */
let flashTimer2 = null
function flashScreen(kind) {
  const t = $('table')
  if (!t) return
  t.classList.remove('quake')
  void t.offsetWidth
  t.classList.add(kind === 'surreal' ? 'drained' : 'quake')
  clearTimeout(flashTimer2)
  flashTimer2 = setTimeout(() => t.classList.remove('quake', 'drained'), 900)
}

let toastTimer = null
function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 4200)
}

let flashTimer = null
function flashEvent(text) {
  const el = $('event')
  if (!el) return
  el.textContent = text
  el.hidden = false
  el.classList.remove('pop')
  void el.offsetWidth
  el.classList.add('pop')
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { el.hidden = true }, 3600)
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
