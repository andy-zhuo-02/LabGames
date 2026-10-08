import {
  createGame,
  applyAction,
  publicView,
  validateSave,
  currentActor,
  pendingEffect,
  numbers,
  roundPoints,
  hasSecond,
  canStay,
  cardLabel,
  TARGET_SCORE,
} from "/src/game.js";
import { chooseBotAction } from "/src/bot.js";
import { CARD_ART, cardArtKey, cardArtwork } from "/card-art.js";

const SAVE_KEY = "labgames.flip7.save.v1";
const PREF_KEY = "labgames.flip7.preferences.v1";
const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
let game = null;
let screen = "home";
let botTimer;
let toastTimer;
let prefs = { opponents: 2, speed: "normal", sound: false, name: "你" };
let audioContext;
let storageWarning = false;
let lastFocus;

try {
  const savedPrefs = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
  if (savedPrefs && typeof savedPrefs === "object") {
    if ([2, 3, 4, 5].includes(savedPrefs.opponents))
      prefs.opponents = savedPrefs.opponents;
    if (["normal", "fast"].includes(savedPrefs.speed))
      prefs.speed = savedPrefs.speed;
    prefs.sound = savedPrefs.sound === true;
    if (typeof savedPrefs.name === "string")
      prefs.name = savedPrefs.name.slice(0, 16);
  }
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
  if (saved && validateSave(saved)) {
    game = saved;
    screen = "game";
  } else if (saved) toast("旧存档无法读取，请开始一局新游戏。");
} catch {
  toast("无法读取本地存档。本次仍可正常游玩。");
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const statusNames = {
  active: "本轮进行中",
  banked: "已收手",
  frozen: "已冻结",
  busted: "爆牌 · 0 分",
  flip7: "FLIP 7 · +15",
};
const styles = { careful: "稳健派", balanced: "策略派", bold: "冒险派" };
const BOT_NAMES = ["小橘", "阿栗", "薄荷", "小蓝", "桃子"];
const icon = (name, size = 20) => {
  const paths = {
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    sound:
      '<path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    mute: '<path d="m11 5-6 4H2v6h3l6 4V5Zm5 4 5 6m0-6-5 6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',
    home: '<path d="m3 10 9-7 9 7v10H3V10Zm6 10v-7h6v7"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6"/>',
    snow: '<path d="M12 2v20M3 7l18 10M3 17 21 7M9 4l3 3 3-3M9 20l3-3 3 3M3 10l4-1-1-4m12 14-1-4 4-1M3 14l4 1-1 4M18 5l-1 4 4 1"/>',
    trophy:
      '<path d="M8 3h8v7a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 2v5m-5 2h10"/>',
    cards:
      '<rect x="8" y="3" width="12" height="17" rx="2"/><path d="M5 6H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10m0-15v9m-3-6h6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    replay: '<path d="M3 10a9 9 0 1 1 2 9M3 4v6h6"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.cards}</svg>`;
};

function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 4500);
}
function persist() {
  try {
    if (game) localStorage.setItem(SAVE_KEY, JSON.stringify(game));
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    if (!storageWarning) {
      toast("浏览器无法保存进度，请保持当前页面开启。");
      storageWarning = true;
    }
  }
}
function sound(kind = "draw") {
  if (!prefs.sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => {});
    }
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    const now = audioContext.currentTime;
    oscillator.frequency.setValueAtTime(
      kind === "bust" ? 150 : kind === "bank" ? 650 : 420,
      now,
    );
    oscillator.frequency.exponentialRampToValueAtTime(
      kind === "bust" ? 65 : 800,
      now + 0.13,
    );
    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    oscillator.start();
    oscillator.stop(now + 0.2);
  } catch {
    /* Audio is optional and must never block the game. */
  }
}

function cardMarkup(card, small = false, fresh = false) {
  if (!card)
    return '<div class="empty-card" aria-hidden="true"><span>+</span></div>';
  const isNumber = card.kind === "number";
  const label = cardLabel(card);
  return `<button type="button" class="card ${small ? "small" : ""} ${fresh ? "fresh" : ""}" data-action="inspect-card" data-card="${cardArtKey(card)}" aria-label="${escape(label)}${isNumber ? " 点数字牌" : ""}，查看牌面" title="${escape(label)} · 点击放大">${cardArtwork(cardArtKey(card))}</button>`;
}

function header() {
  return `<header class="topbar"><button class="brand" data-action="home" aria-label="七连翻首页"><img src="/art/flip7-logo.png" alt="Flip 7" width="197" height="120"><span>七连翻<small>PRESS YOUR LUCK!</small></span></button>
    <div class="top-center">翻开好运 <span class="divider">✦</span> 冲向 200 分</div>
    <nav aria-label="游戏菜单"><button class="icon-button sound-toggle" data-action="sound" aria-label="${prefs.sound ? "关闭" : "开启"}音效" aria-pressed="${prefs.sound}">${icon(prefs.sound ? "sound" : "mute")}</button><button class="text-button" data-action="rules">${icon("help")}<span>玩法说明</span></button></nav>
  </header>`;
}

function homeMarkup() {
  return `<main class="home-layout"><section class="hero"><p class="eyebrow ribbon">PRESS YOUR LUCK! · RACE TO 200!</p>
    <img class="hero-logo" src="/art/flip7-logo.png" alt="FLIP 7" width="197" height="120">
    <h1>敢不敢，<span class="accent">再翻一张？</span></h1>
    <p class="hero-description"><span>七个不同数字，十五分额外奖励。</span><span>继续翻牌，或见好就收——好运由你决定！</span></p>
    <div class="hero-fan" aria-label="集齐七张不同数字牌可获得额外15分">${[2, 4, 6, 7, 9, 10, 12].map((n, i) => `<div class="fan-card fan-${i}">${cardMarkup({ kind: "number", value: n })}</div>`).join("")}<span class="bonus-sticker">FLIP 7<br><b>+15</b> 分</span></div>
    <div class="hero-foot"><span>✦ 翻牌</span><span>✦ 别重复</span><span>✦ 冲击 200 分</span></div>
  </section><section class="setup-panel"><div class="panel-crest" aria-hidden="true">✦</div><p class="eyebrow">TAKE A SEAT & TAKE A CHANCE</p><h2>好运，就从这一局开始</h2><p class="muted">单人对战电脑 · 随时开桌</p>
    <form id="setup-form"><label for="player-name">你的称呼</label><input id="player-name" name="name" maxlength="16" autocomplete="nickname" placeholder="你" value="${escape(prefs.name)}">
    <label for="opponents">电脑对手</label><div class="select-wrap"><select id="opponents" name="opponents">${[2, 3, 4, 5].map((n) => `<option value="${n}" ${prefs.opponents === n ? "selected" : ""}>${n} 位对手 · ${n + 1} 人牌桌</option>`).join("")}</select></div>
    <div class="opponent-preview"><span class="avatar avatar-1">橘</span><span class="avatar avatar-2">栗</span><span class="muted">不同性格，同样跃跃欲试。</span></div>
    <button class="primary wide" type="submit">${game ? "开始新对局" : "开始游戏"} ${icon("arrow")}</button></form>
    ${game ? '<button class="secondary wide continue" data-action="continue">继续上次对局</button>' : ""}
    <p class="save-hint">${icon("check", 15)} 自动保存进度，随时回来接着玩</p>
    <button class="art-link" type="button" data-action="cards">认识全部 22 种牌面 ↗</button><div class="quick-rule"><span>HIT OR STAY? · 翻，还是停？</span><p>翻到重复数字，本轮得分归零。<br>及时收手，就能把分数装进口袋。</p></div>
  </section></main><footer class="site-footer"><span>PRESS YOUR LUCK! · 冲击 200 分</span><span>FLIP 7 · 非官方练习版</span></footer>`;
}

function statusStamp(p, animate) {
  const stamps = {
    banked: ["已收手", "BANKED", `锁定 +${roundPoints(p)} 分`],
    busted: ["爆牌", "BUST!", "本轮 0 分"],
    frozen: ["已冻结", "FROZEN", `保留 +${roundPoints(p)} 分`],
    flip7: ["七连翻", "FLIP 7!", "额外奖励 +15 分"],
  };
  const stamp = stamps[p.status];
  if (!stamp) return "";
  return `<div class="status-stamp stamp-${p.status} ${animate ? "stamp-enter" : ""}" role="img" aria-label="${escape(p.name)}：${stamp[0]}，${stamp[2]}"><div class="stamp-face" aria-hidden="true"><span class="stamp-kicker">${stamp[1]}</span><strong>${stamp[0]}</strong><span class="stamp-detail">${stamp[2]}</span></div></div>`;
}

function playerMarkup(p, index, stampedPlayers) {
  const actor = currentActor(game);
  const me = p.id === "you";
  const cards = p.cards.filter((c) => c.kind === "number");
  const modifiers = p.cards.filter((c) => c.kind !== "number");
  const freshId =
    game.lastDraw?.playerId === p.id ? game.lastDraw.card.id : null;
  const slots = Array.from({ length: Math.max(0, 7 - cards.length) }, () =>
    cardMarkup(null),
  ).join("");
  return `<section class="player ${me ? "self" : "opponent"} ${actor === p.id ? "is-turn" : ""} is-${p.status}" aria-label="${escape(p.name)}的牌区">
    <div class="player-heading"><div class="identity"><span class="avatar avatar-${index}">${escape(me ? prefs.name.slice(0, 1) || "你" : p.name.slice(-1))}</span><div><h2>${escape(p.name)} ${me ? '<span class="you-badge">YOU</span>' : ""}</h2><span class="player-subtitle">${me ? "你的手牌" : `<span class="bot-kind">电脑 · </span>${styles[p.style]}`}</span></div></div>
    <div class="player-state">${actor === p.id ? '<span class="turn-badge"><span class="live-dot"></span>正在行动</span>' : `<span class="status-label">${statusNames[p.status]}</span>`}<div class="round-points"><b>${roundPoints(p)}</b><span>本轮分</span></div></div></div>
    <div class="hand-stage ${p.status !== "active" ? "is-settled" : ""}"><div class="hand-cards">${modifiers.length ? `<div class="special-hand" aria-label="${escape(p.name)}的特殊牌">${modifiers.map((c) => cardMarkup(c, true, c.id === freshId)).join("")}</div>` : ""}
    <div class="hand ${me ? "large-hand" : ""}">${cards.map((c) => cardMarkup(c, !me, c.id === freshId)).join("")}${slots}</div>
    </div>${statusStamp(p, stampedPlayers.has(p.id))}</div>
    <div class="hand-footer"><span class="card-count">${p.status === "busted" ? "这次冒险，下轮再来" : `${cards.length} / 7 张不同数字`}</span><div class="modifiers">${modifiers.map((c) => `<span class="modifier ${c.kind}" title="${escape(cardLabel(c))}">${c.kind === "second" ? icon("shield", 14) : c.kind === "freeze" ? icon("snow", 14) : ""}${escape(cardLabel(c))}</span>`).join("")}${!modifiers.length && me && p.status === "active" ? '<span class="muted">集齐 7 张，额外 +15 分</span>' : ""}</div></div>
  </section>`;
}

function controlsMarkup() {
  const actorId = currentActor(game);
  const effect = pendingEffect(game);
  const me = game.players.find((p) => p.id === "you");
  if (game.phase !== "playing") return resultMarkup();
  if (effect) {
    const owner = game.players.find((p) => p.id === effect.owner);
    return `<section class="action-panel targeting"><div><span class="eyebrow">${effect.owner === "you" ? "由你决定" : "特殊牌"}</span><h3>${escape(owner.name)}翻出了${escape(cardLabel(effect.card))}</h3><p>${effect.card.kind === "freeze" ? "选择一位玩家，让 TA 立即收手并保留分数。" : effect.card.kind === "three" ? "选择一位玩家，让 TA 连续接受三张牌。" : "你已有第二次机会，将这张送给另一位玩家。"}</p></div><div class="target-buttons">${effect.owner === "you" ? effect.targets.map((id) => `<button class="target-button" data-action="target" data-target="${escape(id)}">${escape(game.players.find((p) => p.id === id).name)}${id === "you" ? "（自己）" : ""}${icon("arrow", 16)}</button>`).join("") : '<span class="thinking">电脑正在选择<span>···</span></span>'}</div></section>`;
  }
  const myTurn = actorId === "you";
  const actor = game.players.find((p) => p.id === actorId);
  return `<section class="action-panel"><div class="action-prompt"><span class="eyebrow">${myTurn ? "YOUR MOVE" : "TAKE A BREATH"}</span><h3>${myTurn ? "好运，还要继续吗？" : me.status === "active" ? `${escape(actor.name)}正在思考…` : "你的本轮已结束"}</h3><p>${myTurn ? (hasSecond(me) ? "第二次机会在手，可抵消一次重复数字。" : "重复即爆牌，收手就能保住本轮分数。") : me.status === "active" ? "下一次翻牌，也许就能改变牌局。" : `等待其他玩家完成本轮 · ${escape(actor.name)}行动中`}</p></div>
    <div class="action-buttons"><button class="secondary bank-button" data-action="stay" ${!myTurn || !canStay(me) ? "disabled" : ""}>${icon("check")} 收手 <b>+${roundPoints(me)}</b><kbd>S</kbd></button><button class="primary hit-button" data-action="hit" ${!myTurn ? "disabled" : ""}>${icon("cards")} 再翻一张 <kbd>空格</kbd></button></div></section>`;
}

function resultMarkup() {
  const done = game.phase === "finished";
  const winner = game.players.find((p) => p.id === game.winner);
  const round = game.history.at(-1);
  const flip = game.players.find((p) => p.id === round?.flipId);
  return `<section class="round-result ${done ? "game-result" : ""}" aria-live="polite"><div class="result-symbol">${icon(done ? "trophy" : "check", 30)}</div><div class="result-heading"><span class="eyebrow">${done ? "WELL PLAYED" : `ROUND ${String(game.round).padStart(2, "0")} COMPLETE`}</span><h3>${done ? `${escape(winner.name)}获胜！` : flip ? `${escape(flip.name)}达成七连翻！` : "这一轮，稳稳落袋。"}</h3><p>${done ? `${winner.score} 分 · ${game.round} 轮较量，感谢每一次勇敢的翻牌。` : Math.max(...game.players.map((p) => p.score)) >= 200 ? "最高分并列！所有玩家再比一轮。" : "分数已记好，准备迎接下一轮好运。"}</p></div><button class="primary" data-action="${done ? "new" : "next"}">${done ? "再来一局" : "下一轮"} ${icon("arrow")}</button><div class="round-deltas">${game.players.map((p) => `<span>${escape(p.name)} <b class="${p.status === "busted" ? "zero" : ""}">+${p.roundScore}</b></span>`).join("")}</div></section>`;
}

function sidebarMarkup() {
  const ranked = [...game.players].sort((a, b) => b.score - a.score);
  return `<aside class="sidebar"><section class="scoreboard"><div class="section-title"><h2>${icon("trophy", 18)} 积分榜</h2><span>目标 ${TARGET_SCORE}</span></div><div class="score-list">${ranked.map((p, i) => `<div class="score-row ${p.id === "you" ? "your-score" : ""}"><span class="rank">${String(i + 1).padStart(2, "0")}</span><span class="score-name">${escape(p.name)}${p.id === "you" ? "<small>你</small>" : ""}</span><b>${p.score}</b><div class="score-track"><progress max="200" value="${Math.min(p.score, 200)}" aria-label="${escape(p.name)}总分 ${p.score}"></progress></div></div>`).join("")}</div><button class="link-button" data-action="history">查看每轮得分 ${icon("arrow", 15)}</button></section>
    <section class="activity"><div class="section-title"><h2>牌桌动态</h2><span class="live-dot"></span></div><ol class="event-list" aria-label="最近牌桌动态">${game.events
      .slice(-7)
      .reverse()
      .map(
        (e, i) =>
          `<li class="event-${e.type} ${i === 0 ? "latest" : ""}"><span class="event-dot"></span><p>${escape(e.text)}</p></li>`,
      )
      .join("")}</ol></section>
    <div class="table-note"><span>GOOD TO KNOW</span><p>数字越大，牌越多。<br>12 有 12 张，1 只有 1 张。<br>高分，也意味着更容易遇见。</p></div></aside>`;
}

function gameMarkup(stampedPlayers) {
  const me = game.players.find((p) => p.id === "you");
  const opponents = game.players.filter((p) => p.id !== "you");
  return `<main class="game-layout"><div class="table-top"><div><p class="eyebrow">THE LUCKY TABLE</p><h1>好运牌桌 <span>第 ${String(game.round).padStart(2, "0")} 轮</span></h1></div><div class="table-tools"><button class="speed-button" data-action="speed" aria-label="切换电脑行动速度">${prefs.speed === "normal" ? "1× 常速" : "2× 快速"}</button><button class="icon-button" data-action="new" aria-label="重新开始">${icon("replay", 18)}</button></div></div>
    <div class="table-body"><div class="play-area"><div class="opponents count-${opponents.length}">${opponents.map((p, i) => playerMarkup(p, i + 1, stampedPlayers)).join("")}</div>
    <section class="deck-strip" aria-label="公共牌堆"><div class="deck-stack" aria-label="牌堆"><img src="/art/flip7-logo.png" alt="" width="197" height="120"></div><div class="deck-information"><strong>翻开未知的那一张</strong><span class="deck-counts"><span>牌堆 ${game.deck.length} 张</span><i>·</i><span>弃牌 ${game.discard.length} 张</span></span></div><div class="last-draw">${game.lastDraw ? `<span>刚刚翻出</span>${cardMarkup(game.lastDraw.card, true)}` : ""}</div></section>
    ${playerMarkup(me, 0, stampedPlayers)}${controlsMarkup()}
    <div class="table-bottom"><span>${icon("check", 14)} 进度自动保存在此浏览器</span><button class="link-button" data-action="home">返回首页</button></div>
    </div>${sidebarMarkup()}</div></main>`;
}

function render(stampedPlayers = new Set()) {
  // Retain keyboard focus across state updates, especially while targeting actions.
  const active = document.activeElement;
  const action = active?.dataset?.action;
  const target = active?.dataset?.target;
  const card = active?.dataset?.card;
  app.innerHTML =
    header() +
    (screen === "game" && game ? gameMarkup(stampedPlayers) : homeMarkup());
  if (action) {
    const next = [...app.querySelectorAll("[data-action]")].find(
      (el) =>
        el.dataset.action === action &&
        el.dataset.target === target &&
        el.dataset.card === card &&
        !el.disabled,
    );
    next?.focus({ preventScroll: true });
  }
  scheduleBot();
}

function scheduleBot() {
  clearTimeout(botTimer);
  if (
    !game ||
    screen !== "game" ||
    modal.open ||
    document.hidden ||
    game.phase !== "playing"
  )
    return;
  const actor = game.players.find((p) => p.id === currentActor(game));
  if (!actor?.bot) return;
  const revision = game.revision;
  botTimer = setTimeout(
    () => {
      if (!game || game.revision !== revision || modal.open || document.hidden)
        return;
      try {
        act(chooseBotAction(publicView(game), actor.id), actor.id);
      } catch (error) {
        toast(`电脑行动暂停：${error.message}`);
      }
    },
    prefs.speed === "fast" ? 400 : 1000,
  );
}

function act(action, actorId = "you") {
  try {
    const previousEvents = game.eventId;
    const previousRound = game.round;
    const previousStatuses = new Map(game.players.map((p) => [p.id, p.status]));
    game = applyAction(game, actorId, action);
    // A stamp lands only when a player finishes their round, not on every render.
    const stampedPlayers = new Set(
      game.players
        .filter(
          (p) =>
            p.status !== "active" &&
            (previousRound !== game.round ||
              previousStatuses.get(p.id) !== p.status),
        )
        .map((p) => p.id),
    );
    const events = game.events.filter((e) => e.id > previousEvents);
    sound(
      events.some((e) => e.type === "bust")
        ? "bust"
        : action.type === "stay"
          ? "bank"
          : "draw",
    );
    persist();
    render(stampedPlayers);
    document.querySelector("#announcer").textContent = events
      .map((e) => e.text)
      .join(" ");
  } catch (error) {
    toast(error.message);
  }
}

function newGame() {
  const players = [{ id: "you", name: prefs.name.trim() || "你", bot: false }];
  for (let i = 0; i < prefs.opponents; i++)
    players.push({
      id: `bot-${i}`,
      name: BOT_NAMES[i],
      bot: true,
      style: ["balanced", "bold", "careful"][i % 3],
    });
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  game = createGame({ players, seed });
  screen = "game";
  persist();
  render();
  document.querySelector("#announcer").textContent = "新对局开始，祝你好运。";
  window.scrollTo({ top: 0 });
}

function openModal(content, className = "") {
  clearTimeout(botTimer);
  if (!modal.open) lastFocus = document.activeElement;
  modal.className = className;
  modal.innerHTML = `<button class="icon-button modal-close" data-action="close" aria-label="关闭">${icon("close")}</button>${content}`;
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
  modal.querySelector(".modal-close").focus();
}
function closeModal() {
  modal.close();
}
modal.addEventListener("close", () => {
  lastFocus?.focus({ preventScroll: true });
  scheduleBot();
});
modal.addEventListener("click", (e) => {
  if (
    e.target === modal &&
    (e.clientX < modal.getBoundingClientRect().left ||
      e.clientX > modal.getBoundingClientRect().right ||
      e.clientY < modal.getBoundingClientRect().top ||
      e.clientY > modal.getBoundingClientRect().bottom)
  )
    closeModal();
});

function inspectCard(key) {
  if (!CARD_ART[key]) return;
  const [kind, rawValue] = key.split("-");
  const value = Number(rawValue);
  const card = { kind, ...(rawValue === undefined ? {} : { value }) };
  const explanation = {
    number:
      value === 0
        ? "0 分，但它算一张不同的数字牌，可以帮助你达成七连翻。整副牌只有 1 张。"
        : `这张牌值 ${value} 分，整副牌有 ${value} 张。翻到你已持有的数字会爆牌。`,
    add: `本轮额外获得 ${value} 分；这部分不会被 ×2 翻倍。`,
    multiply: "将数字牌分数之和翻倍，再加上加分牌与七连翻奖励。",
    freeze: "指定一位仍在本轮的玩家立即收手，保留已有分数。可以选择自己。",
    three: "指定一位仍在本轮的玩家连续接受三张牌；爆牌或七连翻立即停止。",
    second: "保留此牌，抵消一次重复数字。使用后，机会牌与重复牌一起弃掉。",
  };
  openModal(
    `<p class="eyebrow">THE ORIGINAL CARD · 原版牌面</p><h2 id="modal-title">${escape(cardLabel(card))}${kind === "number" ? " · 数字牌" : ""}</h2><div class="card-enlarged">${cardArtwork(key)}</div><p class="modal-intro">${explanation[kind]}</p><button class="primary wide" data-action="close">关闭牌面 ${icon("arrow")}</button>`,
    "card-dialog",
  );
}

function showCards() {
  const allCards = [
    ...Array.from({ length: 13 }, (_, value) => ({ kind: "number", value })),
    ...[2, 4, 6, 8, 10].map((value) => ({ kind: "add", value })),
    ...["multiply", "freeze", "three", "second"].map((kind) => ({ kind })),
  ];
  openModal(
    `<p class="eyebrow">MEET THE DECK</p><h2 id="modal-title">22 种牌面，94 张可能</h2><p class="modal-intro">点击任意卡牌，查看原版牌面与中文说明。</p><div class="card-gallery">${allCards.map((card) => `<div>${cardMarkup(card)}<span>${escape(cardLabel(card))}</span></div>`).join("")}</div><button class="secondary wide" data-action="close">返回</button>`,
    "gallery-dialog",
  );
}

function showRules() {
  openModal(
    `<p class="eyebrow">HOW TO PLAY</p><h2 id="modal-title">一分钟，学会七连翻</h2><p class="modal-intro">每轮轮流选择翻牌或收手，争取率先在轮末以最高分达到 200 分。</p>
    <div class="rule-steps"><div><b>01</b><h3>翻一张，试试手气</h3><p>数字牌计分；遇到已有的数字就爆牌，本轮 0 分。0 也算一张数字牌。</p></div><div><b>02</b><h3>见好就收</h3><p>轮到你时可以收手，锁定本轮分数。至少有一张牌才能收手。</p></div><div><b>03</b><h3>集齐七张，立即结算</h3><p>七张不同数字额外 +15 分，全员立即结束本轮；未爆牌玩家保留得分。</p></div></div>
    <h3 class="rule-section-title">让牌局变有趣的特殊牌</h3><div class="special-rules"><p><span class="modifier freeze">冻结</span>让任意仍在本轮的玩家立刻收手，也可以选自己。</p><p><span class="modifier three">连翻三张</span>指定玩家连续接受三张牌；爆牌或七连翻会提前停止。</p><p><span class="modifier second">第二次机会</span>抵消一次重复数字，同时弃掉该重复牌和机会牌；只能持有一张，多余的送给其他有效玩家。</p><p><span class="modifier add">+2～+10</span>额外加分。<span class="modifier multiply">×2</span>只翻倍数字之和，不翻倍加分牌和七连翻奖励。</p></div>
    <details><summary>更多规则细节</summary><p>每轮开局按座位顺序发一张，特殊牌立即处理；先手每轮轮换。数字 N 有 N 张，0 有一张；全套共 94 张。</p><p>连翻三张中抽到冻结或连翻三张，先放到一边；成功完成三张后依次指定目标。若爆牌，这些待处理牌弃掉。第二次机会立即获得，能保护本次连翻。</p><p>每轮后保留剩余牌堆，用尽再洗弃牌；本轮所有桌面牌（含爆牌者的牌）不参与洗牌。达到 200 分后轮末比较总分；最高分并列，全员继续加赛。</p></details>
    <p class="rules-source">依据 <a href="https://rules.dized.com/game/dPDRM857TU-BFRF7LzGE0g/flip-7" target="_blank" rel="noreferrer">发行方维护的 Dized 规则</a>。本游戏为非官方实现；卡面使用该规则页的原版插图，相关美术归原权利人所有。</p><button class="primary wide" data-action="close">明白了，回到牌桌 ${icon("arrow")}</button>`,
    "rules-dialog",
  );
}

function showHistory() {
  openModal(
    `<p class="eyebrow">EVERY ROUND COUNTS</p><h2 id="modal-title">每一轮的足迹</h2>${!game.history.length ? '<p class="modal-intro">第一轮还在进行，结算后会显示在这里。</p>' : `<div class="history-scroll"><table><thead><tr><th>轮次</th>${game.players.map((p) => `<th>${escape(p.name)}</th>`).join("")}</tr></thead><tbody>${game.history.map((r) => `<tr><th>${r.round}</th>${r.scores.map((s) => `<td class="${s.status === "busted" ? "zero" : ""}">+${s.points}${s.status === "flip7" ? "<small>七连翻</small>" : ""}</td>`).join("")}</tr>`).join("")}</tbody><tfoot><tr><th>总分</th>${game.players.map((p) => `<td>${p.score}</td>`).join("")}</tr></tfoot></table></div>`}<button class="secondary wide" data-action="close">返回牌桌</button>`,
  );
}

function confirmNewGame() {
  if (!game || game.phase === "finished") {
    newGame();
    return;
  }
  openModal(
    '<p class="eyebrow">A FRESH START</p><h2 id="modal-title">开始一局新的冒险？</h2><p class="modal-intro">当前对局的进度会被新对局替换。</p><div class="dialog-actions"><button class="secondary" data-action="close">继续当前对局</button><button class="primary" data-action="confirm-new">开始新对局</button></div>',
  );
}

document.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === "hit") act({ type: "hit" });
  else if (action === "stay") act({ type: "stay" });
  else if (action === "target")
    act({ type: "target", targetId: button.dataset.target });
  else if (action === "next") act({ type: "nextRound" });
  else if (action === "home") {
    screen = "home";
    render();
    window.scrollTo({ top: 0 });
  } else if (action === "continue") {
    screen = "game";
    render();
    window.scrollTo({ top: 0 });
  } else if (action === "rules") showRules();
  else if (action === "history") showHistory();
  else if (action === "inspect-card") inspectCard(button.dataset.card);
  else if (action === "cards") showCards();
  else if (action === "close") closeModal();
  else if (action === "new") confirmNewGame();
  else if (action === "confirm-new") {
    closeModal();
    newGame();
  } else if (action === "speed") {
    prefs.speed = prefs.speed === "normal" ? "fast" : "normal";
    persist();
    render();
  } else if (action === "sound") {
    prefs.sound = !prefs.sound;
    sound();
    persist();
    render();
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "setup-form") return;
  e.preventDefault();
  const data = new FormData(e.target);
  prefs.name = String(data.get("name")).trim().slice(0, 16) || "你";
  prefs.opponents = Number(data.get("opponents"));
  persist();
  confirmNewGame();
});

document.addEventListener("keydown", (e) => {
  if (
    e.repeat ||
    e.altKey ||
    e.ctrlKey ||
    e.metaKey ||
    modal.open ||
    screen !== "game" ||
    !game ||
    currentActor(game) !== "you" ||
    pendingEffect(game) ||
    /INPUT|SELECT|TEXTAREA|BUTTON|A/.test(e.target.tagName)
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    act({ type: "hit" });
  } else if (
    e.key.toLowerCase() === "s" &&
    canStay(game.players.find((p) => p.id === "you"))
  ) {
    e.preventDefault();
    act({ type: "stay" });
  }
});
document.addEventListener("visibilitychange", scheduleBot);
render();
