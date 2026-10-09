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
  isOpeningTurn,
  cardLabel,
  TARGET_SCORE,
} from "/src/game.js";
import { chooseBotAction } from "/src/bot.js";
import { RoomClient, requestId } from "/network.js";
import { updateApplause, applauseView } from "/src/applause.js";
import { Danmaku } from "/danmaku.js";
import {
  standings,
  showGameEffects,
  hideGameEffects,
  resumeScoreHonors,
  syncApplauseCelebration,
} from "/presentation.js";
import { CARD_ART, cardArtKey, cardArtwork } from "/card-art.js";

const SAVE_KEY = "labgames.flip7.save.v1";
const PREF_KEY = "labgames.flip7.preferences.v1";
const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
let game = null;
let showFinalTable = false;
let trackerOpen = false;
let screen = "home";
let botTimer;
let toastTimer;
let prefs = { opponents: 2, speed: "normal", sound: false, name: "你" };
let audioContext;
let storageWarning = false;
let lastFocus;
let mode = "solo";
let soloGame;
let roomSnapshot = null;
let roomConnected = false;
let roomBusy = false;
let networkAddresses = [];
let turnDeadline = null;
let alertTimer;
let alertRoom = null;
const seenNotices = new Set();
const turnSeconds = () =>
  turnDeadline === null
    ? null
    : Math.max(0, Math.ceil((turnDeadline - performance.now()) / 1000));
const recentStamps = new Map();
const invitedRoom = new URLSearchParams(location.search)
  .get("room")
  ?.toUpperCase();
const validInvite = /^[A-Z2-9]{6}$/.test(invitedRoom || "") ? invitedRoom : "";
const myId = () => (mode === "lan" ? roomSnapshot?.selfId : "you");
const gameActor = () => (mode === "lan" ? game?.actorId : currentActor(game));
const gameEffect = () => (mode === "lan" ? game?.pending : pendingEffect(game));
const gameOpening = () =>
  mode === "lan" ? game?.opening : isOpeningTurn(game);
const roomSelf = () => roomSnapshot?.members.find((m) => m.id === myId());
const roomHost = () => roomSnapshot?.hostId === myId();
const networkBlocked = () =>
  mode === "lan" &&
  (!roomConnected || roomBusy || roomSelf()?.automated || turnSeconds() === 0);
const gameApplause = () =>
  mode === "lan"
    ? roomSnapshot?.applause
    : applauseView(game?.applause, game?.players || []);
const awaitingApplause = () => gameApplause()?.complete === false;
const danmaku = new Danmaku({
  send: (text) => client.sendDanmaku(text),
  onError: toast,
});
const client = new RoomClient({
  onDanmaku: (message) => danmaku.receive(message),
  onSnapshot: receiveRoom,
  onConnection(connected) {
    roomConnected = connected;
    if (mode === "lan") render();
  },
  onSessionLost(message) {
    returnToSolo();
    toast(message);
  },
  onStorageError() {
    toast("浏览器无法保存房间身份，请保持当前页面开启。");
  },
});

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
    game.applause = updateApplause(
      game,
      game.players,
      game.applause,
      requestId,
    );
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
    if (game && mode === "solo")
      localStorage.setItem(SAVE_KEY, JSON.stringify(game));
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
    <button class="secondary wide lan-entry" data-action="lan">局域网联机 <span>与朋友一起翻牌 ↗</span></button>
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
  const actor = gameActor();
  const me = p.id === myId();
  const cards = p.cards.filter((c) => c.kind === "number");
  const modifiers = p.cards.filter((c) => c.kind !== "number");
  const freshId =
    game.lastDraw?.playerId === p.id ? game.lastDraw.card.id : null;
  const slots = Array.from({ length: Math.max(0, 7 - cards.length) }, () =>
    cardMarkup(null),
  ).join("");
  return `<section class="player ${me ? "self" : "opponent"} ${actor === p.id ? "is-turn" : ""} is-${p.status}" aria-label="${escape(p.name)}的牌区">
    <div class="player-heading"><div class="identity"><span class="avatar avatar-${index}">${escape(me ? p.name.slice(0, 1) || "你" : p.name.slice(-1))}</span><div><h2>${escape(p.name)} ${me ? '<span class="you-badge">YOU</span>' : ""}</h2><span class="player-subtitle">${playerSubtitle(p, me)}</span></div></div>
    <div class="player-state">${actor === p.id ? `<span class="turn-badge"><span class="live-dot"></span>正在行动${mode === "lan" ? `<b class="seat-clock"><span data-turn-seconds>${turnSeconds()}</span>s</b>` : ""}</span>` : `<span class="status-label">${statusNames[p.status]}</span>`}<div class="round-points"><b>${roundPoints(p)}</b><span>本轮分</span></div></div></div>
    <div class="hand-stage ${p.status !== "active" ? "is-settled" : ""}"><div class="hand-cards">${modifiers.length ? `<div class="special-hand" aria-label="${escape(p.name)}的特殊牌">${modifiers.map((c) => cardMarkup(c, true, c.id === freshId)).join("")}</div>` : ""}
    <div class="hand ${me ? "large-hand" : ""}">${cards.map((c) => cardMarkup(c, !me, c.id === freshId)).join("")}${slots}</div>
    </div>${statusStamp(p, stampedPlayers.has(p.id))}</div>
    <div class="hand-footer"><span class="card-count">${p.status === "busted" ? "这次冒险，下轮再来" : `${cards.length} / 7 张不同数字`}</span><div class="modifiers">${modifiers.map((c) => `<span class="modifier ${c.kind}" title="${escape(cardLabel(c))}">${c.kind === "second" ? icon("shield", 14) : c.kind === "freeze" ? icon("snow", 14) : ""}${escape(cardLabel(c))}</span>`).join("")}${!modifiers.length && me && p.status === "active" ? '<span class="muted">集齐 7 张，额外 +15 分</span>' : ""}</div></div>
  </section>`;
}

