"use strict";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (value) => Number(value).toLocaleString("zh-CN");
const signed = (value) => `${value > 0 ? "+" : ""}${fmt(value)}`;
const profitClass = (value) => value > 0 ? "positive" : value < 0 ? "negative" : "";
const prefs = {
  get(key, fallback) { try { return localStorage.getItem(`river.${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`river.${key}`, value); } catch { /* Private browsing can disable storage. */ } },
};
const ROOMS = {
  easy: {name:"轻松练手", bots:["calling_station","random","loose","calling_station","random"]},
  normal: {name:"认真过招", bots:["tight","loose","push_fold","random","tight"]},
  hard: {name:"挑战一下", bots:["equity","nit","loose","tight","push_fold"]},
};
const POSITIONS = {
  2:[[50,85],[50,14]],
  3:[[50,85],[23,20],[77,20]],
  4:[[50,85],[18,42],[50,12],[82,42]],
  5:[[50,86],[17,60],[27,16],[73,16],[83,60]],
  6:[[50,87],[17,65],[20,24],[50,10],[80,24],[83,65]],
};
let state = null, busy = false, offline = false, botTimer = null, toastTimer = null;
let raiseTo = 0, raiseVersion = -1, audioContext = null;
let sound = prefs.get("sound", "off") === "on";
let pollTimer = null, polling = false, mutationEpoch = 0, lastControlsKey = null, pendingAllIn = null;
const multiplayer = () => state?.mode === "multiplayer";
const viewerId = () => state?.viewer_id ?? 0;
const heroPlayer = () => state.players.find((player) => player.id === viewerId());
const scope = (snapshot = state) => snapshot?.room_info?.code || "solo";

function card(code, hidden = false) {
  if (hidden) return '<span class="card back" role="img" aria-label="未公开的底牌"></span>';
  if (!code) return '<span class="card empty" aria-hidden="true">·</span>';
  const rank = code[0] === "T" ? "10" : code[0];
  const suit = {s:"♠",h:"♥",d:"♦",c:"♣"}[code[1]];
  const suitName = {s:"黑桃",h:"红桃",d:"方块",c:"梅花"}[code[1]];
  return `<span class="card ${"hd".includes(code[1]) ? "red" : ""}" role="img" aria-label="${esc(suitName + rank)}"><span class="rank">${esc(rank)}</span><span class="suit">${suit}</span><span class="large-suit" aria-hidden="true">${suit}</span></span>`;
}

function updateHTML(element, html) { if (element.innerHTML !== html) element.innerHTML = html; }
function notify(message) {
  $("toast").textContent = message; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200);
}
function playSound(result = false) {
  if (!sound) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const now = audioContext.currentTime;
    (result ? [523,659,784] : [530]).forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      const start = now + index * .1;
      oscillator.frequency.value = frequency; oscillator.type = "sine";
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.045, start + .01);
      gain.gain.exponentialRampToValueAtTime(.001, start + .12);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start + .13);
    });
  } catch { /* Audio is optional. */ }
}
function hasModal() { return [...document.querySelectorAll("dialog")].some((dialog) => dialog.open); }
function openDialog(id) { clearTimeout(botTimer); $(id).showModal(); }
function closeDialog(id) { $(id).close(); scheduleBot(); }

async function timedFetch(url, options = {}, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, {...options, signal:controller.signal}); }
  finally { clearTimeout(timer); }
}

async function request(route = "state", payload = null) {
  if (busy) return false;
  mutationEpoch += 1;
  busy = true; clearTimeout(botTimer); renderControls(); $("start-button").disabled = true;
  let ok = false;
  try {
    const response = await timedFetch(`/api/${route}`, {
      method: payload ? "POST" : "GET", cache:"no-store",
      headers: payload ? {"Content-Type":"application/json", "X-Poker-Client":"1"} : {},
      body: payload ? JSON.stringify({...payload, version:state?.version, room_code:state?.room_info?.code}) : undefined,
    });
    const data = await response.json();
    if (data.state) state = data.state;
    if (!response.ok) {
      if ($("network-dialog").open) { $("network-error").textContent = data.error; $("network-error").hidden = false; }
      if (route === "new") { $("setup-error").textContent = data.error; $("setup-error").hidden = false; }
      else notify(data.error || "操作没有完成，请重试。");
    } else {
      const previousVersion = state?.version;
      state = data; ok = true;
      if (route === "room/leave") history.replaceState(null, "", location.pathname);
      if (payload && route !== "new" && state.version !== previousVersion) playSound(state.result?.profit > 0);
    }
    offline = response.status >= 500;
    $("connection").hidden = !offline;
    if (offline) $("connection-message").textContent = "牌桌暂时无法完成操作，已暂停自动行动。请重新连接后继续。";
  } catch {
    offline = true;
    $("connection-message").textContent = "暂时连不上牌桌。请确认游戏启动窗口仍在运行，再重新连接。";
    $("connection").hidden = false;
    if ($("lobby").open) { $("setup-error").textContent = "连接未完成，请稍后重试。启动游戏的窗口需要保持运行。"; $("setup-error").hidden = false; }
    notify("连接暂时中断，重新连接后会恢复牌桌。");
  } finally {
    busy = false; $("start-button").disabled = false;
    render(); scheduleBot(); schedulePoll();
  }
  return ok;
}

function scheduleBot() {
  clearTimeout(botTimer);
  if (multiplayer() || busy || offline || hasModal() || document.hidden || state?.phase !== "playing" || state.actor_id === viewerId()) return;
  botTimer = setTimeout(() => request("step", {}), Number($("pace").value));
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (multiplayer()) pollTimer = setTimeout(pollRoom, document.hidden ? 1500 : 800);
}
async function pollRoom() {
  if (!multiplayer()) return;
  if (busy || polling) { schedulePoll(); return; }
  polling = true;
  const epoch = mutationEpoch;
  try {
    const response = await timedFetch("/api/state", {cache:"no-store"}, 10000);
    if (!response.ok) throw new Error("Connection unavailable");
    const data = await response.json();
    if (busy || epoch !== mutationEpoch) return;
    if (scope(data) === scope() && data.version < state.version) return;
    const changed = data.version !== state.version;
    state = data; offline = false; $("connection").hidden = true;
    if (changed) playSound(state.result?.profit > 0);
    render();
  } catch {
    if (epoch !== mutationEpoch) return;
    offline = true;
    $("connection-message").textContent = "与房间的连接暂时中断，正在重新连接。请保持同一 Wi-Fi；恢复后会回到你的座位。";
    $("connection").hidden = false; renderControls(); renderRoom();
  } finally { polling = false; schedulePoll(); }
}

function renderSeats(players, current) {
  const viewerIndex = players.findIndex((player) => player.id === viewerId());
  if (viewerIndex > 0) players = [...players.slice(viewerIndex), ...players.slice(0, viewerIndex)];
  const positions = POSITIONS[players.length];
  // Keep seat elements stable, so new actions do not animate every card again.
  if ($("seats").children.length !== players.length) {
    $("seats").replaceChildren(...players.map(() => { const el = document.createElement("div"); el.className = "seat"; return el; }));
  }
  players.forEach((player, index) => {
    const el = $("seats").children[index];
    el.className = `seat ${player.id === viewerId() ? "hero" : ""} ${player.id === current ? "active" : ""} ${player.folded ? "folded" : ""} ${player.eliminated ? "eliminated" : ""}`;
    el.style.setProperty("--x", `${positions[index][0]}%`); el.style.setProperty("--y", `${positions[index][1]}%`);
    el.style.setProperty("--avatar", player.color);
    let status = player.eliminated ? "已离桌" : player.folded ? "已弃牌" : player.all_in ? "全下" : player.id === current ? player.id === viewerId() ? "轮到你了" : player.strategy === "human" ? "正在选择动作…" : "正在思考…" : player.last_action || "等待行动";
    if (multiplayer() && player.strategy === "human" && !player.online) status += " · 离线";
    if (state?.phase === "finished") {
      const revealed = state.result.shown_hands.some((hand) => hand.player_id === player.id);
      if (revealed) status = player.eliminated ? "已摊牌 · 筹码用尽" : "已摊牌";
      else if (player.folded) status = "已弃牌 · 不参与摊牌";
      else if (!player.eliminated && state.result.end_reason === "folds") status = "无需摊牌";
    }
    const position = player.position.includes("BTN") ? player.position === "BTN/SB" ? "D / SB" : "D" : player.position;
    const cards = player.eliminated && !player.cards.length ? "" : player.cards.length ? player.cards.map((c) => card(c)).join("") : card(null,true).repeat(2);
    if (!el.children.length) el.innerHTML = '<div class="hole-cards"></div><div class="seat-box"></div><div class="seat-action"></div><span class="seat-bet"></span>';
    const holes = el.querySelector(".hole-cards");
    holes.setAttribute("aria-label", `${player.name}的底牌`);
    updateHTML(holes, cards);
    updateHTML(el.querySelector(".seat-box"), `<div class="seat-top"><span class="avatar" aria-hidden="true">${esc(player.avatar)}</span><div><div class="seat-name" title="${esc(player.name)}">${esc(player.name)}${player.id === viewerId() && player.name !== "你" ? " · 你" : ""}</div><div class="seat-style">${esc(player.style)}</div></div></div><div class="seat-money">${fmt(player.stack)}</div>${position ? `<span class="position ${position.includes("D") ? "dealer" : ""}" title="${esc(player.position)}">${esc(position)}</span>` : ""}`);
    el.querySelector(".seat-action").textContent = status;
    el.querySelector(".seat-bet").hidden = !player.bet;
    el.querySelector(".seat-bet").textContent = `◉ ${fmt(player.bet || 0)}`;
  });
  $("arena").dataset.count = players.length;
}

function render() {
  $("sound-button").textContent = `音效：${sound ? "开" : "关"}`;
  $("sound-button").setAttribute("aria-pressed", String(sound));
  renderRoom();
  if (state?.phase === "waiting") return;
  const playing = state && state.phase !== "lobby";
  $("close-lobby").hidden = !playing;
  $("room-button").textContent = playing ? "换牌桌" : "选牌桌";
  if (!playing) {
    updateHTML($("board"), Array.from({length:5}, () => card(null)).join(""));
    renderSeats([
      {id:0,name:"你",avatar:"你",style:"真人",color:"#e8cb87",stack:2000,position:"",cards:[]},
      {id:1,name:"阿豆",avatar:"豆",style:"爱跟注",color:"#82c5a9",stack:2000,position:"",cards:[]},
      {id:2,name:"米粒",avatar:"米",style:"随性派",color:"#b78cea",stack:2000,position:"",cards:[]},
    ], null);
    if (state?.phase === "lobby" && !hasModal()) {
      if (state.network?.enabled || new URLSearchParams(location.search).has("room")) showNetwork();
      else showLobby();
    }
    renderControls(); return;
  }
  $("room-label").textContent = `${state.room} · ${state.players.length} 人桌`;
  $("heading").textContent = state.room;
  $("hand-label").textContent = `第 ${state.hand_number} 手`;
  $("street-label").textContent = state.phase === "finished" ? "本手结算" : state.street_name;
  $("pot-value").textContent = fmt(state.result ? state.result.pot : state.pot);
  $("table-note").textContent = state.phase === "finished" ? state.result.end_reason === "folds" ? "其他玩家均弃牌 · 无需摊牌" : "摊牌结束 · 筹码已结算" : "翻牌 3 张  ·  转牌 1 张  ·  河牌 1 张";
  // Patch individual community slots: only newly dealt cards animate.
  if ($("board").children.length !== 5) $("board").innerHTML = Array.from({length:5}, () => card(null)).join("");
  for (let index = 0; index < 5; index++) {
    const current = $("board").children[index], code = state.board[index] || "";
    if (current.dataset.card !== code) { current.outerHTML = card(code); $("board").children[index].dataset.card = code; }
  }
  renderSeats(state.players, state.actor_id);
  $("session-profit").textContent = signed(state.stats.profit); $("session-profit").className = profitClass(state.stats.profit);
  $("hands-played").textContent = state.stats.hands; $("hands-won").textContent = state.stats.wins;
  updateHTML($("activity"), state.actions.length ? state.actions.slice().reverse().map((a) => `<li><small>${esc(a.street)}</small><b>${esc(a.player)}</b><span>${esc(a.description)}</span></li>`).join("") : '<li class="empty-note">盲注已就位，底牌已发出。<br>好戏开场。</li>');
  $("history-count").textContent = state.history.length;
  updateHTML($("history"), state.history.length ? state.history.map((h) => `<div class="history-item">第 ${h.hand_number} 手<strong class="${profitClass(h.profit)}">${signed(h.profit)}</strong><p>${h.winners.map(esc).join("、")} 收下底池</p></div>`).join("") : '<p class="empty-note">打完第一手，故事就开始了。</p>');
  renderControls();
}

function renderControls() {
  if (state?.phase === "waiting") return;
  const key = `${scope()}:${viewerId()}:${state?.version}:${busy}:${offline}`;
  if (key === lastControlsKey) return;
  lastControlsKey = key;
  const container = $("controls"), strength = $("hand-strength");
  strength.hidden = !state?.hand_type;
  strength.textContent = state?.hand_type ? `当前牌型 · ${state.hand_type}` : "";
  if (!state || state.phase === "lobby") {
    $("turn-title").textContent = offline ? "等待连接" : "你的座位已经留好";
    $("turn-hint").textContent = "选几个合拍的牌友，开始今晚的第一手。";
    updateHTML(container, '<button class="primary" id="join-table">选择牌桌 →</button>');
    $("join-table").onclick = showLobby; return;
  }
  const hero = heroPlayer(), disabled = busy || offline;
  if (state.phase === "finished") {
    const result = state.result;
    $("turn-title").textContent = result.match_over ? result.hero_won_table ? "你是这一桌的最后赢家！" : "今晚这一桌，先到这里" : result.title;
    $("turn-hint").textContent = `本手 ${signed(result.profit)} 筹码${result.match_over && hero.stack === 0 ? " · 重新开桌，就能再来一局" : " · 按你的节奏，准备好了再发牌"}`;
    const payouts = result.payouts.map((p) => `${esc(p.label)}：${p.awards.map((a) => `${esc(a.name)} +${fmt(a.amount)}`).join("、")}`).join("<br>");
    const hands = result.shown_hands.map((h) => `<div class="showdown-hand"><div class="showdown-cards" aria-label="${esc(h.name)}的摊牌">${h.cards.map((code) => card(code)).join("")}</div><div class="showdown-player"><b title="${esc(h.name)}">${esc(h.name)}</b><span>${esc(h.hand_type)}</span></div></div>`).join("");
    const returns = result.returned_bets.map((bet) => `${esc(bet.name)}退回 ${fmt(bet.amount)}`).join("、");
    updateHTML(container, `<div class="result-row"><div class="result-detail"><p>${payouts}</p>${returns ? `<p class="muted">未被跟注：${returns}</p>` : ""}</div><button id="next-hand" class="primary" ${disabled ? "disabled" : ""}>${result.match_over ? "再开一桌" : "下一手 →"}</button></div><p class="result-explanation">${esc(result.explanation || "本手已结算，以下为已亮出的底牌。")}</p>${hands ? `<section class="showdown-list" aria-label="本手摊牌对比">${hands}</section>` : ""}`);
    if (multiplayer()) {
      $("next-hand").disabled = disabled || !state.room_info.is_host;
      $("next-hand").textContent = state.room_info.is_host ? result.match_over ? "返回等候室" : "下一手 →" : "等待房主";
      $("turn-hint").textContent = `本手 ${signed(result.profit)} 筹码 · ${result.match_over ? "整桌结束，房主可以组织下一局" : "由房主决定何时发下一手"}`;
      $("next-hand").onclick = () => request(result.match_over ? "room/rematch" : "next", {});
    } else $("next-hand").onclick = result.match_over ? showLobby : () => request("next", {});
    return;
  }
  const myTurn = state.actor_id === viewerId();
  if (!myTurn) {
    const actor = state.players.find((p) => p.id === state.actor_id);
    $("turn-title").textContent = `${actor?.name || "牌友"}${actor?.strategy === "human" ? "的回合" : " 正在思考"}`;
    $("turn-hint").textContent = hero.folded ? "已弃牌。看看其他人的故事，或直接查看结果。" : hero.all_in ? "你已全下，接下来交给牌面。" : "留意对手的动作，轮到你时操作按钮会亮起。";
    updateHTML(container, `<div class="waiting"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${busy ? "正在推进牌局…" : "牌友行动中"}</span>${!multiplayer() && (hero.folded || hero.all_in) ? `<button id="finish-hand" class="outline" ${disabled ? "disabled" : ""}>快速看结果</button>` : ""}</div>`);
    if (multiplayer()) $("turn-hint").textContent = hero.eliminated ? "你的筹码已用尽，可以继续观看朋友对战。" : hero.folded ? "本手已弃牌，等待其他牌友完成。" : "所有设备同步牌桌，请等待当前玩家操作。";
    if ($("finish-hand")) $("finish-hand").onclick = () => request("finish", {}); return;
  }
  const legal = state.legal, canRaise = legal.min_raise_to !== null;
  const bettingKey = `${scope()}:${viewerId()}:${state.version}`;
  if (raiseVersion !== bettingKey) { raiseTo = legal.min_raise_to || 0; raiseVersion = bettingKey; }
  $("turn-title").textContent = "轮到你了";
  $("turn-hint").textContent = legal.check ? "现在可以免费过牌，也可以主动下注。" : `跟注需要 ${fmt(legal.call_amount)} 筹码${legal.call_amount === hero.stack ? "，将投入全部剩余筹码" : ""}。不用着急，想好了再出手。`;
  updateHTML(container, `<div class="action-buttons"><button id="fold" ${disabled || !legal.fold ? "disabled" : ""}>弃牌</button><button id="check-call" class="call" ${disabled ? "disabled" : ""}>${legal.check ? "过牌" : `跟注 ${fmt(legal.call_amount)}`}</button><button id="raise" class="primary" ${disabled || !canRaise ? "disabled" : ""}>${canRaise ? `加到 ${fmt(raiseTo)}` : "不可加注"}</button><button id="all-in" class="all-in" ${disabled || !legal.all_in ? "disabled" : ""}>全下</button></div>${canRaise ? `<div class="raise-controls"><label class="raise-slider"><span class="sr-only">本轮加注到</span><input id="raise-slider" type="range" min="${legal.min_raise_to}" max="${legal.max_raise_to}" value="${raiseTo}" step="1" ${disabled ? "disabled" : ""}></label><label class="raise-amount"><span class="sr-only">本轮加注总额</span><input id="raise-number" type="number" inputmode="numeric" min="${legal.min_raise_to}" max="${legal.max_raise_to}" value="${raiseTo}" step="1" ${disabled ? "disabled" : ""}></label></div><div class="quick-bets"><button data-bet="min" ${disabled ? "disabled" : ""}>最小</button><button data-bet="half" ${disabled ? "disabled" : ""}>½ 底池</button><button data-bet="pot" ${disabled ? "disabled" : ""}>底池</button><span id="raise-caption" class="raise-caption">再投入 ${fmt(raiseTo - hero.bet)} 筹码</span></div>` : ""}`);
  $("fold").onclick = () => request("action", {kind:"fold"});
  $("check-call").onclick = () => legal.call_amount === hero.stack && !legal.check ? confirmAllIn() : request("action", {kind:legal.check ? "check" : "call"});
  $("all-in").onclick = confirmAllIn;
  $("raise").onclick = () => raiseTo === hero.bet + hero.stack ? confirmAllIn() : request("action", {kind:"raise", amount:raiseTo});
  if (canRaise) {
    $("raise-slider").oninput = (event) => setRaise(event.target.value);
    $("raise-number").onchange = (event) => setRaise(event.target.value);
    document.querySelectorAll("[data-bet]").forEach((button) => { button.onclick = () => {
      const potAfterCall = state.pot + legal.call_amount;
      setRaise(button.dataset.bet === "min" ? legal.min_raise_to : hero.bet + legal.call_amount + Math.round(potAfterCall * (button.dataset.bet === "half" ? .5 : 1)));
    }; });
  }
}
function setRaise(value) {
  raiseTo = Math.min(state.legal.max_raise_to, Math.max(state.legal.min_raise_to, Math.round(Number(value)) || state.legal.min_raise_to));
  $("raise-slider").value = raiseTo; $("raise-number").value = raiseTo;
  $("raise").textContent = `加到 ${fmt(raiseTo)}`;
  $("raise-caption").textContent = `再投入 ${fmt(raiseTo - heroPlayer().bet)} 筹码`;
}
function confirmAllIn() {
  pendingAllIn = {version:state.version, scope:scope()};
  $("all-in-copy").textContent = `这会投入你剩下的 ${fmt(heroPlayer().stack)} 筹码。本手仍可能失利，确定就放手一搏。`;
  openDialog("all-in-dialog");
}

function selectedRoom() { return document.querySelector('input[name="room"]:checked').value; }
function populateOpponents() {
  const room = ROOMS[selectedRoom()], count = Number($("player-count").value) - 1;
  const catalog = state?.catalog || [];
  $("opponent-picker").innerHTML = Array.from({length:count}, (_, i) => `<label>牌友 ${i + 1}<select data-opponent="${i}">${catalog.map((bot) => `<option value="${esc(bot.id)}" ${bot.id === room.bots[i] ? "selected" : ""}>${esc(bot.name)} · ${esc(bot.style)}</option>`).join("")}</select><small id="bot-description-${i}">${esc(catalog.find((b) => b.id === room.bots[i])?.description || "")}</small></label>`).join("");
  document.querySelectorAll("[data-opponent]").forEach((select) => { select.onchange = () => {
    $(`bot-description-${select.dataset.opponent}`).textContent = catalog.find((b) => b.id === select.value).description;
  }; });
}
function showLobby() {
  if (busy || !state) return;
  if (multiplayer()) { notify("请先退出好友房，再开始单人游戏。"); return; }
  const continuing = state && state.phase !== "lobby";
  $("setup-note").textContent = continuing ? "重新开桌会结束当前牌局，所有人恢复 2,000 筹码。关闭此窗口可以继续原来的牌局。" : "无需注册。AI 只知道自己的底牌和桌上的公开信息。";
  $("setup-error").hidden = true;
  $("start-button").innerHTML = continuing ? '重新开桌 <span aria-hidden="true">→</span>' : '入座，开始玩 <span aria-hidden="true">→</span>';
  populateOpponents();
  if (!$("lobby").open) openDialog("lobby");
}

function renderRoom() {
  const room = state?.room_info;
  $("room-panel").hidden = !room;
  document.querySelector(".game-layout").hidden = state?.phase === "waiting";
  $("room-button").hidden = !!room;
  $("friends-button").textContent = room ? "房间信息" : "和朋友玩";
  $("pace").closest("label").hidden = !!room;
  if (!room) return;
  $("room-code").textContent = room.code;
  if ($("invite-url").value !== room.join_url) $("invite-url").value = room.join_url;
  $("waiting-room").hidden = state.phase !== "waiting";
  const actor = state.players?.find((player) => player.id === state.actor_id);
  $("room-status").textContent = `房主：${room.host_name} · ${state.phase === "waiting" ? "把邀请链接发给同一 Wi-Fi 下的朋友" : "已开局，暂不接受新玩家"}${actor?.strategy === "human" ? ` · ${actor.name}还剩 ${room.remaining_seconds} 秒` : ""}${room.notice ? ` · ${room.notice}` : ""}`;
  $("leave-room").disabled = busy;
  if (state.phase === "waiting") {
    $("heading").textContent = "朋友的牌桌"; $("hand-label").textContent = "等候开局";
    $("room-label").textContent = `房间 ${room.code}`;
    const members = room.members.map((member) => `<div class="room-member"><b>${esc(member.name)}${member.is_you ? " · 你" : ""}</b><span>${member.is_host ? "房主 · " : ""}${member.online ? "已入座" : "暂时离线"}</span></div>`);
    for (let i = room.members.length; i < room.capacity; i++) members.push(`<div class="room-member empty"><b>空座位</b><span>${room.fill_bots ? `开局由${esc(room.bot_style)} AI 补位` : "等待朋友加入"}</span></div>`);
    updateHTML($("room-members"), members.join(""));
    $("waiting-note").textContent = `${room.members.length} 位朋友已入座 · 最多 ${room.capacity} 人${room.fill_bots ? " · 空位由 AI 补齐" : " · 至少两人即可开局"}。`;
    $("start-room").disabled = busy || offline || !room.can_start;
    $("start-room").textContent = room.is_host ? "开始发牌 →" : "等待房主开始";
  }
}

function showNetwork() {
  if (busy || !state) return;
  if (multiplayer()) { $("room-panel").scrollIntoView({behavior:"smooth", block:"start"}); return; }
  if ($("lobby").open) $("lobby").close();
  $("network-error").hidden = true;
  $("friend-name").value = prefs.get("name", "");
  $("join-code").value = new URLSearchParams(location.search).get("room") || "";
  $("network-hint").textContent = state.network?.enabled ? "创建房间后，把邀请链接发给同一 Wi-Fi 下的朋友。每台设备用各自的浏览器加入。" : "当前只有本机可访问。要邀请其他设备，请用局域网模式启动游戏：./start_game.sh --lan";
  $("room-bot").innerHTML = state.catalog.map((bot) => `<option value="${esc(bot.id)}" ${bot.id === "calling_station" ? "selected" : ""}>${esc(bot.name)} · ${esc(bot.style)}</option>`).join("");
  if (!$("network-dialog").open) openDialog("network-dialog");
}

async function enterRoom(create) {
  if (!$("friend-name").reportValidity()) return;
  const name = $("friend-name").value.trim();
  $("network-error").hidden = true;
  const payload = create ? {name, capacity:Number($("room-capacity").value), fill_bots:$("fill-bots").checked, bot_strategy:$("room-bot").value} : {name, code:$("join-code").value.trim().toUpperCase()};
  if (await request(create ? "room/create" : "room/join", payload)) {
    prefs.set("name", name);
    history.replaceState(null, "", `/?room=${encodeURIComponent(state.room_info.code)}`);
    closeDialog("network-dialog");
    $("room-panel").scrollIntoView({block:"start"});
  }
}

async function copyInvite() {
  const input = $("invite-url");
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Manual copy needed");
    await navigator.clipboard.writeText(input.value);
    notify("邀请链接已复制，发给同一 Wi-Fi 下的朋友即可。");
  } catch {
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    try { if (document.execCommand("copy")) { notify("邀请链接已复制。"); return; } } catch { /* Select for touch copy. */ }
    notify("链接已选中，长按链接或按 Ctrl+C 复制。");
  }
}

$("player-name").value = prefs.get("name", "");
$("pace").value = ["1200","800","300"].includes(prefs.get("pace", "800")) ? prefs.get("pace", "800") : "800";
$("room-button").onclick = showLobby;
$("close-lobby").onclick = () => closeDialog("lobby");
$("help-button").onclick = () => openDialog("help");
$("friends-button").onclick = showNetwork;
$("lobby-friends").onclick = showNetwork;
$("create-room").onclick = () => enterRoom(true);
$("join-room").onclick = () => enterRoom(false);
$("join-code").addEventListener("keydown", (event) => { if (event.key === "Enter") enterRoom(false); });
$("fill-bots").onchange = () => { $("room-bot-label").hidden = !$("fill-bots").checked; };
$("start-room").onclick = () => request("room/start", {});
$("copy-invite").onclick = copyInvite;
$("leave-room").onclick = () => openDialog("leave-room-dialog");
$("confirm-leave-room").onclick = async () => { if (await request("room/leave", {})) closeDialog("leave-room-dialog"); };
$("retry-button").onclick = () => request();
$("pace").onchange = () => { prefs.set("pace", $("pace").value); scheduleBot(); };
$("sound-button").onclick = () => { sound = !sound; prefs.set("sound", sound ? "on" : "off"); playSound(); render(); };
$("player-count").onchange = populateOpponents;
document.querySelectorAll('input[name="room"]').forEach((input) => { input.onchange = populateOpponents; });
document.querySelectorAll("[data-close]").forEach((button) => { button.onclick = () => closeDialog(button.dataset.close); });
document.querySelectorAll("dialog").forEach((dialog) => { dialog.addEventListener("close", scheduleBot); });
$("lobby").addEventListener("cancel", (event) => { if (!state || state.phase === "lobby" || busy) event.preventDefault(); });
$("confirm-all-in").onclick = () => {
  closeDialog("all-in-dialog");
  if (!pendingAllIn || state.version !== pendingAllIn.version || scope() !== pendingAllIn.scope) { notify("牌桌已经更新，请重新确认当前动作。"); return; }
  request("action", {kind:"all_in"});
};
$("setup-form").onsubmit = async (event) => {
  event.preventDefault();
  const name = $("player-name").value.trim() || "你";
  const opponents = [...document.querySelectorAll("[data-opponent]")].map((select) => select.value);
  const preset = ROOMS[selectedRoom()];
  const customized = opponents.some((bot, i) => bot !== preset.bots[i]);
  if (await request("new", {name, opponents, room:customized ? "自由组桌" : preset.name})) {
    prefs.set("name", name); closeDialog("lobby");
    $("turn-title").focus({preventScroll:true});
  }
};
document.addEventListener("visibilitychange", () => {
  clearTimeout(botTimer);
  if (multiplayer()) { if (!document.hidden) pollRoom(); }
  else if (!document.hidden && !busy && !hasModal()) request();
});

// Optional page tools use the exact public view shown to the player.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = (tool) => {
    try { Promise.resolve(document.modelContext.registerTool(tool, {signal:lifecycle.signal})).catch(() => {}); }
    catch { /* Unsupported implementations must not affect gameplay. */ }
  };
  const emptyInput = {type:"object", properties:{}, additionalProperties:false};
  const validateEmpty = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("This tool accepts an empty object.");
  };
  register({name:"read_poker_table", title:"查看当前牌桌", description:"Read the player's visible poker table, legal actions and result. Opponent cards are included only when officially shown. Does not advance the game.", inputSchema:emptyInput, annotations:{readOnlyHint:true,untrustedContentHint:true}, execute(input) {
    validateEmpty(input);
    if (!state) return {phase:"loading"};
    const {phase,viewer_id,hand_number,street_name,actor_id,players,board,pot,legal,result} = state;
    return JSON.parse(JSON.stringify({phase,viewer_id,hand_number,street_name,actor_id,players,board,pot,legal,result}));
  }});
  register({name:"open_poker_setup", title:"打开单人选桌窗口", description:"Open the solo table setup dialog and pause solo AI turns. Does not create a table or end a game. Unavailable while the player belongs to a shared multiplayer room.", inputSchema:emptyInput, annotations:{readOnlyHint:false,untrustedContentHint:false}, execute(input) {
    validateEmpty(input);
    if (busy || !state) throw new Error("Please wait for the current request to complete.");
    if (multiplayer()) throw new Error("The player must leave the shared room before opening solo setup.");
    showLobby(); return {setup_open:$("lobby").open};
  }});
  window.addEventListener("pagehide", (event) => { if (!event.persisted) lifecycle.abort(); });
}
render();
request();
