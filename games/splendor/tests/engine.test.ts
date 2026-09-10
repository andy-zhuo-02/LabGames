import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CARDS, NOBLES } from '../src/engine/data.js';
import { applyAction, createGame, gameView, eligibleNobles, canPass } from '../src/engine/game.js';
import {
  COLORS,
  TOKENS,
  emptyGems,
  emptyTokens,
  totalTokens,
  score,
  canAfford,
  suggestedPayment,
  price,
  type Game,
  type Card,
  type Tokens,
} from '../src/shared/types.js';
import { actionSchema } from '../src/shared/protocol.js';

export function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
}
function setup(count = 2, seed = 123) {
  return createGame(
    Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `商人${i}` })),
    seeded(seed),
  );
}
function mockCard(
  id: string,
  bonus: Card['bonus'] = 'white',
  points = 0,
  cost = emptyGems(),
): Card {
  return { id, bonus, points, cost, tier: 1 };
}
function distribute(game: Game, player: number, tokens: Partial<Tokens>) {
  for (const color of TOKENS) {
    const count = tokens[color] ?? 0;
    game.players[player].tokens[color] += count;
    game.bank[color] -= count;
  }
}
function checkConservation(game: Game, count: number) {
  for (const color of TOKENS) {
    const values = [game.bank[color], ...game.players.map((p) => p.tokens[color])];
    expect(values.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
    expect(values.reduce((a, b) => a + b, 0)).toBe(
      color === 'gold' ? 5 : ({ 2: 4, 3: 5, 4: 7 } as Record<number, number>)[count],
    );
  }
  const cards = [
    ...Object.values(game.decks).flat(),
    ...Object.values(game.market)
      .flat()
      .filter((c): c is Card => !!c),
    ...game.players.flatMap((p) => [...p.purchased, ...p.reserved]),
  ];
  expect(cards.length).toBe(90);
  expect(new Set(cards.map((c) => c.id)).size).toBe(90);
  expect(game.players.every((p) => p.reserved.length <= 3)).toBe(true);
  for (const [index, player] of game.players.entries()) {
    if (game.phase !== 'return' || index !== game.currentPlayer)
      expect(totalTokens(player.tokens)).toBeLessThanOrEqual(10);
  }
  expect(
    new Set([...game.nobles, ...game.players.flatMap((p) => p.nobles)].map((n) => n.id)).size,
  ).toBe(count + 1);
}
describe('base-game data and setup', () => {
  it('has 90 unique cards split 40/30/20, and 10 nobles', () => {
    expect(CARDS.length).toBe(90);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(90);
    expect([1, 2, 3].map((t) => CARDS.filter((c) => c.tier === t).length)).toEqual([40, 30, 20]);
    expect(NOBLES.length).toBe(10);
    expect(new Set(NOBLES.map((n) => JSON.stringify(n.cost))).size).toBe(10);
    expect(NOBLES.filter((n) => Object.values(n.cost).filter(Boolean).length === 2).length).toBe(5);
    expect(NOBLES.filter((n) => Object.values(n.cost).filter(Boolean).length === 3).length).toBe(5);
    expect(CARDS.find((c) => c.id === 'c08')).toMatchObject({
      tier: 1,
      bonus: 'black',
      points: 1,
      cost: { blue: 4 },
    });
    expect(NOBLES.some((n) => n.cost.white === 3 && n.cost.red === 3 && n.cost.black === 3)).toBe(
      true,
    );
  });
  it.each([2, 3, 4])('sets up %i players and conserves all components', (count) => {
    const game = setup(count);
    expect(game.nobles.length).toBe(count + 1);
    expect(Object.values(game.market).every((cards) => cards.length === 4)).toBe(true);
    checkConservation(game, count);
  });
  it('reproduces the same shuffle with the same injected random source', () =>
    expect(setup(2, 10)).toEqual(setup(2, 10)));
  it('rejects unsupported player counts and repeated identities', () => {
    expect(() => setup(1)).toThrow();
    expect(() => setup(5)).toThrow();
    expect(() =>
      createGame([
        { id: 'x', name: 'a' },
        { id: 'x', name: 'b' },
      ]),
    ).toThrow();
  });
});
describe('actions and multi-step turns', () => {
  it('takes three different colors atomically, rejecting partial selections', () => {
    const state = setup(),
      before = structuredClone(state);
    expect(() => applyAction(state, 'p0', { type: 'take', colors: ['red', 'green'] })).toThrow();
    expect(state).toEqual(before);
    const next = applyAction(state, 'p0', { type: 'take', colors: ['red', 'green', 'blue'] });
    expect(next.players[0].tokens.red).toBe(1);
    expect(next.currentPlayer).toBe(1);
    checkConservation(next, 2);
  });
  it('allows two of a color only when at least four are available', () => {
    const state = setup();
    const next = applyAction(state, 'p0', { type: 'take', colors: ['red', 'red'] });
    expect(next.bank.red).toBe(2);
    expect(() => applyAction(next, 'p1', { type: 'take', colors: ['red', 'red'] })).toThrow(
      '至少需要 4',
    );
  });
  it('takes fewer colors only when fewer colors are available', () => {
    const state = setup();
    state.bank.white = state.bank.blue = state.bank.black = 0;
    expect(applyAction(state, 'p0', { type: 'take', colors: ['red', 'green'] }).currentPlayer).toBe(
      1,
    );
    expect(() => applyAction(state, 'p0', { type: 'take', colors: ['red'] })).toThrow();
  });
  it('keeps the turn pending until exactly the excess tokens are returned', () => {
    const state = setup();
    distribute(state, 0, { white: 2, blue: 2, green: 2, red: 1, black: 2 });
    const next = applyAction(state, 'p0', { type: 'take', colors: ['white', 'green', 'red'] });
    expect(next.phase).toBe('return');
    expect(next.currentPlayer).toBe(0);
    expect(() =>
      applyAction(next, 'p1', { type: 'take', colors: ['blue', 'red', 'black'] }),
    ).toThrow();
    expect(() =>
      applyAction(next, 'p0', { type: 'return', tokens: { ...emptyTokens(), red: 1 } }),
    ).toThrow();
    const final = applyAction(next, 'p0', { type: 'return', tokens: { ...emptyTokens(), red: 2 } });
    expect(final.phase).toBe('action');
    expect(final.currentPlayer).toBe(1);
    checkConservation(final, 2);
  });
  it('allows returning newly taken tokens, including reservation gold', () => {
    const state = setup();
    distribute(state, 0, { white: 2, blue: 2, green: 2, red: 2, black: 2 });
    const next = applyAction(state, 'p0', { type: 'reserveDeck', tier: 1 });
    expect(next.phase).toBe('return');
    const final = applyAction(next, 'p0', {
      type: 'return',
      tokens: { ...emptyTokens(), gold: 1 },
    });
    expect(final.bank.gold).toBe(5);
    expect(final.currentPlayer).toBe(1);
    checkConservation(final, 2);
  });
  it('reserves market cards, refills their slot, and works without gold', () => {
    const state = setup(),
      target = state.market[1][1]!,
      replacement = state.decks[1][0];
    state.bank.gold = 0;
    const next = applyAction(state, 'p0', { type: 'reserve', cardId: target.id });
    expect(next.market[1][1]).toEqual(replacement);
    expect(next.players[0].reserved).toEqual([target]);
    expect(next.players[0].tokens.gold).toBe(0);
  });
  it('enforces three reservation slots and handles exhausted decks', () => {
    const state = setup();
    state.players[0].reserved = state.decks[1].splice(0, 3);
    expect(() => applyAction(state, 'p0', { type: 'reserveDeck', tier: 2 })).toThrow('最多预留');
    state.players[0].reserved = [];
    state.decks[1] = [];
    expect(() => applyAction(state, 'p0', { type: 'reserveDeck', tier: 1 })).toThrow('已空');
    const next = applyAction(state, 'p0', { type: 'reserve', cardId: state.market[1][0]!.id });
    expect(next.market[1][0]).toBeNull();
  });
  it('pays with gold voluntarily even when matching gems are held', () => {
    const state = setup(),
      card = mockCard('target', 'green', 1, { ...emptyGems(), red: 2 });
    state.market[1][0] = card;
    distribute(state, 0, { red: 2, gold: 2 });
    const next = applyAction(state, 'p0', {
      type: 'buy',
      cardId: card.id,
      payment: { ...emptyTokens(), gold: 2 },
    });
    expect(next.players[0].tokens.red).toBe(2);
    expect(next.players[0].tokens.gold).toBe(0);
    expect(score(next.players[0])).toBe(1);
  });
  it('applies discounts and supports purchasing reserved cards for free', () => {
    const state = setup();
    state.players[0].purchased = [mockCard('owned', 'red')];
    state.players[0].reserved = [mockCard('target', 'blue', 0, { ...emptyGems(), red: 1 })];
    const deckCount = state.decks[1].length;
    const next = applyAction(state, 'p0', {
      type: 'buy',
      cardId: 'target',
      payment: emptyTokens(),
    });
    expect(next.players[0].purchased.length).toBe(2);
    expect(next.players[0].reserved.length).toBe(0);
    expect(next.decks[1].length).toBe(deckCount);
  });
  it('rejects overpay, negative values, missing gold and out-of-turn commands without mutations', () => {
    const state = setup();
    state.market[1][0] = mockCard('target', 'green', 0, { ...emptyGems(), red: 1 });
    distribute(state, 0, { red: 2 });
    const before = JSON.stringify(state);
    for (const payment of [
      { ...emptyTokens(), red: 2 },
      { ...emptyTokens(), gold: -1 },
      emptyTokens(),
    ]) {
      expect(() => applyAction(state, 'p0', { type: 'buy', cardId: 'target', payment })).toThrow();
      expect(JSON.stringify(state)).toBe(before);
    }
    expect(() => applyAction(state, 'p1', { type: 'reserveDeck', tier: 1 })).toThrow('等待');
    expect(
      actionSchema.safeParse({ type: 'return', tokens: { ...emptyTokens(), red: -2 } }).success,
    ).toBe(false);
    expect(actionSchema.safeParse({ type: 'take', colors: ['gold'] }).success).toBe(false);
  });
});
describe('nobles, scoring, hidden information', () => {
  it('automatically awards exactly one eligible noble', () => {
    const state = setup();
    state.nobles = [{ id: 'n1', points: 3, cost: { ...emptyGems(), white: 1 } }];
    state.market[1][0] = mockCard('target');
    const next = applyAction(state, 'p0', {
      type: 'buy',
      cardId: 'target',
      payment: emptyTokens(),
    });
    expect(next.players[0].nobles.length).toBe(1);
    expect(score(next.players[0])).toBe(3);
    expect(next.currentPlayer).toBe(1);
  });
  it('waits for a choice when multiple nobles qualify, awarding only the chosen one', () => {
    const state = setup();
    state.nobles = [1, 2].map((i) => ({
      id: `n${i}`,
      points: 3,
      cost: { ...emptyGems(), white: 1 },
    }));
    state.market[1][0] = mockCard('target');
    const pending = applyAction(state, 'p0', {
      type: 'buy',
      cardId: 'target',
      payment: emptyTokens(),
    });
    expect(pending.phase).toBe('noble');
    expect(pending.currentPlayer).toBe(0);
    expect(() => applyAction(pending, 'p0', { type: 'noble', nobleId: 'missing' })).toThrow();
    const next = applyAction(pending, 'p0', { type: 'noble', nobleId: 'n2' });
    expect(next.players[0].nobles[0].id).toBe('n2');
    expect(next.nobles.length).toBe(1);
    expect(next.currentPlayer).toBe(1);
  });
  it('finishes the current round, then breaks ties by purchased-card count', () => {
    let state = setup(3);
    state.players[0].purchased = [mockCard('a', 'red', 15), mockCard('b')];
    state.players[1].purchased = [mockCard('c', 'red', 15)];
    state = applyAction(state, 'p0', { type: 'reserveDeck', tier: 1 });
    expect(state.finalRound).toBe(true);
    expect(state.phase).not.toBe('finished');
    state = applyAction(state, 'p1', { type: 'reserveDeck', tier: 1 });
    expect(state.phase).not.toBe('finished');
    state = applyAction(state, 'p2', { type: 'reserveDeck', tier: 1 });
    expect(state.phase).toBe('finished');
    expect(state.winners).toEqual(['p1']);
    expect(() => applyAction(state, 'p2', { type: 'reserveDeck', tier: 1 })).toThrow('结束');
  });
  it('includes noble points in the trigger and supports shared victory', () => {
    let state = setup();
    state.players[0].purchased = [mockCard('a', 'white', 12)];
    state.players[1].purchased = [mockCard('b', 'blue', 15)];
    state.nobles = [{ id: 'n1', points: 3, cost: { ...emptyGems(), white: 1 } }];
    state = applyAction(state, 'p0', { type: 'reserveDeck', tier: 1 });
    expect(state.finalRound).toBe(true);
    state = applyAction(state, 'p1', { type: 'reserveDeck', tier: 1 });
    expect(state.winners).toEqual(['p0', 'p1']);
  });
  it('never exposes deck contents or opponents reserved cards, even at game end', () => {
    const state = applyAction(setup(), 'p0', { type: 'reserveDeck', tier: 3 });
    const own = gameView(state, 'p0'),
      other = gameView(state, 'p1');
    expect(own.players[0].reserved[0]?.id).toBe(state.players[0].reserved[0].id);
    expect(other.players[0].reserved).toEqual([null]);
    expect('decks' in other).toBe(false);
    const hiddenIds = [...state.decks[3], ...state.players[0].reserved].map((c) => c.id);
    expect(hiddenIds.some((id) => JSON.stringify(other).includes(`"${id}"`))).toBe(false);
    own.bank.red = 999;
    expect(state.bank.red).not.toBe(999);
  });
  it('only permits passing when all normal actions are unavailable', () => {
    const state = setup();
    expect(canPass(state, state.players[0])).toBe(false);
    expect(() => applyAction(state, 'p0', { type: 'pass' })).toThrow();
    for (const c of COLORS) state.bank[c] = 0;
    state.players[0].reserved = state.decks[1].splice(0, 3);
    expect(canPass(state, state.players[0])).toBe(true);
    expect(applyAction(state, 'p0', { type: 'pass' }).currentPlayer).toBe(1);
  });
});
describe('complete 2, 3 and 4 player simulations', () => {
  it.each([2, 3, 4])(
    'plays several %i-player games to completion with conservation checks',
    (count) => {
      for (const seed of [42, 79, 203]) {
        let state = setup(count, seed),
          steps = 0;
        while (state.phase !== 'finished' && steps++ < 900) {
          const p = state.players[state.currentPlayer];
          if (state.phase === 'noble') {
            state = applyAction(state, p.id, {
              type: 'noble',
              nobleId: eligibleNobles(state, p)[0].id,
            });
          } else if (state.phase === 'return') {
            const returns = emptyTokens();
            let excess = totalTokens(p.tokens) - 10;
            const availableCards = Object.values(state.market)
              .flat()
              .filter((c): c is Card => !!c);
            const target = availableCards.sort((a, b) => distance(p, a) - distance(p, b))[0];
            const costs = target ? price(p, target) : emptyGems();
            while (excess-- > 0) {
              const c = [...TOKENS]
                .filter((c) => p.tokens[c] > returns[c])
                .sort(
                  (a, b) =>
                    p.tokens[b] -
                    returns[b] -
                    (b === 'gold' ? 20 : costs[b]) -
                    (p.tokens[a] - returns[a] - (a === 'gold' ? 20 : costs[a])),
                )[0];
              returns[c]++;
            }
            state = applyAction(state, p.id, { type: 'return', tokens: returns });
          } else {
            const market = Object.values(state.market)
              .flat()
              .filter((c): c is Card => !!c);
            const affordable = [...market, ...p.reserved]
              .filter((c) => canAfford(p, c))
              .sort((a, b) => b.points - a.points);
            if (affordable.length)
              state = applyAction(state, p.id, {
                type: 'buy',
                cardId: affordable[0].id,
                payment: suggestedPayment(p, affordable[0]),
              });
            else {
              const target = [...market, ...p.reserved].sort(
                (a, b) => distance(p, a) - distance(p, b),
              )[0];
              const costs = target ? price(p, target) : emptyGems();
              const colors = [...COLORS]
                .filter((c) => state.bank[c] > 0)
                .sort((a, b) => costs[b] - p.tokens[b] - (costs[a] - p.tokens[a]));
              if (colors.length) {
                const best = colors[0];
                const take =
                  state.bank[best] >= 4 && costs[best] - p.tokens[best] >= 2
                    ? [best, best]
                    : colors.slice(0, 3);
                state = applyAction(state, p.id, { type: 'take', colors: take });
              } else if (p.reserved.length < 3 && target)
                state = applyAction(state, p.id, { type: 'reserve', cardId: target.id });
              else state = applyAction(state, p.id, { type: 'pass' });
            }
          }
          checkConservation(state, count);
        }
        expect(state.phase, `seed ${seed}, ${steps} transitions`).toBe('finished');
        expect(state.winners.length).toBeGreaterThan(0);
      }
    },
  );
});
function distance(p: Game['players'][number], card: Card) {
  const cost = price(p, card);
  return (
    Math.max(
      0,
      COLORS.reduce((sum, c) => sum + Math.max(0, cost[c] - p.tokens[c]), 0) - p.tokens.gold,
    ) -
    card.points * 0.25
  );
}
