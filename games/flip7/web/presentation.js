import { cardArtwork, cardArtKey } from "./card-art.js";

// Shared presentation data stays deterministic across solo and network snapshots.
export function standings(game) {
  const sorted = [...game.players].sort((a, b) => b.score - a.score);
  let rank = 0;
  return sorted.map((player, index) => {
    if (!index || player.score !== sorted[index - 1].score) rank = index + 1;
    const rounds = game.history.flatMap((round) =>
      round.scores.filter((score) => score.id === player.id),
    );
    return {
      ...player,
      rank,
      tied: sorted.some(
        (other) => other.id !== player.id && other.score === player.score,
      ),
      bestRound: Math.max(0, ...rounds.map((round) => round.points)),
      flipCount: game.history.filter((round) => round.flipId === player.id)
        .length,
    };
  });
}

export function presentationEvents(previous, next) {
  if (!next) return [];
  // An arriving snapshot may contain old reshuffles; only a new game replays its initial shuffle.
  const after = previous?.eventId ?? (next.revision === 0 ? 0 : next.eventId);
  const events = next.events.filter(
    (event) => event.id > after && event.type === "shuffle",
  );
  const flip = next.events.findLast(
    (event) =>
      event.id > after && event.type === "flip7" && event.round === next.round,
  );
  if (flip) {
    // The round record identifies the achiever even when someone else drew Flip Three.
    const flipId = next.history.find(
      (round) => round.round === flip.round,
    )?.flipId;
    const player = next.players.find((p) => p.id === flipId);
    if (player) events.push({ type: "flip7", player });
  }
  if (next.phase === "finished" && previous?.phase !== "finished")
    events.push({
      type: "victory",
      winner: next.players.find((p) => p.id === next.winner),
    });
  return events;
}

const honorStarts = new Map();
const honorSurfaces = new WeakMap();
const HONOR_DURATION = 4200;

// Resume the same flourish when a network acknowledgement replaces the score rows.
// History supplies the permanent medal; this clock only tracks a new achievement.
export function resumeScoreHonors() {
  const now = performance.now();
  for (const [id, start] of honorStarts) {
    if (now - start >= HONOR_DURATION) honorStarts.delete(id);
  }
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  for (const badge of document.querySelectorAll("[data-flip-honor]")) {
    const start = honorStarts.get(badge.dataset.flipHonor);
    const surface = badge.closest(".score-row") || badge;
    if (start === undefined || reducedMotion) {
      surface.classList.remove("is-awarding");
      honorSurfaces.delete(surface);
      continue;
    }
    if (honorSurfaces.get(surface) === start) continue;
    surface.classList.add("is-awarding");
    for (const animation of surface.getAnimations({ subtree: true })) {
      animation.currentTime = now - start;
    }
    honorSurfaces.set(surface, start);
  }
}

const timers = new Map();
function hide(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const element = document.getElementById(id);
  if (
    typeof element.hidePopover === "function" &&
    element.matches(":popover-open")
  )
    element.hidePopover();
  element.hidden = true;
  if (id === "celebration") {
    delete element.dataset.applauseId;
    element.classList.remove("is-applause");
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.removeAttribute("aria-labelledby");
  }
}
function show(id, duration) {
  const element = document.getElementById(id);
  element.hidden = false;
  element.showPopover?.();
  if (Number.isFinite(duration))
    timers.set(
      id,
      setTimeout(() => hide(id), duration),
    );
}

