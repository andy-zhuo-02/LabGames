import {
  createGame,
  applyAction,
  legalMoves,
  shortestPath,
  wallError,
  coordinate,
  wallsPerPlayer,
} from "/src/game.js";
import { chooseBotAction } from "/src/bot.js";
import { TURN_SECONDS, turnLimitLabel } from "/src/clock.js";

const $ = (id) => document.getElementById(id);
const COLORS = ["#99b9ac", "#d89f7a", "#8daac6", "#cdb477"];
const NAMES = ["青松", "赤陶", "靛蓝", "金穗"];
const GOALS = { north: "上方", south: "下方", east: "右侧", west: "左侧" };
const LOCAL_KEY = "labgames-quoridor-local-v1",
  ROOM_KEY = "labgames-quoridor-room-v1";
let mode = "solo",
  level = "standard",
  game = createGame({ names: ["你", "电脑·山岚"], bots: [false, true] });
let config = { count: 2, names: ["你", "电脑·山岚"], bots: [false, true] },
  actions = [];
let actionMode = "move",
  orientation = "h",
  selectedWall = null,
  hoverWall = null,
  showPath = false;
let botTimer = null,
  toastTimer = null,
  room = null,
  snapshot = null,
  pending = false,
  connected = true,
  shareBase = location.origin;
let shownWinner = null;
let serverOffset = 0;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const store = (storage, key, value) => {
  try {
    value === null
      ? storage.removeItem(key)
      : storage.setItem(key, JSON.stringify(value));
  } catch {
    /* Play remains available when storage is disabled. */
  }
};
const read = (storage, key) => {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
};
function saveLocal() {
  store(localStorage, LOCAL_KEY, { mode, level, config, actions });
}
function restoreLocal() {
  const saved = read(localStorage, LOCAL_KEY);
  if (!saved || !["solo", "local"].includes(saved.mode)) return;
  try {
    if (
      !Array.isArray(saved.actions) ||
      saved.actions.length > 5000 ||
      !Array.isArray(saved.config.names) ||
      !Array.isArray(saved.config.bots)
    )
      throw new Error();
    const restored = saved.actions.reduce(
      (state, action) => applyAction(state, action),
      createGame(saved.config),
    );
    game = restored;
    config = saved.config;
    actions = saved.actions;
    mode = saved.mode;
    level = saved.level === "relaxed" ? "relaxed" : "standard";
  } catch {
    store(localStorage, LOCAL_KEY, null);
  }
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 3200);
}
function updateClock() {
  const online = mode === "online" && !!snapshot;
  const active = online && !!game && game.winner === null;
  const clock = snapshot?.clock;
  const timed = active && clock?.limitMs > 0 && clock.deadline != null;
  $("turn-clock").hidden = !active;
  $("clock-track").hidden = !timed;
  $("clock-rule").hidden = !active;
  if (!active) return;
  const remaining = timed
    ? Math.max(0, clock.deadline - Date.now() - serverOffset)
    : 0;
  const seconds = Math.ceil(remaining / 1000),
    low = timed && seconds <= 5;
  $("clock-value").textContent = timed ? String(seconds) : "∞";
  $("clock-unit").textContent = timed ? "秒" : "";
  $("turn-clock").classList.toggle("low", low);
  $("clock-track").classList.toggle("low", low);
  $("clock-progress").style.width = timed
    ? `${Math.min(100, (remaining / clock.limitMs) * 100)}%`
    : "0%";
  $("clock-rule").textContent = !connected
    ? "连接中断，正在重连"
    : timed && seconds === 0
      ? "时间到，等待自动走子"
      : `${turnLimitLabel(snapshot.turnSeconds)}${timed ? " · 超时自动走子" : ""}`;
  if (timed && remaining === 0) {
    $("move-button").disabled = true;
    $("wall-button").disabled = true;
    $("confirm-wall").disabled = true;
  }
}
function canAct() {
  return (
    !!game &&
    game.winner === null &&
    !game.players[game.turn].isBot &&
    !pending &&
    (mode !== "online" ||
      (connected &&
        snapshot?.self === game.turn &&
        (snapshot.clock?.deadline == null ||
          Date.now() + serverOffset < snapshot.clock.deadline)))
  );
}
const wallGeometry = (w) =>
  w.orientation === "h"
    ? { x: 52 + w.col * 56, y: 101 + w.row * 56, width: 104, height: 6 }
    : { x: 101 + w.col * 56, y: 52 + w.row * 56, width: 6, height: 104 };
