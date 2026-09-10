import { describe, expect, it } from 'vitest';
import { chooseBotAction } from '../src/engine/bot.js';
import { applyAction, createGame, gameView } from '../src/engine/game.js';
import {
  COLORS,
  TOKENS,
  emptyGems,
  emptyTokens,
  totalTokens,
  type Card,
} from '../src/shared/types.js';

function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
}
function setup(count = 2, seed = 1) {
  return createGame(
    Array.from({ length: count }, (_, i) => ({ id: `b${i}`, name: `AI ${i}` })),
    seeded(seed),
  );
}
const card = (id: string, points = 0): Card => ({
  id,
  points,
  tier: 1,
  bonus: 'white',
  cost: emptyGems(),
});
describe('offline AI strategy', () => {
  it.each([2, 3, 4])(
    'completes %i-player games while obeying every rule and conserving components',
    (count) => {
      for (let seed = 1; seed <= 12; seed++) {
        let game = setup(count, seed),
          steps = 0;
        while (game.phase !== 'finished' && steps++ < 1200) {
          const id = game.players[game.currentPlayer].id;
          const view = gameView(game, id),
            before = structuredClone(view);
          const action = chooseBotAction(view, id);
          expect(view).toEqual(before);
          game = applyAction(game, id, action);
          for (const color of TOKENS) {
            expect(
              game.bank[color] + game.players.reduce((sum, p) => sum + p.tokens[color], 0),
            ).toBe(color === 'gold' ? 5 : ({ 2: 4, 3: 5, 4: 7 } as Record<number, number>)[count]);
            expect(game.bank[color]).toBeGreaterThanOrEqual(0);
          }
          for (const [i, p] of game.players.entries()) {
            expect(p.reserved.length).toBeLessThanOrEqual(3);
            if (game.phase !== 'return' || i !== game.currentPlayer)
              expect(totalTokens(p.tokens)).toBeLessThanOrEqual(10);
          }
          const cards = [
            ...Object.values(game.market).flat().filter(Boolean),
            ...Object.values(game.decks).flat(),
            ...game.players.flatMap((p) => [...p.purchased, ...p.reserved]),
          ] as Card[];
          expect(cards.length).toBe(90);
          expect(new Set(cards.map((c) => c.id)).size).toBe(90);
        }
        expect(game.phase, `seed ${seed}, steps ${steps}`).toBe('finished');
      }
    },
  );
  it('chooses a winning purchase and handles required noble choices', () => {
    let game = setup();
    game.players[0].purchased = [card('owned', 14)];
    game.market[1][0] = card('win', 1);
    game.market[1][1] = card('cheap');
    const action = chooseBotAction(gameView(game, 'b0'), 'b0');
    expect(action).toMatchObject({ type: 'buy', cardId: 'win' });
    game.nobles = ['n1', 'n2'].map((id) => ({ id, points: 3, cost: { ...emptyGems(), white: 1 } }));
    game = applyAction(game, 'b0', action);
    expect(game.phase).toBe('noble');
    game = applyAction(game, 'b0', chooseBotAction(gameView(game, 'b0'), 'b0'));
    expect(game.players[0].nobles.length).toBe(1);
    expect(game.finalRound).toBe(true);
  });
  it('returns exactly the excess, preserving gold and never returning unowned tokens', () => {
    let game = setup();
    game.players[0].tokens = { white: 3, blue: 3, green: 3, red: 1, black: 1, gold: 1 };
    game.phase = 'return';
    const action = chooseBotAction(gameView(game, 'b0'), 'b0');
    expect(action.type).toBe('return');
    if (action.type !== 'return') throw new Error('wrong action');
    expect(totalTokens(action.tokens)).toBe(2);
    expect(action.tokens.gold).toBe(0);
    game = applyAction(game, 'b0', action);
    expect(totalTokens(game.players[0].tokens)).toBe(10);
  });
  it('can reserve when gems are exhausted, then passes only if no legal move remains', () => {
    let game = setup();
    for (const c of COLORS) game.bank[c] = 0;
    const action = chooseBotAction(gameView(game, 'b0'), 'b0');
    expect(['reserve', 'reserveDeck']).toContain(action.type);
    expect(() => applyAction(game, 'b0', action)).not.toThrow();
    game.players[0].reserved = game.decks[1].splice(0, 3);
    expect(chooseBotAction(gameView(game, 'b0'), 'b0')).toEqual({ type: 'pass' });
  });
  it('makes the same decision when hidden deck order and opponent reservations change', () => {
    const game = setup();
    game.players[1].reserved.push(game.decks[1].shift()!);
    const before = chooseBotAction(gameView(game, 'b0'), 'b0');
    game.decks[1].reverse();
    [game.players[1].reserved[0], game.decks[1][0]] = [
      game.decks[1][0],
      game.players[1].reserved[0],
    ];
    expect(chooseBotAction(gameView(game, 'b0'), 'b0')).toEqual(before);
    expect(() => chooseBotAction(gameView(game, 'b1'), 'b1')).toThrow();
  });
});