export function syncApplauseCelebration(game, applause, context) {
  const element = document.getElementById("celebration");
  if (!applause || applause.complete || !game) {
    if (element.dataset.applauseId) {
      const restoreFocus = element.contains(document.activeElement);
      hide("celebration");
      if (restoreFocus)
        document
          .querySelector(
            '#app [data-action="next"]:not(:disabled), #app [data-action="room-rematch"]:not(:disabled), #app [data-action="new"]:not(:disabled)',
          )
          ?.focus({ preventScroll: true });
    }
    return;
  }
  const player = game.players.find((p) => p.id === applause.playerId);
  if (!player) return;
  if (element.dataset.applauseId !== applause.id) {
    hide("celebration");
    element.dataset.applauseId = applause.id;
    element.classList.add("is-applause");
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-live", "off");
    element.setAttribute("aria-labelledby", "applause-title");
    element.innerHTML =
      '<div class="confetti" aria-hidden="true">' +
      "<i></i>".repeat(48) +
      '</div><div class="victory-burst flip-seven-burst"><div class="flip-seven-cards" aria-hidden="true">' +
      player.cards
        .filter((card) => card.kind === "number")
        .map((card) => `<span>${cardArtwork(cardArtKey(card))}</span>`)
        .join("") +
      '</div><span class="eyebrow">SEVEN CARDS. ONE GREAT MOMENT.</span><strong id="applause-title"></strong><div class="flip-seven-bonus">+15<span>额外奖励</span></div><p class="flip-seven-message"></p><div class="applause-panel"><button class="primary applause-button" data-action="applaud"></button><p class="applause-progress" role="status" aria-live="polite"></p><ul class="applause-players" aria-label="全桌鼓掌进度"></ul><p class="applause-hint"></p></div></div>';
    element.querySelector("#applause-title").textContent =
      `${player.name} 达成七连翻！`;
    const winner =
      game.phase === "finished" &&
      game.players.find((p) => p.id === game.winner);
    element.querySelector(".flip-seven-message").textContent = winner
      ? `${winner.name} 以 ${winner.score} 分赢下整局！`
      : "七张不同数字，本轮立即结算！";
    show("celebration");
    if (
      !document.querySelector("dialog[open]") &&
      !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)
    )
      element.querySelector(".applause-button").focus({ preventScroll: true });
  }
  // Keep the fan and entry animation intact as each person's acknowledgement arrives.
  const mine = applause.acknowledgedIds.includes(context.selfId);
  const button = element.querySelector(".applause-button");
  button.disabled = mine || !context.connected || context.busy;
  button.textContent = mine
    ? "👏 已鼓掌"
    : !context.connected
      ? "连接恢复后鼓掌"
      : context.busy
        ? "正在确认…"
        : "👏 为ta鼓掌";
  const done = applause.participants.filter((p) => p.applauded).length;
  const progress = element.querySelector(".applause-progress");
  const status = `已鼓掌 ${done} / ${applause.participants.length} · 等待全员鼓掌`;
  if (progress.textContent !== status) progress.textContent = status;
  element.querySelector(".applause-players").replaceChildren(
    ...applause.participants.map((p) => {
      const item = document.createElement("li");
      item.className = p.applauded ? "has-applauded" : "awaiting-applause";
      const offline =
        context.members?.find((m) => m.id === p.id)?.online === false;
      item.textContent = `${p.applauded ? "✓" : "○"} ${p.name}${p.id === context.selfId ? "（你）" : ""} · ${p.automatic ? "电脑鼓掌" : p.applauded ? "已鼓掌" : offline ? "离线待鼓掌" : "待鼓掌"}`;
      return item;
    }),
  );
  element.querySelector(".applause-hint").textContent = context.connected
    ? "全员鼓掌后一起收起。离线玩家重连后仍需确认。"
    : "正在重连，鼓掌进度会自动恢复。";
}
export function hideGameEffects() {
  honorStarts.clear();
  resumeScoreHonors();
  hide("shuffle-notice");
  hide("celebration");
}
export function showGameEffects(previous, next, applause = null) {
  if (!next) return hideGameEffects();
  if (!previous || next.revision < previous.revision) honorStarts.clear();
  if (
    previous &&
    previous.round !== next.round &&
    (!applause || applause.complete)
  )
    hide("celebration");
  const events = presentationEvents(previous, next);
  const shuffle = events.find((event) => event.type === "shuffle");
  if (shuffle) {
    hide("shuffle-notice");
    const element = document.getElementById("shuffle-notice");
    element.innerHTML =
      '<div class="shuffle-cards" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div><span class="eyebrow">SHUFFLE & GO</span><strong></strong><p></p></div>';
    element.querySelector("strong").textContent = shuffle.initial
      ? "洗好好运，准备开局！"
      : "重新洗牌！";
    element.querySelector("p").textContent = shuffle.initial
      ? "轮到你时，亲手翻开第一张。"
      : "弃牌洗回牌堆，桌面上的牌继续保留。";
    show("shuffle-notice", 2400);
  }
  const victory = events.find((event) => event.type === "victory");
  const flip = events.find((event) => event.type === "flip7");
  if (flip) honorStarts.set(flip.player.id, performance.now());
  resumeScoreHonors();
  if (victory && !applause) {
    hide("celebration");
    const element = document.getElementById("celebration");
    element.innerHTML =
      '<div class="confetti" aria-hidden="true">' +
      "<i></i>".repeat(48) +
      '</div><div class="victory-burst"><span class="victory-star" aria-hidden="true">✦</span><span class="eyebrow">WINNER TAKES THE GLORY</span><strong></strong><p></p></div>';
    element.querySelector("strong").textContent =
      `${victory.winner.name} 获胜！`;
    element.querySelector("p").textContent =
      `${victory.winner.score} 分 · 这一桌的好运之王`;
    show("celebration", 4200);
  }
}