function controlsMarkup() {
  const actorId = gameActor();
  const effect = gameEffect();
  const me = game.players.find((p) => p.id === myId());
  if (game.phase !== "playing") return resultMarkup();
  if (effect) {
    const owner = game.players.find((p) => p.id === effect.owner);
    return `<section class="action-panel targeting"><div><span class="eyebrow">${effect.owner === myId() ? "由你决定" : "特殊牌"}</span><h3>${escape(owner.name)}翻出了${escape(cardLabel(effect.card))}</h3><p>${effect.card.kind === "freeze" ? "选择一位玩家，让 TA 立即收手并保留分数。" : effect.card.kind === "three" ? "选择一位玩家，让 TA 连续接受三张牌。" : "你已有第二次机会，将这张送给另一位玩家。"}</p></div><div class="target-buttons">${effect.owner === myId() ? effect.targets.map((id) => `<button class="target-button" ${networkBlocked() ? "disabled" : ""} data-action="target" data-target="${escape(id)}">${escape(game.players.find((p) => p.id === id).name)}${id === myId() ? "（自己）" : ""}${icon("arrow", 16)}</button>`).join("") : '<span class="thinking">等待对方选择<span>···</span></span>'}</div></section>`;
  }
  const myTurn = actorId === myId();
  const actor = game.players.find((p) => p.id === actorId);
  if (gameOpening())
    return `<section class="action-panel opening-panel"><div class="action-prompt"><span class="eyebrow">FIRST FLIP · 开场翻牌</span><h3>${myTurn ? "第一张好运，由你翻开。" : `等待${escape(actor.name)}翻开第一张`}</h3><p>按座位轮流翻牌，所有人开场翻牌后再选择翻或停。</p></div><button class="primary hit-button" data-action="hit" ${!myTurn || networkBlocked() ? "disabled" : ""}>${icon("cards")} ${myTurn ? "翻开第一张" : "等待对方翻牌"}<kbd>空格</kbd></button></section>`;
  return `<section class="action-panel"><div class="action-prompt"><span class="eyebrow">${myTurn ? "YOUR MOVE" : "TAKE A BREATH"}</span><h3>${myTurn ? "好运，还要继续吗？" : me.status === "active" ? `${escape(actor.name)}正在思考…` : "你的本轮已结束"}</h3><p>${myTurn ? (hasSecond(me) ? "第二次机会在手，可抵消一次重复数字。" : "重复即爆牌，收手就能保住本轮分数。") : me.status === "active" ? "下一次翻牌，也许就能改变牌局。" : `等待其他玩家完成本轮 · ${escape(actor.name)}行动中`}</p></div>
    <div class="action-buttons"><button class="secondary bank-button" data-action="stay" ${!myTurn || networkBlocked() || !canStay(me) ? "disabled" : ""}>${icon("check")} 收手 <b>+${roundPoints(me)}</b><kbd>S</kbd></button><button class="primary hit-button" data-action="hit" ${!myTurn || networkBlocked() ? "disabled" : ""}>${icon("cards")} 再翻一张 <kbd>空格</kbd></button></div></section>`;
}

function resultMarkup() {
  if (game.phase === "finished")
    return `<section class="round-result"><div class="result-symbol">${icon("trophy", 30)}</div><div class="result-heading"><h3>本局已结束</h3><p>这一桌的好运，已经有了答案。</p></div><button class="primary" data-action="final-ranking">查看最终排行榜 ${icon("arrow")}</button></section>`;
  const done = game.phase === "finished";
  const winner = game.players.find((p) => p.id === game.winner);
  const round = game.history.at(-1);
  const flip = game.players.find((p) => p.id === round?.flipId);
  return `<section class="round-result ${done ? "game-result" : ""}" aria-live="polite"><div class="result-symbol">${icon(done ? "trophy" : "check", 30)}</div><div class="result-heading"><span class="eyebrow">${done ? "WELL PLAYED" : `ROUND ${String(game.round).padStart(2, "0")} COMPLETE`}</span><h3>${done ? `${escape(winner.name)}获胜！` : flip ? `${escape(flip.name)}达成七连翻！` : "这一轮，稳稳落袋。"}</h3><p>${done ? `${winner.score} 分 · ${game.round} 轮较量，感谢每一次勇敢的翻牌。` : Math.max(...game.players.map((p) => p.score)) >= 200 ? "最高分并列！所有玩家再比一轮。" : "分数已记好，准备迎接下一轮好运。"}</p></div><button class="primary" data-action="${done ? (mode === "lan" ? "room-rematch" : "new") : "next"}" ${networkBlocked() || (done && mode === "lan" && !roomHost()) ? "disabled" : ""}>${done ? (mode === "lan" && !roomHost() ? "等待房主再开一局" : "再来一局") : "下一轮"} ${icon("arrow")}</button><div class="round-deltas">${game.players.map((p) => `<span>${escape(p.name)} <b class="${p.status === "busted" ? "zero" : ""}">+${p.roundScore}</b></span>`).join("")}</div></section>`;
}