function wallShape(w, color, className) {
  const r = wallGeometry(w);
  const highlight =
    w.orientation === "h"
      ? `M${r.x + 4} ${r.y + 1}h${r.width - 8}`
      : `M${r.x + 1} ${r.y + 4}v${r.height - 8}`;
  return `<g class="${className}"><rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="2" fill="${color}" stroke="#574332" stroke-width="1.2"/><path d="${highlight}" stroke="#fff8e2" opacity=".55" stroke-width="1"/></g>`;
}
function renderBoard() {
  const state = game || createGame({ count: snapshot?.count || 2 });
  const possible = canAct() && actionMode === "move" ? legalMoves(state) : [];
  const lastMove = state.history.at(-1);
  let html = `<defs><linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#70503b"/><stop offset=".45" stop-color="#4e3528"/><stop offset="1" stop-color="#35251e"/></linearGradient><linearGradient id="square" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#bd9e76"/><stop offset="1" stop-color="#a88a65"/></linearGradient><linearGradient id="square-alt" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#c4a781"/><stop offset="1" stop-color="#b19670"/></linearGradient><pattern id="grain" width="170" height="13" patternUnits="userSpaceOnUse"><path d="M0 4Q70 1 140 5T260 3M10 10Q90 7 170 12" fill="none" stroke="#211910" stroke-width=".7" opacity=".17"/></pattern>${state.players.map((p) => `<linearGradient id="pawn-${p.id}" x1="0" y1="0" x2="1" y2=".6"><stop stop-color="${COLORS[p.id]}"/><stop offset=".55" stop-color="${COLORS[p.id]}"/><stop offset="1" stop-color="#3b4242"/></linearGradient>`).join("")}</defs>
    <rect x="8" y="14" width="584" height="580" rx="12" fill="#211914"/><rect x="8" y="8" width="584" height="580" rx="12" fill="url(#wood)" stroke="#896448" stroke-width="1.5"/><rect x="13" y="13" width="574" height="570" rx="9" fill="none" stroke="#9b7554" opacity=".3"/><rect x="9" y="9" width="582" height="577" rx="12" fill="url(#grain)"/><rect x="43" y="43" width="514" height="514" rx="3" fill="#2d2119"/>`;
  const goalEdges = {
    north: "M68 29H532",
    south: "M68 571H532",
    east: "M571 68V532",
    west: "M29 68V532",
  };
  for (const p of state.players)
    html += `<path d="${goalEdges[p.goal]}" stroke="${COLORS[p.id]}" stroke-width="3" stroke-linecap="round" opacity=".55"/>`;
  for (let row = 0; row < 9; row++)
    for (let col = 0; col < 9; col++) {
      const valid = possible.some((p) => p.row === row && p.col === col);
      const pawn = state.players.find((p) => p.row === row && p.col === col);
      const label = `${coordinate({ row, col })}${pawn ? `，${pawn.name}` : ""}${valid ? "，可移动" : ""}`;
      html += `<rect x="${52 + col * 56}" y="${54 + row * 56}" width="48" height="48" rx="2" fill="#211a15"/>
      <rect class="tile${valid ? " movable" : ""}" data-row="${row}" data-col="${col}" data-cell="true" role="button" tabindex="${valid ? 0 : -1}" aria-label="${escape(label)}" x="${52 + col * 56}" y="${52 + row * 56}" width="48" height="48" rx="2" fill="url(#${(row + col) % 2 ? "square-alt" : "square"})" stroke="#d0b48e" stroke-opacity=".3" stroke-width=".65"/>`;
      if (valid)
        html += `<circle class="move-dot" cx="${76 + col * 56}" cy="${76 + row * 56}" r="10" fill="#232d28" opacity=".14"/><circle class="move-dot" cx="${76 + col * 56}" cy="${76 + row * 56}" r="4" fill="#314b42"/>`;
      if (
        lastMove?.type === "move" &&
        lastMove.fromRow === row &&
        lastMove.fromCol === col
      )
        html += `<circle cx="${76 + col * 56}" cy="${76 + row * 56}" r="3" fill="#a18e68" opacity=".45" pointer-events="none"/>`;
    }
  if (showPath && game) {
    const id =
      mode === "solo" ? 0 : mode === "online" ? snapshot.self : game.turn;
    const path = shortestPath(game, id);
    html += `<polyline class="route-line" points="${path.map((p) => `${76 + p.col * 56},${76 + p.row * 56}`).join(" ")}" fill="none" stroke="${COLORS[id]}" stroke-width="3" stroke-dasharray="3 8" stroke-linecap="round" opacity=".45"/>`;
  }
  for (const w of state.walls) html += wallShape(w, "#e1cba7", "placed-wall");
  for (const p of state.players) {
    const cx = 76 + p.col * 56,
      cy = 76 + p.row * 56;
    html += `<g class="pawn" aria-hidden="true"><ellipse cx="${cx + 2}" cy="${cy + 14}" rx="15" ry="6" fill="#241b15" opacity=".5"/>${p.id === state.turn && state.winner === null ? `<ellipse cx="${cx}" cy="${cy + 10}" rx="20" ry="11" fill="none" stroke="${COLORS[p.id]}" opacity=".75" stroke-width="1.3"/>` : ""}<ellipse cx="${cx}" cy="${cy + 10}" rx="12" ry="6" fill="url(#pawn-${p.id})" stroke="#26302d" stroke-width=".6"/><path d="M${cx - 9} ${cy + 10}Q${cx - 7} ${cy + 3} ${cx - 5} ${cy - 1}L${cx + 5} ${cy - 1}Q${cx + 7} ${cy + 3} ${cx + 9} ${cy + 10}Q${cx} ${cy + 14} ${cx - 9} ${cy + 10}" fill="url(#pawn-${p.id})"/><circle cx="${cx}" cy="${cy - 8}" r="9" fill="url(#pawn-${p.id})" stroke="#25332e" stroke-opacity=".3"/><ellipse cx="${cx - 3}" cy="${cy - 11}" rx="3" ry="2" fill="#fffef0" opacity=".4"/><path d="M${cx - 8} ${cy + 9}q8 4 16 0" stroke="#f8eee0" stroke-opacity=".3" fill="none"/></g>`;
  }
  for (let i = 0; i < 9; i++)
    html += `<text class="coordinates" x="${76 + i * 56}" y="585" text-anchor="middle">${String.fromCharCode(65 + i)}</text><text class="coordinates" x="22" y="${80 + i * 56}" text-anchor="middle">${9 - i}</text>`;
  if (actionMode === "wall" && canAct())
    for (let row = 0; row < 8; row++)
      for (let col = 0; col < 8; col++) {
        html += `<rect class="wall-hit" data-wall="true" data-row="${row}" data-col="${col}" role="button" tabindex="0" aria-label="${orientation === "h" ? "横" : "竖"}墙 ${coordinate({ row, col })}" x="${88 + col * 56}" y="${88 + row * 56}" width="32" height="32" rx="6"/>`;
      }
  html += '<g id="wall-preview"></g>';
  $("board").innerHTML = html;
  renderPreview();
}
function renderPreview() {
  const w = selectedWall || hoverWall;
  const error = w && game ? wallError(game, w) : null;
  if ($("wall-preview"))
    $("wall-preview").innerHTML = w
      ? wallShape(w, error ? "#e68c76" : "#a7cbb3", "preview-wall")
      : "";
  $("confirm-wall").disabled = !selectedWall || !!error || !canAct();
  $("wall-help").textContent =
    error ||
    (selectedWall
      ? `已选 ${coordinate(selectedWall)} ${orientation === "h" ? "横墙" : "竖墙"}，确认后消耗 1 面墙。`
      : "先点选墙位，再确认放置。");
}
function render() {
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const count = game?.players.length || snapshot?.count || 2;
  const wallLimit = wallsPerPlayer(count);
  $("match-meta").textContent =
    `${count} 人 · 每人 ${wallLimit} 面墙${mode === "online" ? ` · ${turnLimitLabel(snapshot?.turnSeconds ?? 0)} · ${room.code}` : ""}`;
  $("mode-label").textContent =
    mode === "solo"
      ? level === "relaxed"
        ? "轻松难度"
        : "标准难度"
      : mode === "local"
        ? "同屏对弈"
        : "好友联机";
  $("new-button").textContent =
    mode === "online"
      ? game?.winner != null && snapshot?.self === snapshot?.host
        ? "返回准备室"
        : "离开房间"
      : "新建对局";
  $("new-button").disabled = pending;
  $("turn-count").textContent = game
    ? `第 ${Math.floor(game.ply / count) + 1} 回合`
    : "准备开局";
  $("board-caption").innerHTML =
    `<i class="live-dot"></i> ${!game ? "准备室" : game.winner !== null ? "已结束" : "对局中"}`;
  const state = game || createGame({ count });
  $("players").innerHTML = state.players
    .map((p) => {
      const name = game
        ? p.name
        : snapshot?.members.find((m) => m.seat === p.id)?.name || "等待入座";
      const detail = game
        ? `终点：${GOALS[p.goal]} · 围墙 ${p.walls}/${wallLimit}`
        : snapshot?.members.some((m) => m.seat === p.id)
          ? `已入座 · ${wallLimit} 面墙`
          : "空位 · 开局补电脑";
      return `<div class="player" style="--player-color:${COLORS[p.id]}"><div class="player-icon" aria-hidden="true"><svg viewBox="0 0 28 38"><ellipse cx="14" cy="32" rx="11" ry="4"/><path d="M5 31Q7 23 10 18h8q3 5 5 13Z"/><circle cx="14" cy="11" r="8"/><ellipse cx="11" cy="8" rx="2.5" ry="1.5" fill="#fff" opacity=".3"/></svg></div><div class="player-info"><div class="player-name"><span class="name">${escape(name)}</span>${game && p.id === game.turn && game.winner === null ? "<small>行棋中</small>" : ""}</div><span class="player-detail">${escape(detail)}</span><div class="wall-stock" aria-hidden="true">${Array.from({ length: wallLimit }, (_, i) => `<i class="${i >= p.walls ? "used" : ""}"></i>`).join("")}</div></div><div class="player-distance">${game ? shortestPath(game, p.id).length - 1 : "—"}<small>${game ? "通路格数" : ""}</small></div></div>`;
    })
    .join("");
  const actor = state.players[state.turn],
    active = canAct();
  $("turn-marker").style.background = COLORS[actor.id];
  $("turn-title").textContent = !game
    ? "等待开局"
    : game.winner !== null
      ? `${game.players[game.winner].name}获胜`
      : active
        ? mode === "local"
          ? `轮到${actor.name}`
          : "轮到你了"
        : `${actor.isBot ? "电脑" : actor.name}${actor.isBot ? "思考中…" : "行棋中…"}`;
  $("turn-subtitle").textContent = !game
    ? "房主开始后即可行棋。"
    : game.winner !== null
      ? "已到达对岸。"
      : active
        ? `向${GOALS[actor.goal]}出发，走子或放墙。`
        : `目标：${GOALS[actor.goal]}终点`;
  $("move-button").disabled = !active;
  $("wall-button").disabled = !active || actor.walls === 0;
  for (const [id, value] of [
    ["move-button", "move"],
    ["wall-button", "wall"],
  ]) {
    $(id).classList.toggle("active", actionMode === value);
    $(id).setAttribute("aria-pressed", actionMode === value);
  }
  $("move-help").hidden = actionMode === "wall";
  $("wall-controls").hidden = actionMode !== "wall";
  $("remaining-walls").textContent = `剩余 ${actor.walls} 面围墙`;
  $("undo-button").disabled = mode !== "solo" || actions.length === 0;
  $("undo-button").title =
    mode === "solo"
      ? "撤回你最近一次行动以及之后的电脑行动"
      : "仅电脑对战支持悔棋";
  $("path-button").setAttribute("aria-pressed", showPath);
  $("path-button").textContent = showPath ? "隐藏路线" : "显示路线";
  $("path-button").disabled = !game;
  const topPlayer = state.players.find((p) => p.goal === "north"),
    bottomPlayer = state.players.find((p) => p.goal === "south");
  $("goal-top").textContent = `↑ ${topPlayer.name}的终点`;
  $("goal-bottom").textContent = `${bottomPlayer.name}的终点 ↓`;
  for (const id of ["goal-top", "goal-bottom"])
    $(id).style.visibility = !game && mode === "online" ? "hidden" : "visible";
  $("board-tip").textContent = !game
    ? "同一局域网内，用链接或房间码加入。"
    : actionMode === "wall"
      ? "在棋盘缝隙处点选墙位。绿色可放，红色不可放；按 R 旋转。"
      : showPath
        ? "虚线是忽略棋子阻挡的最短通路；侧栏格数不计算跳子。"
        : "点击亮起的格子移动棋子，也可以选择放墙。";
  const history = game?.history.slice(-6).reverse() || [];
  $("history-count").textContent = game?.ply
    ? `已落 ${game.ply} 手`
    : "对局记录";
  $("history").innerHTML = history.length
    ? history
        .map(
          (h) =>
            `<li><span class="history-number">${String(h.number).padStart(2, "0")}</span><span class="history-player" style="--player-color:${COLORS[h.player]}"></span><span class="history-name">${escape(game.players[h.player].name)}</span><span class="history-action">${h.automatic ? "超时·" : ""}${h.type === "move" ? `走至 ${coordinate(h)}` : `${h.orientation === "h" ? "横墙" : "竖墙"} ${coordinate(h)}`}</span></li>`,
        )
        .join("")
    : '<li class="empty-history">暂无操作</li>';
  renderBoard();
  renderLobby();
  updateClock();
  if (
    game?.winner !== null &&
    game &&
    shownWinner !== `${mode}-${game.ply}-${game.winner}` &&
    !$("setup-dialog").open
  ) {
    shownWinner = `${mode}-${game.ply}-${game.winner}`;
    $("win-title").textContent = `${game.players[game.winner].name}获胜`;
    $("win-detail").textContent =
      `共 ${game.ply} 手，使用 ${game.walls.length} 面围墙。`;
    $("play-again").textContent =
      mode === "online"
        ? snapshot.self === snapshot.host
          ? "返回准备室 →"
          : "等待房主开启下一局"
        : "再来一局 →";
    $("play-again").disabled =
      mode === "online" && snapshot.self !== snapshot.host;
    $("win-dialog").showModal();
  }
  scheduleBot();
}
function resetInteraction() {
  actionMode = "move";
  selectedWall = hoverWall = null;
}
function scheduleBot() {
  clearTimeout(botTimer);
  if (
    mode === "online" ||
    !game ||
    game.winner !== null ||
    !game.players[game.turn].isBot
  )
    return;
  const before = game;
  botTimer = setTimeout(() => {
    if (game !== before || mode === "online") return;
    try {
      const action = chooseBotAction(game, { level });
      game = applyAction(game, action);
      actions.push(action);
      saveLocal();
      resetInteraction();
      render();
    } catch (e) {
      toast(e.message);
    }
  }, 600);
}
async function act(action) {
  if (!canAct()) return;
  try {
    if (mode === "online") await command({ type: "action", action });
    else {
      game = applyAction(game, action);
      actions.push(action);
      saveLocal();
      resetInteraction();
      render();
    }
  } catch (error) {
    toast(error.message);
  }
}
function setAction(value) {
  if (!canAct() || (value === "wall" && game.players[game.turn].walls === 0))
    return;
  actionMode = value;
  selectedWall = hoverWall = null;
  render();
}
function setOrientation(value) {
  orientation = value;
  for (const [id, o] of [
    ["horizontal-button", "h"],
    ["vertical-button", "v"],
  ]) {
    $(id).classList.toggle("active", o === value);
    $(id).setAttribute("aria-pressed", o === value);
  }
  if (selectedWall) selectedWall = { ...selectedWall, orientation };
  if (hoverWall) hoverWall = { ...hoverWall, orientation };
  renderBoard();
}
function selectBoard(target) {
  if (!canAct()) return;
  if (target.dataset.wall) {
    selectedWall = {
      row: Number(target.dataset.row),
      col: Number(target.dataset.col),
      orientation,
    };
    renderPreview();
    if (wallError(game, selectedWall)) toast(wallError(game, selectedWall));
  } else if (target.dataset.cell && actionMode === "move")
    void act({
      type: "move",
      row: Number(target.dataset.row),
      col: Number(target.dataset.col),
    });
}
$("board").addEventListener("click", (event) => selectBoard(event.target));
$("board").addEventListener("keydown", (event) => {
  if (["Enter", " "].includes(event.key)) {
    event.preventDefault();
    selectBoard(event.target);
  }
});
for (const type of ["pointerover", "focusin"])
  $("board").addEventListener(type, (event) => {
    if (event.target.dataset.wall && !selectedWall) {
      hoverWall = {
        row: Number(event.target.dataset.row),
        col: Number(event.target.dataset.col),
        orientation,
      };
      renderPreview();
    }
  });
