import { makeDeck, cardLabel } from "./game.js";

const key = (card) => `${card.kind}:${card.value ?? ""}`;
const catalog = new Map();
for (const card of makeDeck()) {
  const entry = catalog.get(key(card));
  if (entry) entry.total++;
  else
    catalog.set(key(card), {
      kind: card.kind,
      ...(card.value === undefined ? {} : { value: card.value }),
      label: cardLabel(card),
      total: 1,
    });
}

// All drawn cards are public. Aggregate the current pile rather than replaying the
// bounded event log, so discards, pending effects and reshuffles stay accurate.
// No card IDs, pile order or RNG state are included in this optional snapshot.
export function cardTracker(state) {
  const counts = new Map();
  for (const card of state.deck)
    counts.set(key(card), (counts.get(key(card)) || 0) + 1);
  return {
    remaining: state.deck.length,
    outside: 94 - state.deck.length,
    cards: [...catalog].map(([id, entry]) => ({
      ...entry,
      remaining: counts.get(id) || 0,
    })),
  };
}