function flipHonorMarkup(player) {
  if (!player.flipCount) return "";
  return `<span class="flip-honor" data-flip-honor="${escape(player.id)}" role="img" aria-label="${escape(player.name)}：本局达成七连翻 ${player.flipCount} 次" title="本局达成七连翻 ${player.flipCount} 次"><span class="flip-honor-medal" aria-hidden="true">7</span><span class="flip-honor-ribbon" aria-hidden="true">七连翻 <b>×${player.flipCount}</b></span><span class="flip-honor-spark" aria-hidden="true">✦</span><span class="flip-honor-spark" aria-hidden="true">✧</span></span>`;
}

function finalMarkup() {
  const ranked = standings(game);
  const winner = ranked.find((p) => p.id === game.winner);
  const podium = [ranked[1], ranked[0], ranked[2]];
  return `<main class="final-screen">
    ${mode === "lan" ? connectionMarkup() : ""}
    <section class="champion-heading" aria-labelledby="champion-title"><span class="champion-crown" aria-hidden="true">${icon("trophy", 44)}</span><p class="eyebrow">THE LUCKIEST OF THEM ALL</p><h1 id="champion-title">${escape(winner.name)}<span>这一桌你赢了！</span></h1><p>历经 ${game.round} 轮，以 <b>${winner.score}</b> 分摘得桂冠。每一次翻牌，都值得喝彩。</p></section>
    <section class="podium" aria-label="本局前三名">${podium.map((p, i) => `<div class="podium-place podium-${i === 1 ? "champion" : i === 0 ? "second" : "third"}"><span class="podium-badge">${p.rank === 1 ? icon("trophy", 24) : `${p.tied ? "并列 " : ""}${p.rank}`}</span><h2>${escape(p.name)}${p.id === myId() ? "<small>YOU</small>" : ""}</h2><div class="podium-step"><strong>${p.score}</strong><span>总分</span><b>${p.rank === 1 ? "CHAMPION" : p.rank === 2 ? "SECOND PLACE" : "THIRD PLACE"}</b></div></div>`).join("")}</section>
    <section class="final-ranking" aria-labelledby="final-ranking-title"><div class="section-title"><h2 id="final-ranking-title">本局最终排行榜</h2><span>${game.players.length} 位玩家 · ${game.round} 轮</span></div><table><thead><tr><th>名次</th><th>玩家</th><th>总分</th><th>单轮最高</th><th>七连翻</th></tr></thead><tbody>${ranked.map((p) => `<tr class="${p.id === game.winner ? "champion-row" : ""}"><td>${p.tied ? "并列 " : ""}${String(p.rank).padStart(2, "0")}</td><th scope="row">${escape(p.name)}${p.id === myId() ? "<small>你</small>" : ""}${flipHonorMarkup(p)}</th><td><strong>${p.score}</strong></td><td>${p.bestRound}</td><td>${p.flipCount} 次</td></tr>`).join("")}</tbody></table></section>
    <div class="final-actions"><button class="primary" data-action="${mode === "lan" ? "room-rematch" : "new"}" ${networkBlocked() || (mode === "lan" && !roomHost()) ? "disabled" : ""}>${mode === "lan" && !roomHost() ? "等待房主再开一局" : "再来一局"} ${icon("arrow")}</button><button class="secondary" data-action="history">查看每轮得分</button><button class="link-button" data-action="final-table">查看最后牌桌</button><button class="link-button" data-action="home">${mode === "lan" ? "房间大厅" : "返回首页"}</button></div>
    <p class="final-signoff">GOOD COMPANY. GREAT LUCK. · 下次好运，再一起翻。</p>
  </main>`;
}

function presentChange(previous) {
  showGameEffects(previous, game, gameApplause());
  if (
    game?.phase === "finished" &&
    previous?.phase !== "finished" &&
    screen === "game"
  ) {
    if (modal.open) closeModal();
    window.scrollTo({ top: 0 });
  }
}