$("board").addEventListener("pointerleave", () => {
  hoverWall = null;
  renderPreview();
});
$("move-button").onclick = () => setAction("move");
$("wall-button").onclick = () => setAction("wall");
$("horizontal-button").onclick = () => setOrientation("h");
$("vertical-button").onclick = () => setOrientation("v");
$("rotate-button").onclick = () =>
  setOrientation(orientation === "h" ? "v" : "h");
$("confirm-wall").onclick = () => {
  if (selectedWall) void act({ type: "wall", ...selectedWall });
};
$("cancel-wall").onclick = () => {
  selectedWall = hoverWall = null;
  renderPreview();
};
$("path-button").onclick = () => {
  showPath = !showPath;
  render();
};
$("undo-button").onclick = () => {
  if (mode !== "solo" || !actions.length) return;
  clearTimeout(botTimer);
  const index = Math.floor((actions.length - 1) / config.count) * config.count;
  actions = actions.slice(0, index);
  game = actions.reduce(
    (state, action) => applyAction(state, action),
    createGame(config),
  );
  shownWinner = null;
  $("win-dialog").close();
  resetInteraction();
  saveLocal();
  render();
  toast("已回到你上次落子前");
};
document.addEventListener("keydown", (event) => {
  if (
    document.querySelector("dialog[open]") ||
    /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)
  )
    return;
  const key = event.key.toLowerCase();
  if (key === "m") setAction("move");
  if (key === "w") setAction("wall");
  if (key === "r" && actionMode === "wall")
    setOrientation(orientation === "h" ? "v" : "h");
  if (key === "escape") {
    selectedWall = hoverWall = null;
    renderPreview();
  }
});

