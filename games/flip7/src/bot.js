import { numbers, hasSecond, roundPoints, canStay } from "./game.js";

// This function accepts only publicView, so it cannot peek at the next card.
export function chooseBotAction(view, actorId) {
  const self = view.players.find((p) => p.id === actorId);
  if (!self || view.actorId !== actorId) throw new Error("无效的电脑回合");
  if (view.pending) {
    const targets = view.players.filter((p) =>
      view.pending.targets.includes(p.id),
    );
    const kind = view.pending.card.kind;
    const value = (p) => {
      if (kind === "second") return -p.score;
      if (kind === "freeze")
        return p.id === actorId
          ? roundPoints(p) >= 24
            ? 100
            : -100
          : p.score + numbers(p).length * 14 - roundPoints(p);
      if (p.id === actorId)
        return hasSecond(p) || numbers(p).length <= 1 ? 160 : -100;
      return (
        numbers(p).reduce((sum, n) => sum + n, 0) * (hasSecond(p) ? 0.2 : 1) +
        p.score * 0.1
      );
    };
    targets.sort((a, b) => value(b) - value(a));
    return { type: "target", targetId: targets[0].id };
  }
  if (view.opening) return { type: "hit" };
  const points = roundPoints(self);
  const threshold = { careful: 21, balanced: 28, bold: 36 }[self.style] ?? 28;
  const lead = Math.max(
    ...view.players
      .filter((p) => p.id !== actorId)
      .map((p) => p.score + roundPoints(p)),
  );
  if (!canStay(self)) return { type: "hit" };
  if (self.score + points >= 200 && self.score + points > lead)
    return { type: "stay" };
  if (lead >= 200 && self.score + points <= lead) return { type: "hit" };
  if (hasSecond(self) && numbers(self).length < 6) return { type: "hit" };
  return {
    type:
      points >= threshold ||
      numbers(self).length >= (self.style === "bold" ? 6 : 5)
        ? "stay"
        : "hit",
  };
}