function sidebarMarkup() {
  const ranked = standings(game);
  return `<aside class="sidebar"><section class="scoreboard"><div class="section-title"><h2>${icon("trophy", 18)} 积分榜</h2><span>目标 ${TARGET_SCORE}</span></div><div class="score-list">${ranked.map((p) => `<div class="score-row ${p.id === myId() ? "your-score" : ""} ${p.flipCount ? "has-flip-honor" : ""}"><span class="rank">${String(p.rank).padStart(2, "0")}</span><span class="score-name">${escape(p.name)}${p.id === myId() ? "<small>你</small>" : ""}</span><b>${p.score}</b>${flipHonorMarkup(p)}<div class="score-track"><progress max="200" value="${Math.min(p.score, 200)}" aria-label="${escape(p.name)}总分 ${p.score}"></progress></div></div>`).join("")}</div><button class="link-button" data-action="history">查看每轮得分 ${icon("arrow", 15)}</button></section>
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
  if (game.phase === "finished" && !showFinalTable) return finalMarkup();
  const me = game.players.find((p) => p.id === myId());
  const opponents = game.players.filter((p) => p.id !== myId());
  return `<main class="game-layout"><div class="table-top"><div><p class="eyebrow">FLIP 7</p><h1>七连翻 <span>第 ${String(game.round).padStart(2, "0")} 轮</span></h1></div><div class="table-tools">${trackerButtonMarkup()}${mode === "lan" ? '<button class="secondary" data-action="room-lobby">房间大厅</button>' : `<button class="speed-button" data-action="speed" aria-label="切换电脑行动速度">${prefs.speed === "normal" ? "1× 常速" : "2× 快速"}</button><button class="icon-button" data-action="new" aria-label="重新开始">${icon("replay", 18)}</button>`}</div></div>${mode === "lan" ? connectionMarkup(false) : ""}${trackerMarkup()}
    <div class="table-body"><div class="play-area"><div class="opponents count-${opponents.length}">${opponents.map((p, i) => playerMarkup(p, i + 1, stampedPlayers)).join("")}</div>
    <section class="deck-strip" aria-label="公共牌堆"><div class="deck-supply"><div class="deck-stack" aria-label="牌堆"><img src="/art/flip7-logo.png" alt="" width="197" height="120"></div><div class="deck-information"><strong>翻开未知的那一张</strong><span class="deck-counts"><span>牌堆 ${mode === "lan" ? game.deckCount : game.deck.length} 张</span><i>·</i><span>弃牌 ${mode === "lan" ? game.discardCount : game.discard.length} 张</span></span></div></div><div class="deck-middle">${mode === "lan" ? turnClockMarkup(true) : ""}</div><div class="last-draw">${game.lastDraw ? `<span>刚刚翻出</span>${cardMarkup(game.lastDraw.card, true)}` : ""}</div></section>
    ${playerMarkup(me, 0, stampedPlayers)}${controlsMarkup()}
    <div class="table-bottom"><span>${icon("check", 14)} ${mode === "lan" ? "牌局由房间服务器自动保存" : "进度自动保存在此浏览器"}</span><button class="link-button" data-action="home">${mode === "lan" ? "房间大厅" : "返回首页"}</button></div>
    </div>${sidebarMarkup()}</div></main>`;
}

function trackerButtonMarkup() {
  if (mode !== "lan" || !roomSnapshot?.settings?.cardTracker) return "";
  return `<button class="secondary tracker-toggle" data-action="toggle-tracker" aria-expanded="${trackerOpen}" aria-controls="card-tracker-panel">${icon("cards", 17)} ${trackerOpen ? "收起记牌器" : "记牌器"}</button>`;
}

function trackerMarkup() {
  const tracker = roomSnapshot?.cardTracker;
  if (mode !== "lan" || !roomSnapshot?.settings?.cardTracker || !tracker)
    return "";
  const held = new Set(numbers(game.players.find((p) => p.id === myId())));
  const cell = (card) => {
    const inHand = card.kind === "number" && held.has(card.value);
    const name = card.kind === "number" ? `数字 ${card.value}` : card.label;
    return `<li class="tracker-card ${!card.remaining ? "is-empty" : ""} ${inHand ? "is-held" : ""}" aria-label="${escape(name)}：剩余 ${card.remaining} 张，全套 ${card.total} 张${inHand ? "，你已持有" : ""}"><span class="tracker-art" aria-hidden="true">${cardArtwork(cardArtKey(card))}</span><span class="tracker-label">${escape(name)}</span><span class="tracker-amount"><b>${card.remaining}</b><span> / ${card.total} 张</span></span>${inHand ? '<span class="tracker-held">手牌</span>' : ""}</li>`;
  };
  return `<section id="card-tracker-panel" class="card-tracker" aria-labelledby="tracker-title" ${trackerOpen ? "" : "hidden"}><div class="tracker-heading"><div><p class="eyebrow">KNOW YOUR CARDS</p><h2 id="tracker-title">牌堆记牌器</h2></div><div class="tracker-totals"><span>牌堆剩余 <b>${tracker.remaining}</b></span><span>牌堆外 <b>${tracker.outside}</b></span></div></div><p class="tracker-help">剩余张数 / 全套张数 · 黄色标记表示你的数字牌。${roomConnected ? "全桌同步，洗牌时自动更新。" : "重连中，当前显示上次同步的记录。"}</p>${tracker.remaining ? "" : '<p class="tracker-empty-note">牌堆已空，下一次翻牌将洗入弃牌；届时剩余张数会更新。</p>'}<h3>数字牌</h3><ul class="tracker-grid tracker-numbers">${tracker.cards
    .filter((c) => c.kind === "number")
    .map(cell)
    .join(
      "",
    )}</ul><h3>加分牌与特殊牌</h3><ul class="tracker-grid tracker-specials">${tracker.cards
    .filter((c) => c.kind !== "number")
    .map(cell)
    .join(
      "",
    )}</ul><p class="tracker-footnote">牌堆外包括桌面牌、弃牌和待处理的特殊牌；不显示牌堆顺序。</p></section>`;
}

function render(stampedPlayers = new Set()) {
  // A command response or presence update must not cancel the landing animation.
  const now = performance.now();
  for (const id of stampedPlayers) recentStamps.set(id, now + 600);
  for (const [id, until] of recentStamps) {
    if (until > now) stampedPlayers.add(id);
    else recentStamps.delete(id);
  }
  // Retain keyboard focus across state updates, especially while targeting actions.
  const active = document.activeElement;
  const action = active?.dataset?.action;
  const target = active?.dataset?.target;
  const card = active?.dataset?.card;
  app.innerHTML =
    header() +
    (mode === "lan" && (screen !== "game" || !game)
      ? lobbyMarkup()
      : screen === "game" && game
        ? gameMarkup(stampedPlayers)
        : homeMarkup());
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
  updateTurnClock();
  resumeScoreHonors();
  danmaku.setContext({
    code: mode === "lan" ? roomSnapshot?.code : null,
    selfId: myId(),
    connected: mode === "lan" && roomConnected,
  });
  if (awaitingApplause()) {
    for (const button of app.querySelectorAll(
      '[data-action="next"], [data-action="room-rematch"], [data-action="new"]',
    )) {
      button.disabled = true;
      button.title = "等待全员鼓掌后继续";
      if (button.dataset.action !== "new") button.textContent = "等待全员鼓掌";
    }
  }
  syncApplauseCelebration(game, gameApplause(), {
    selfId: myId(),
    connected: mode !== "lan" || roomConnected,
    busy: mode === "lan" && roomBusy,
    members: mode === "lan" ? roomSnapshot?.members : game?.players,
  });
}

function scheduleBot() {
  clearTimeout(botTimer);
  if (
    mode === "lan" ||
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
  if (mode === "lan") {
    if (!networkBlocked()) void roomCommand({ type: "game", action });
    return;
  }
  try {
    if (action.type === "nextRound" && awaitingApplause())
      throw new Error("请先点击「为ta鼓掌」");
    const previous = game;
    const previousEvents = game.eventId;
    const previousRound = game.round;
    const previousStatuses = new Map(game.players.map((p) => [p.id, p.status]));
    game = applyAction(game, actorId, action);
    game.applause = updateApplause(
      game,
      game.players,
      game.applause,
      requestId,
    );
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
    presentChange(previous);
    document.querySelector("#announcer").textContent = events
      .map((e) => e.text)
      .join(" ");
  } catch (error) {
    toast(error.message);
  }
}

function newGame() {
  if (awaitingApplause()) return toast("请先点击「为ta鼓掌」");
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
  showFinalTable = false;
  hideGameEffects();
  screen = "game";
  persist();
  render();
  presentChange(null);
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
    <details><summary>更多规则细节</summary><p>每轮开局按座位顺序，由每位玩家亲手翻开第一张；特殊牌立即处理；先手每轮轮换。数字 N 有 N 张，0 有一张；全套共 94 张。</p><p>连翻三张中抽到冻结或连翻三张，先放到一边；成功完成三张后依次指定目标。若爆牌，这些待处理牌弃掉。第二次机会立即获得，能保护本次连翻。</p><p>每轮后保留剩余牌堆，用尽再洗弃牌；本轮所有桌面牌（含爆牌者的牌）不参与洗牌。达到 200 分后轮末比较总分；最高分并列，全员继续加赛。</p></details>
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

function applaud() {
  const applause = gameApplause();
  if (
    !applause ||
    applause.complete ||
    applause.acknowledgedIds.includes(myId())
  )
    return;
  if (mode === "lan") {
    void roomCommand({ type: "applaud", applauseId: applause.id });
  } else {
    game.applause.acknowledgedIds.push(myId());
    persist();
    render();
  }
}

document.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === "applaud") applaud();
  else if (action === "hit") act({ type: "hit" });
  else if (action === "stay") act({ type: "stay" });
  else if (action === "target")
    act({ type: "target", targetId: button.dataset.target });
  else if (action === "next") act({ type: "nextRound" });
  else if (action === "toggle-tracker") {
    trackerOpen = !trackerOpen;
    render();
  } else if (action === "final-table" || action === "final-ranking") {
    showFinalTable = action === "final-table";
    render();
    window.scrollTo({ top: 0 });
  } else if (action === "home") {
    screen = mode === "lan" ? "lobby" : "home";
    render();
    window.scrollTo({ top: 0 });
  } else if (action === "continue") {
    screen = "game";
    render();
    window.scrollTo({ top: 0 });
  } else if (handleRoomClick(action, button)) return;
  else if (action === "rules") showRules();
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
  if (e.target.id === "room-form") {
    e.preventDefault();
    void enterRoom(e.target, e.submitter?.value === "join");
    return;
  }
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
    networkBlocked() ||
    gameActor() !== myId() ||
    gameEffect() ||
    /INPUT|SELECT|TEXTAREA|BUTTON|A/.test(e.target.tagName)
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    act({ type: "hit" });
  } else if (
    e.key.toLowerCase() === "s" &&
    !gameOpening() &&
    canStay(game.players.find((p) => p.id === myId()))
  ) {
    e.preventDefault();
    act({ type: "stay" });
  }
});
document.addEventListener("visibilitychange", scheduleBot);

function playerSubtitle(player, me) {
  if (mode !== "lan") return me ? "你的手牌" : `电脑 · ${styles[player.style]}`;
  const member = roomSnapshot.members.find((m) => m.id === player.id);
  return member.bot
    ? `电脑 · ${styles[player.style]}`
    : `${me ? "你的手牌" : "真人"} · ${member.automated ? "电脑托管" : member.online ? "在线" : "暂时离线"}`;
}

function receiveRoom(snapshot) {
  if (snapshot.code !== roomSnapshot?.code || !snapshot.settings?.cardTracker)
    trackerOpen = false;
  const previous = mode === "lan" ? game : null;
  if (mode !== "lan") soloGame = game;
  mode = "lan";
  roomSnapshot = snapshot;
  // Anchor server time to a monotonic local clock; device clock skew cannot extend a turn.
  turnDeadline = snapshot.turnClock
    ? performance.now() +
      Math.max(0, snapshot.turnClock.deadlineAt - snapshot.serverNow)
    : null;
  game = snapshot.game;
  if (!game || !previous) showFinalTable = false;
  if (!game) screen = "lobby";
  else if (!previous) screen = "game";
  const stamps = new Set(
    game?.players
      .filter(
        (p) =>
          previous &&
          p.status !== "active" &&
          (previous.round !== game.round ||
            previous.players.find((old) => old.id === p.id)?.status !==
              p.status),
      )
      .map((p) => p.id),
  );
  if (previous && game && game.revision > previous.revision) {
    const events = game.events.filter((e) => e.id > previous.eventId);
    if (events.length) {
      sound(
        events.some((e) => e.type === "bust")
          ? "bust"
          : events.some((e) => e.type === "bank")
            ? "bank"
            : "draw",
      );
      document.querySelector("#announcer").textContent = events
        .map((e) => e.text)
        .join(" ");
    }
  }
  render(stamps);
  presentChange(previous);
  showTableNotice(snapshot);
}

function returnToSolo() {
  if (mode === "lan") game = soloGame || null;
  mode = "solo";
  roomSnapshot = null;
  trackerOpen = false;
  roomConnected = false;
  turnDeadline = null;
  hideTableNotice();
  hideGameEffects();
  seenNotices.clear();
  screen = "home";
  if (modal.open) closeModal();
  render();
}

function connectionMarkup(showClock = true) {
  return `<div class="connection-bar ${roomConnected ? "connected" : "disconnected"}" role="status"><span><i class="live-dot"></i>${roomConnected ? "实时同步" : "连接中 · 正在自动重连"}${roomSnapshot ? ` <b>房间 ${roomSnapshot.code}</b>` : ""}</span><div>${!roomConnected ? '<button class="link-button" data-action="room-reconnect">重新连接</button>' : ""}${roomSelf()?.automated ? '<button class="secondary" data-action="room-reclaim">接管我的席位</button>' : ""}</div></div>${showClock ? turnClockMarkup() : ""}`;
}

function turnClockMarkup(compact = false) {
  if (!roomSnapshot?.turnClock || !game) return "";
  const actor = game.players.find(
    (p) => p.id === roomSnapshot.turnClock.actorId,
  );
  const member = roomSnapshot.members.find((m) => m.id === actor.id);
  const automatic = member.bot || member.automated;
  return `<section class="turn-clock${compact ? " deck-turn-clock" : ""}" aria-label="行动倒计时"><div class="clock-copy"><strong><span class="clock-actor" title="${escape(actor.name)}">${escape(actor.name)}${actor.id === myId() ? "（你）" : ""}</span><span class="clock-action">${compact ? "" : " · "}${game.pending ? "选择目标" : game.opening ? "翻开第一张" : "翻牌或收手"}</span></strong><p>${automatic ? "电脑正在行动" : game.pending ? "10 秒内选择，超时由电脑代选" : game.opening ? "10 秒内翻开第一张，超时自动翻牌" : "每次最多 10 秒，超时自动收手"}</p></div><div class="clock-number" aria-live="off"><b data-turn-seconds>${turnSeconds()}</b><span>秒</span></div><progress data-turn-progress max="10" value="${turnSeconds()}" aria-label="本次行动剩余时间"></progress></section>`;
}

function updateTurnClock() {
  if (mode !== "lan" || turnDeadline === null) return;
  const remaining = turnSeconds();
  for (const label of app.querySelectorAll("[data-turn-seconds]")) {
    if (label.textContent !== String(remaining))
      label.textContent = String(remaining);
  }
  for (const progress of app.querySelectorAll("[data-turn-progress]"))
    progress.value = Math.max(0, (turnDeadline - performance.now()) / 1000);
  app.querySelector(".turn-clock")?.classList.toggle("urgent", remaining <= 3);
  if (remaining === 0)
    for (const button of app.querySelectorAll(
      '[data-action="hit"], [data-action="stay"], [data-action="target"]',
    ))
      button.disabled = true;
}

function hideTableNotice() {
  clearTimeout(alertTimer);
  const alert = document.querySelector("#table-alert");
  if (typeof alert.hidePopover === "function" && alert.matches(":popover-open"))
    alert.hidePopover();
  alert.hidden = true;
}

function showTableNotice(snapshot) {
  if (alertRoom !== snapshot.code || !snapshot.game) {
    hideTableNotice();
    seenNotices.clear();
    alertRoom = snapshot.code;
  }
  const notices = snapshot.notices || [];
  const fresh = notices.filter((n) => !seenNotices.has(n.id));
  if (!fresh.length) return;
  const alert = document.querySelector("#table-alert");
  hideTableNotice();
  for (const notice of notices) seenNotices.add(notice.id);
  if (seenNotices.size > 100) {
    seenNotices.clear();
    for (const notice of notices) seenNotices.add(notice.id);
  }
  alert.innerHTML = `<span class="alert-card" aria-hidden="true">${cardArtwork("three")}</span><div><span class="eyebrow">FLIP THREE · 全桌提醒</span><strong>连翻三张！</strong>${notices.map((n) => `<p>${escape(n.text)}</p>`).join("")}</div>`;
  alert.hidden = false;
  if (typeof alert.showPopover === "function") alert.showPopover();
  alertTimer = setTimeout(
    hideTableNotice,
    Math.max(0, 6000 - (snapshot.serverNow - fresh.at(-1).createdAt)),
  );
}

function roomTrackerSettingMarkup(disabled) {
  const enabled = !!roomSnapshot.settings?.cardTracker;
  const hint = !game
    ? "房主可在开局前调整；修改后其他真人需重新准备。"
    : game.phase === "finished"
      ? "点击「再来一局」回到准备大厅，即可调整下一局设置。"
      : "本局内保持不变，整局结束后可回到准备大厅调整。";
  return `<section class="room-setting-summary" aria-label="记牌器设置"><span>记牌器</span><strong>${enabled ? "已开启 · 全员可见" : "已关闭"}</strong><p>${hint}</p>${!game && roomHost() ? `<button class="secondary" data-action="room-toggle-tracker" ${disabled}>${enabled ? "关闭记牌器" : "开启记牌器"}</button>` : ""}</section>`;
}

function lobbyMarkup() {
  if (!roomSnapshot)
    return `<main class="room-layout">${connectionMarkup()}<section class="room-panel"><p class="eyebrow">WELCOME BACK</p><h1>正在恢复你的房间…</h1><p class="muted">连接成功后会自动回到原来的席位。</p><button class="secondary" data-action="room-forget">返回单人模式</button></section></main>`;
  const { members, code, hostId } = roomSnapshot;
  const self = roomSelf();
  const host = members.find((m) => m.id === hostId);
  const canStart =
    members.length >= 3 && members.every((m) => m.bot || (m.ready && m.online));
  const disabled = !roomConnected || roomBusy ? "disabled" : "";
  return `<main class="room-layout"><div class="room-heading"><div><p class="eyebrow">GOOD COMPANY, GREAT LUCK</p><h1>${game ? "牌局进行中" : "朋友到齐，好运开桌"}</h1><p class="muted">3～6 人同桌 · 可以添加电脑补足席位</p></div><span class="room-crest">FLIP<br><b>7</b></span></div>
    ${connectionMarkup()}${roomTrackerSettingMarkup(disabled)}<div class="room-columns"><section class="room-panel"><div class="section-title"><h2>牌桌席位</h2><span>${members.length} / 6</span></div><ul class="room-seats">${members.map((m, i) => `<li><span class="avatar avatar-${i}">${escape(m.name.slice(0, 1))}</span><div class="seat-identity"><h3>${escape(m.name)} ${m.id === self.id ? '<span class="you-badge">YOU</span>' : ""}${m.id === hostId ? '<span class="host-badge">房主</span>' : ""}</h3><p>${m.bot ? "电脑对手" : m.automated ? "电脑托管 · 随时可接管" : m.online ? "真人玩家 · 在线" : "暂时离线 · 等待重连"}</p></div><div class="seat-actions"><span class="ready-tag ${m.ready || game ? "is-ready" : ""}">${game ? (m.bot || m.automated ? "电脑行动" : m.online ? "已入座" : "离线") : m.ready ? "已准备" : "未准备"}</span>${roomHost() && m.id !== self.id && !game && (m.bot || !m.online) ? `<button class="link-button" data-action="room-remove" data-target="${m.id}" ${disabled}>移除</button>` : ""}${roomHost() && game && !m.bot && !m.online && !m.automated ? `<button class="link-button" data-action="room-takeover" data-target="${m.id}" ${disabled}>电脑托管</button>` : ""}</div></li>`).join("")}</ul>
    <div class="lobby-actions">${game ? '<button class="primary wide" data-action="continue">回到牌桌 →</button>' : `${roomHost() ? `<button class="secondary" data-action="room-add-bot" ${disabled || (members.length >= 6 ? "disabled" : "")}>＋ 添加电脑</button><button class="primary" data-action="room-start" ${disabled || (!canStart ? "disabled" : "")}>开始对局 ${icon("arrow")}</button>` : `<button class="${self.ready ? "secondary" : "primary"} wide" data-action="room-ready" ${disabled}>${self.ready ? "取消准备" : "我准备好了"}</button>`}`}</div>
    <p class="lobby-hint">${game ? "每次行动最多 10 秒，离线也会超时代操作；房主可安排电脑持续托管。" : members.length < 3 ? "至少需要 3 个席位，邀请朋友或添加电脑即可开局。" : !canStart ? "等待每一位真人在线并准备，随后由房主开局。" : "全员准备就绪，可以开局！"}</p>
    ${!host.online && !roomHost() ? `<button class="secondary wide" data-action="room-claim-host" ${disabled}>接任房主（原房主需离线满 30 秒）</button>` : ""}${game?.phase === "finished" && roomHost() ? `<button class="secondary wide" data-action="room-rematch" ${disabled}>回到准备大厅，再来一局</button>` : ""}</section>
    <aside class="room-panel invitation"><p class="eyebrow">SAVE A SEAT FOR YOUR FRIENDS</p><h2>分享这一桌好运</h2><p>朋友连接同一局域网，打开邀请链接，或在联机入口输入房间码。</p><div class="room-code" aria-label="房间码 ${code}">${code}</div><button class="primary wide" data-action="room-invite">邀请朋友 ${icon("arrow")}</button><div class="room-tip"><strong>刷新页面，仍是原来的你。</strong><p>使用同一浏览器和访问地址，自动恢复席位与牌局。所有真人离线时，电脑也会暂停。</p></div><button class="link-button leave-room" data-action="room-leave">离开房间</button></aside></div></main>`;
}

function showNetwork() {
  openModal(
    `<p class="eyebrow">LET'S FLIP TOGETHER</p><h2 id="modal-title">一起翻，才更尽兴</h2><p class="modal-intro">连接同一 Wi-Fi 或局域网，和朋友同桌挑战 200 分。</p><form id="room-form" class="room-form"><label for="room-name">你的称呼</label><input id="room-name" name="name" maxlength="16" required autocomplete="nickname" value="${escape(prefs.name === "你" ? "" : prefs.name)}" placeholder="朋友们怎么称呼你"><label for="room-code">房间码 <span class="muted">加入朋友的房间时填写</span></label><input id="room-code" name="code" maxlength="6" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="6 位房间码" value="${validInvite}"><fieldset class="room-options"><legend>创建房间选项</legend><label class="tracker-option" for="room-card-tracker"><input id="room-card-tracker" type="checkbox" name="cardTracker" aria-describedby="tracker-option-hint"><span><strong>开启记牌器</strong><small id="tracker-option-hint">全员查看各类牌的剩余张数。房主可在准备大厅调整，加入时沿用房间设置。</small></span></label></fieldset><div class="dialog-actions"><button class="secondary" type="submit" value="create">创建房间</button><button class="primary" type="submit" value="join">加入房间 ${icon("arrow")}</button></div><p class="form-feedback" role="status"></p></form>`,
  );
  modal.querySelector("#room-name").focus();
}