function updateSetup() {
  const online = $("setup-mode").value === "online";
  $("online-fields").hidden = !online;
  $("difficulty-field").hidden = $("setup-mode").value !== "solo";
  $("setup-submit").innerHTML =
    `${online ? ($("room-code").value.trim() ? "加入房间" : "创建房间") : "开始对局"}`;
  $("replace-warning").hidden = online;
  $("setup-count").disabled = online && !!$("room-code").value.trim();
  $("count-field").hidden = $("setup-count").disabled;
  $("timer-field").hidden = $("setup-count").disabled;
}
function openSetup(nextMode = mode) {
  if (room) {
    toast("请先离开当前房间，再切换对弈方式");
    return;
  }
  $("win-dialog").close();
  $("setup-error").textContent = "";
  $("setup-mode").value = nextMode;
  $("setup-count").value = String(game?.players.length || 2);
  $("setup-level").value = level;
  updateSetup();
  $("setup-dialog").showModal();
}
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => $(button.dataset.close).close()),
  );
$("rules-button").onclick = () => $("rules-dialog").showModal();
$("setup-mode").onchange = updateSetup;
$("room-code").oninput = updateSetup;
document.querySelectorAll("[data-mode]").forEach(
  (button) =>
    (button.onclick = () => {
      if (mode !== button.dataset.mode) openSetup(button.dataset.mode);
    }),
);
$("new-button").onclick = async () => {
  if (room && game?.winner != null && snapshot.self === snapshot.host) {
    try {
      $("win-dialog").close();
      await command({ type: "restart" });
    } catch (e) {
      toast(e.message);
    }
  } else if (room) $("leave-dialog").showModal();
  else openSetup();
};
$("confirm-leave").onclick = () => void leaveRoom();
$("play-again").onclick = async () => {
  $("win-dialog").close();
  if (room) {
    try {
      await command({ type: "restart" });
    } catch (e) {
      toast(e.message);
    }
  } else openSetup();
};
$("setup-form").onsubmit = async (event) => {
  event.preventDefault();
  const submit = $("setup-submit");
  submit.disabled = true;
  $("setup-error").textContent = "";
  try {
    const nextMode = $("setup-mode").value,
      count = Number($("setup-count").value);
    if (nextMode === "online") {
      const code = $("room-code").value.trim().toUpperCase(),
        name = $("player-name").value;
      const data = await request(
        code ? `/api/rooms/${code}/join` : "/api/rooms",
        { name, count, turnSeconds: Number($("setup-turn-seconds").value) },
      );
      room = { code: data.code, token: data.token };
      store(sessionStorage, ROOM_KEY, room);
      mode = "online";
      snapshot = null;
      connected = true;
      receive(data.snapshot);
      history.replaceState(null, "", `?room=${room.code}`);
    } else {
      mode = nextMode;
      level = $("setup-level").value;
      const names =
        mode === "solo"
          ? count === 2
            ? ["你", "电脑·山岚"]
            : ["你", ...NAMES.slice(1, count).map((name) => `电脑·${name}`)]
          : NAMES.slice(0, count);
      config = {
        count,
        names,
        bots: Array.from({ length: count }, (_, i) => mode === "solo" && i > 0),
      };
      game = createGame(config);
      actions = [];
      saveLocal();
      history.replaceState(null, "", location.pathname);
    }
    shownWinner = null;
    resetInteraction();
    $("setup-dialog").close();
    render();
  } catch (error) {
    $("setup-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};

async function request(path, data, token) {
  let response;
  try {
    response = await fetch(path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("连接中断，请检查主机服务和局域网连接");
  }
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return result;
}
function receive(next) {
  if (snapshot && next.revision < snapshot.revision) return;
  const changed = !snapshot || next.revision !== snapshot.revision;
  snapshot = next;
  if (next.clock) serverOffset = next.clock.serverNow - Date.now();
  game = next.game;
  connected = true;
  $("connection-banner").hidden = true;
  if (changed) {
    resetInteraction();
    if (!game) {
      shownWinner = null;
      $("win-dialog").close();
    }
    render();
  }
  updateClock();
}
async function command(value) {
  if (!room || !snapshot || pending) return;
  const session = room;
  pending = true;
  render();
  try {
    const next = await request(
      `/api/rooms/${session.code}/commands`,
      { revision: snapshot.revision, command: value },
      session.token,
    );
    if (room === session && !next.left) receive(next);
    return next;
  } catch (e) {
    if (room === session) {
      try {
        receive(
          await request(`/api/rooms/${session.code}`, undefined, session.token),
        );
      } catch {
        connected = false;
      }
    }
    throw e;
  } finally {
    pending = false;
    render();
  }
}
async function leaveRoom() {
  if (!room || pending) return;
  $("confirm-leave").disabled = true;
  try {
    if (connected && snapshot) await command({ type: "leave" });
    room = snapshot = null;
    store(sessionStorage, ROOM_KEY, null);
    mode = "solo";
    connected = true;
    $("connection-banner").hidden = true;
    $("win-dialog").close();
    $("leave-dialog").close();
    history.replaceState(null, "", location.pathname);
    config = { count: 2, names: ["你", "电脑·山岚"], bots: [false, true] };
    actions = [];
    game = createGame(config);
    restoreLocal();
    shownWinner = null;
    resetInteraction();
    render();
  } catch (e) {
    toast(e.message);
  } finally {
    $("confirm-leave").disabled = false;
  }
}
function renderLobby() {
  const lobby = $("lobby");
  lobby.hidden = mode !== "online" || !!game;
  if (lobby.hidden) return;
  if (!snapshot) {
    lobby.innerHTML =
      "<h2>正在找回棋局…</h2><p>连接主机后会自动恢复你的座位。</p>";
    return;
  }
  const url = `${shareBase}/?room=${room.code}`;
  lobby.innerHTML = `<h2>准备室</h2><div class="room-label">房间码</div><div class="room-code">${room.code}</div><div class="lobby-seats">${Array.from(
    { length: snapshot.count },
    (_, id) => {
      const member = snapshot.members.find((m) => m.seat === id);
      return `<div class="lobby-seat ${member ? "joined" : ""}"><i>${id + 1}</i>${escape(member?.name || "空位")}${id === snapshot.host ? " · 房主" : ""}</div>`;
    },
  ).join(
    "",
  )}</div><span class="share-address">${escape(url)}</span><button class="text-button" id="copy-invite">复制邀请链接</button><label class="lobby-settings">每步读秒<select id="lobby-turn-seconds" ${snapshot.self !== snapshot.host || pending || !connected ? "disabled" : ""}>${TURN_SECONDS.map((seconds) => `<option value="${seconds}" ${snapshot.turnSeconds === seconds ? "selected" : ""}>${turnLimitLabel(seconds)}</option>`).join("")}</select></label><div class="lobby-rule">${snapshot.turnSeconds ? "超时自动走子 · 开局后固定" : "本局不限时"}</div><button class="primary-button" id="start-room" ${snapshot.self !== snapshot.host || pending || !connected ? "disabled" : ""}>${snapshot.self === snapshot.host ? "开始对局" : "等待房主开始"}</button><p>空位由电脑补齐。</p>`;
  $("lobby-turn-seconds").onchange = async (event) => {
    const turnSeconds = Number(event.target.value);
    try {
      await command({ type: "settings", turnSeconds });
    } catch (e) {
      toast(e.message);
    }
  };
  $("copy-invite").onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("邀请链接已复制");
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(".share-address"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast("链接已选中，请长按复制或按 Ctrl+C");
    }
  };
  $("start-room").onclick = async () => {
    try {
      await command({ type: "start" });
    } catch (e) {
      toast(e.message);
    }
  };
}
async function poll() {
  const session = room;
  if (session && !pending) {
    try {
      const next = await request(
        `/api/rooms/${session.code}`,
        undefined,
        session.token,
      );
      if (room === session) {
        const wasOffline = !connected;
        receive(next);
        if (wasOffline) render();
      }
    } catch (e) {
      if (room === session) {
        connected = false;
        $("connection-banner").hidden = false;
        $("connection-banner").textContent =
          e.status === 401 || e.status === 404
            ? `${e.message}。可点“离开房间”返回本地对局。`
            : "与主机的连接暂时中断，正在重连。棋局会保留，请稍候…";
        render();
      }
    }
  }
  setTimeout(poll, 1000);
}
restoreLocal();
const savedRoom = read(sessionStorage, ROOM_KEY);
const invitation = new URLSearchParams(location.search)
  .get("room")
  ?.toUpperCase();
if (
  savedRoom?.code &&
  savedRoom?.token &&
  (!invitation || invitation === savedRoom.code)
) {
  room = savedRoom;
  mode = "online";
  game = null;
  connected = false;
}
render();
void poll();
setInterval(updateClock, 200);
void request("/api/network")
  .then((data) => {
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) &&
      data.addresses?.length
    )
      shareBase = data.addresses[0];
    renderLobby();
  })
  .catch(() => {});
if (invitation && /^[A-F0-9]{6}$/.test(invitation) && !room) {
  $("room-code").value = invitation;
  openSetup("online");
}
