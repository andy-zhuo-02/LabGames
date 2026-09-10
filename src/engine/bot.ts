import {
  COLORS,
  TOKENS,
  bonuses,
  canAfford,
  emptyTokens,
  price,
  score,
  suggestedPayment,
  totalTokens,
  type Action,
  type Card,
  type Color,
  type GameView,
  type PlayerView,
  type Tokens,
} from '../shared/types.js';

const present = (card: Card | null): card is Card => card !== null;
const cardsFor = (game: GameView, player: PlayerView) => [
  ...Object.values(game.market).flat().filter(present),
  ...player.reserved.filter(present),
];
function deficit(player: PlayerView, card: Card): number {
  const cost = price(player, card);
  return Math.max(
    0,
    COLORS.reduce((sum, c) => sum + Math.max(0, cost[c] - player.tokens[c]), 0) -
      player.tokens.gold,
  );
}
function value(game: GameView, player: PlayerView, card: Card): number {
  const discount = bonuses(player);
  const nobleProgress = game.nobles.reduce(
    (sum, n) => sum + (discount[card.bonus] < n.cost[card.bonus] ? 0.2 : 0),
    0,
  );
  const nobleNow = game.nobles.some((n) =>
    COLORS.every((c) => discount[c] + (c === card.bonus ? 1 : 0) >= n.cost[c]),
  );
  const points = card.points + (nobleNow ? 3 : 0);
  return (
    points * 2.5 +
    nobleProgress +
    1 / (1 + discount[card.bonus]) +
    (score(player) + points >= 15 ? 100 : 0)
  );
}
function targetCard(game: GameView, player: PlayerView): Card | undefined {
  // A token target must fit in the ten-token hand after discounts.
  return cardsFor(game, player)
    .filter((card) => Object.values(price(player, card)).reduce((a, b) => a + b, 0) <= 10)
    .sort(
      (a, b) =>
        deficit(player, a) -
          value(game, player, a) * 0.12 -
          (deficit(player, b) - value(game, player, b) * 0.12) || a.id.localeCompare(b.id),
    )[0];
}
function returnsFor(player: PlayerView, target: Card | undefined): Tokens {
  const returned = emptyTokens(),
    cost = target ? price(player, target) : emptyTokens();
  let excess = totalTokens(player.tokens) - 10;
  while (excess-- > 0) {
    // Keep useful colors and flexible gold; discard surplus colors first.
    const color = [...TOKENS]
      .filter((c) => player.tokens[c] > returned[c])
      .sort(
        (a, b) =>
          player.tokens[b] -
          returned[b] -
          (b === 'gold' ? 20 : cost[b]) -
          (player.tokens[a] - returned[a] - (a === 'gold' ? 20 : cost[a])),
      )[0];
    returned[color]++;
  }
  return returned;
}
function legalTakes(game: GameView): Color[][] {
  const available = COLORS.filter((c) => game.bank[c] > 0),
    count = Math.min(3, available.length);
  const takes: Color[][] = [];
  function combinations(from: number, selected: Color[]) {
    if (selected.length === count) {
      if (count) takes.push(selected);
      return;
    }
    for (let i = from; i < available.length; i++) combinations(i + 1, [...selected, available[i]]);
  }
  combinations(0, []);
  for (const color of available) if (game.bank[color] >= 4) takes.push([color, color]);
  return takes;
}
/** Offline heuristic opponent. Its ONLY input is the same filtered view sent to a player. */
export function chooseBotAction(game: GameView, playerId: string): Action {
  const player = game.players[game.currentPlayer];
  if (game.phase === 'finished' || player.id !== playerId)
    throw new Error('AI can only act on its own unfinished turn');
  const discount = bonuses(player);
  if (game.phase === 'noble') {
    const eligible = game.nobles.filter((n) => COLORS.every((c) => discount[c] >= n.cost[c]));
    if (!eligible.length) throw new Error('No eligible noble in noble phase');
    return { type: 'noble', nobleId: eligible[0].id };
  }
  const target = targetCard(game, player);
  if (game.phase === 'return') return { type: 'return', tokens: returnsFor(player, target) };
  const affordable = cardsFor(game, player)
    .filter((card) => canAfford(player, card))
    .sort((a, b) => value(game, player, b) - value(game, player, a) || a.id.localeCompare(b.id));
  if (affordable.length)
    return {
      type: 'buy',
      cardId: affordable[0].id,
      payment: suggestedPayment(player, affordable[0]),
    };

  const takes = legalTakes(game)
    .map((colors) => {
      const next: PlayerView = { ...player, tokens: { ...player.tokens } };
      for (const color of colors) next.tokens[color]++;
      const returned = returnsFor(next, target);
      for (const color of TOKENS) next.tokens[color] -= returned[color];
      const progress = target ? deficit(player, target) - deficit(next, target) : 0;
      return {
        colors,
        utility: progress * 10 + (totalTokens(next.tokens) - totalTokens(player.tokens)) * 0.1,
      };
    })
    .sort((a, b) => b.utility - a.utility);

  // Reserve a useful market target when ordinary gems cannot advance it.
  const market = Object.values(game.market).flat().filter(present);
  if (
    player.reserved.length < 3 &&
    game.bank.gold > 0 &&
    target &&
    market.some((c) => c.id === target.id) &&
    (!takes.length || takes[0].utility <= 0)
  )
    return { type: 'reserve', cardId: target.id };
  if (takes.length) return { type: 'take', colors: takes[0].colors };
  if (player.reserved.length < 3) {
    if (market.length)
      return {
        type: 'reserve',
        cardId: ((target && market.find((c) => c.id === target.id)) || market[0]).id,
      };
    for (const tier of [1, 2, 3] as const)
      if (game.deckCounts[tier]) return { type: 'reserveDeck', tier };
  }
  return { type: 'pass' };
}