async function enterRoom(form, joining) {
  if (roomBusy) return;
  const data = new FormData(form);
  const name = String(data.get("name")).trim();
  const code = String(data.get("code")).trim().toUpperCase();
  const feedback = form.querySelector(".form-feedback");
  if (joining && !/^[A-Z2-9]{6}$/.test(code)) {
    feedback.textContent = "请输入 6 位房间码。";
    return;
  }
  roomBusy = true;
  for (const button of form.querySelectorAll("button")) button.disabled = true;
  feedback.textContent = joining ? "正在加入房间…" : "正在创建房间…";
  try {
    prefs.name = name;
    persist();
    await client.enter(name, joining ? code : null, {
      cardTracker: data.get("cardTracker") === "on",
    });
    if (modal.open) closeModal();
    void loadNetworkAddresses();
    window.scrollTo({ top: 0 });
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    roomBusy = false;
    for (const button of form.querySelectorAll("button"))
      button.disabled = false;
    render();
  }
}

async function roomCommand(command) {
  if (roomBusy) return;
  if (!roomConnected) {
    toast("正在重连，请连接恢复后再操作。");
    return;
  }
  roomBusy = true;
  render();
  try {
    await client.command(command);
  } catch (error) {
    toast(error.message);
  } finally {
    roomBusy = false;
    render();
  }
}

async function loadNetworkAddresses() {
  try {
    networkAddresses = (await client.request("/api/network", undefined, null))
      .addresses;
  } catch {
    networkAddresses = [];
  }
}

async function showInvitation() {
  await loadNetworkAddresses();
  if (!roomSnapshot) return;
  const origins = ["localhost", "127.0.0.1", "[::1]"].includes(
    location.hostname,
  )
    ? networkAddresses.length
      ? networkAddresses
      : [location.origin]
    : [location.origin];
  openModal(
    `<p class="eyebrow">COME JOIN THE TABLE</p><h2 id="modal-title">邀请朋友加入</h2><p class="modal-intro">让朋友连接同一局域网，再打开下方地址。房间码：<b>${roomSnapshot.code}</b>。</p><div class="invite-links">${origins.map((origin) => `<label>邀请链接<input readonly aria-label="邀请链接" value="${escape(`${origin}/?room=${roomSnapshot.code}`)}"></label>`).join("")}</div><p class="muted">点击链接框即可全选复制。若有多个地址，选择你们共同网络对应的地址。</p><button class="primary wide" data-action="close">完成</button>`,
  );
  const input = modal.querySelector("input");
  input.focus();
  input.select();
  for (const field of modal.querySelectorAll("input"))
    field.addEventListener("click", () => field.select());
}

function handleRoomClick(action, button) {
  const commands = {
    "room-ready": () => ({ type: "ready", ready: !roomSelf().ready }),
    "room-add-bot": () => ({ type: "addBot" }),
    "room-start": () => ({ type: "start" }),
    "room-remove": () => ({ type: "remove", memberId: button.dataset.target }),
    "room-takeover": () => ({
      type: "takeover",
      memberId: button.dataset.target,
    }),
    "room-reclaim": () => ({ type: "reclaim" }),
    "room-claim-host": () => ({ type: "claimHost" }),
    "room-rematch": () => ({ type: "lobby" }),
    "room-toggle-tracker": () => ({
      type: "setCardTracker",
      cardTracker: !roomSnapshot.settings?.cardTracker,
    }),
    "room-confirm-leave": () => ({ type: "leave" }),
  };
  if (commands[action]) {
    if (action === "room-confirm-leave") closeModal();
    void roomCommand(commands[action]());
  } else if (action === "lan") {
    if (client.session) {
      soloGame = game;
      game = null;
      mode = "lan";
      screen = "lobby";
      render();
      client.connect();
    } else showNetwork();
  } else if (action === "room-lobby") {
    screen = "lobby";
    render();
    window.scrollTo({ top: 0 });
  } else if (action === "room-reconnect") client.connect();
  else if (action === "room-invite") void showInvitation();
  else if (action === "room-forget") {
    client.disconnect();
    returnToSolo();
  } else if (action === "room-leave")
    openModal(
      `<p class="eyebrow">SEE YOU NEXT TIME</p><h2 id="modal-title">离开这间房间？</h2><p class="modal-intro">${game ? "离开后，你的席位将交给电脑，本局无法再加入。只是暂时离开的话，关闭页面即可保留席位。" : "离开会释放你的席位，之后可以用房间码重新加入。"}</p><div class="dialog-actions"><button class="secondary" data-action="close">留在房间</button><button class="primary" data-action="room-confirm-leave">确认离开</button></div>`,
    );
  else return false;
  return true;
}

setInterval(updateTurnClock, 100);
render();
if (client.session) {
  soloGame = game;
  game = null;
  mode = "lan";
  screen = "lobby";
  render();
  client.connect();
  void loadNetworkAddresses();
} else if (validInvite) showNetwork();
