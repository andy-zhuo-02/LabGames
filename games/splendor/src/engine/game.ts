import { CARDS, NOBLES } from './data.js';
import {
  COLORS,
  TOKENS,
  COLOR_NAMES,
  bonuses,
  score,
  price,
  totalTokens,
  emptyTokens,
  canAfford,
  type Game,
  type Player,
  type Action,
  type Tier,
  type Card,
  type Tokens,
  type GameView,
} from '../shared/types.js';

export class RuleError extends Error {}
const requireRule: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new RuleError(message);
};
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = structuredClone(items) as T[];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
export function createGame(
  seats: { id: string; name: string }[],
  random: () => number = Math.random,
): Game {
  requireRule(seats.length >= 2 && seats.length <= 4, '需要 2～4 位玩家');
  requireRule(new Set(seats.map((s) => s.id)).size === seats.length, '玩家身份重复');
  const decks = {} as Record<Tier, Card[]>;
  const market = {} as Game['market'];
  for (const tier of [1, 2, 3] as const) {
    decks[tier] = shuffle(
      CARDS.filter((c) => c.tier === tier),
      random,
    );
    market[tier] = decks[tier].splice(0, 4);
  }
  const bank = emptyTokens();
  for (const color of COLORS)
    bank[color] = ({ 2: 4, 3: 5, 4: 7 } as Record<number, number>)[seats.length];
  bank.gold = 5;
  return {
    players: seats.map((s) => ({
      ...s,
      tokens: emptyTokens(),
      purchased: [],
      reserved: [],
      nobles: [],
    })),
    bank,
    decks,
    market,
    nobles: shuffle(NOBLES, random).slice(0, seats.length + 1),
    currentPlayer: 0,
    round: 1,
    phase: 'action',
    finalRound: false,
    winners: [],
    logSequence: 1,
    log: [{ id: 1, text: `对局开始，由 ${seats[0].name} 先手` }],
  };
}
function log(game: Game, text: string) {
  game.log.push({ id: ++game.logSequence, text });
  if (game.log.length > 100) game.log.shift();
}
export function eligibleNobles(game: Pick<Game, 'nobles'>, player: Pick<Player, 'purchased'>) {
  const discount = bonuses(player);
  return game.nobles.filter((n) => COLORS.every((c) => discount[c] >= n.cost[c]));
}
function finishTurn(game: Game) {
  const player = game.players[game.currentPlayer];
  if (score(player) >= 15 && !game.finalRound) {
    game.finalRound = true;
    log(game, `${player.name} 达到 15 分，完成本轮后结算`);
  }
  if (game.finalRound && game.currentPlayer === game.players.length - 1) {
    game.phase = 'finished';
    const highest = Math.max(...game.players.map(score));
    const tied = game.players.filter((p) => score(p) === highest);
    const fewest = Math.min(...tied.map((p) => p.purchased.length));
    game.winners = tied.filter((p) => p.purchased.length === fewest).map((p) => p.id);
    log(
      game,
      `对局结束，${game.players
        .filter((p) => game.winners.includes(p.id))
        .map((p) => p.name)
        .join('、')} 获胜`,
    );
    return;
  }
  game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
  if (game.currentPlayer === 0) game.round++;
  game.phase = 'action';
}
function awardNoble(game: Game, player: Player, id: string) {
  const index = game.nobles.findIndex((n) => n.id === id);
  player.nobles.push(game.nobles.splice(index, 1)[0]);
  log(game, `${player.name} 获得贵族的青睐，声望 +3`);
}
function afterAction(game: Game) {
  const player = game.players[game.currentPlayer];
  if (totalTokens(player.tokens) > 10) {
    game.phase = 'return';
    return;
  }
  const eligible = eligibleNobles(game, player);
  if (eligible.length > 1) {
    game.phase = 'noble';
    return;
  }
  if (eligible.length === 1) awardNoble(game, player, eligible[0].id);
  finishTurn(game);
}
function takeMarketCard(game: Game, id: string): Card {
  for (const tier of [1, 2, 3] as const) {
    const index = game.market[tier].findIndex((c) => c?.id === id);
    if (index !== -1) {
      const card = game.market[tier][index]!;
      game.market[tier][index] = game.decks[tier].shift() ?? null;
      return card;
    }
  }
  throw new RuleError('这张卡牌已不在市场中');
}
function validateAmounts(amounts: Tokens) {
  requireRule(
    amounts && TOKENS.every((c) => Number.isInteger(amounts[c]) && amounts[c] >= 0),
    '宝石数量必须是非负整数',
  );
}
export function canPass(
  game: Pick<GameView, 'bank' | 'market' | 'deckCounts'> | Game,
  player: Player | GameView['players'][number],
): boolean {
  if (COLORS.some((c) => game.bank[c] > 0)) return false;
  const market = Object.values(game.market)
    .flat()
    .filter((c): c is Card => c !== null);
  const reserved = (player.reserved as (Card | null)[]).filter((c): c is Card => c !== null);
  if ([...market, ...reserved].some((c) => canAfford(player, c))) return false;
  const deckAvailable =
    'decks' in game
      ? Object.values(game.decks).some((d) => d.length > 0)
      : Object.values(game.deckCounts).some((n) => n > 0);
  return player.reserved.length >= 3 || (!market.length && !deckAvailable);
}
/** Pure transition: failed commands never partially mutate the saved game. */
export function applyAction(state: Game, playerId: string, action: Action): Game {
  requireRule(state.phase !== 'finished', '这局游戏已经结束');
  requireRule(state.players[state.currentPlayer].id === playerId, '请等待你的回合');
  const game = structuredClone(state),
    player = game.players[game.currentPlayer];
  if (game.phase === 'return') {
    requireRule(action.type === 'return', '请先归还多余的宝石');
    validateAmounts(action.tokens);
    requireRule(
      totalTokens(action.tokens) === totalTokens(player.tokens) - 10,
      '请归还恰好超出上限的宝石',
    );
    requireRule(
      TOKENS.every((c) => action.tokens[c] <= player.tokens[c]),
      '你没有足够的宝石可归还',
    );
    for (const color of TOKENS) {
      player.tokens[color] -= action.tokens[color];
      game.bank[color] += action.tokens[color];
    }
    log(
      game,
      `${player.name} 归还了 ${TOKENS.filter((c) => action.tokens[c])
        .map((c) => `${action.tokens[c]} 枚${COLOR_NAMES[c]}`)
        .join('、')}`,
    );
    afterAction(game);
    return game;
  }
  if (game.phase === 'noble') {
    requireRule(action.type === 'noble', '请先选择一位贵族');
    requireRule(
      eligibleNobles(game, player).some((n) => n.id === action.nobleId),
      '尚未满足这位贵族的条件',
    );
    awardNoble(game, player, action.nobleId);
    finishTurn(game);
    return game;
  }
  switch (action.type) {
    case 'take': {
      requireRule(
        action.colors.every((c) => COLORS.includes(c)),
        '只能拿取普通宝石',
      );
      const distinct = new Set(action.colors);
      const isDouble = action.colors.length === 2 && distinct.size === 1;
      if (isDouble)
        requireRule(game.bank[action.colors[0]] >= 4, '拿两枚同色宝石时，该色库存至少需要 4 枚');
      else {
        const available = COLORS.filter((c) => game.bank[c] > 0).length;
        requireRule(
          distinct.size === action.colors.length &&
            action.colors.length === Math.min(3, available) &&
            available > 0,
          '请选择三种不同宝石；不足三种时拿取所有可用颜色',
        );
        requireRule(
          action.colors.every((c) => game.bank[c] > 0),
          '所选宝石库存不足',
        );
      }
      for (const color of action.colors) {
        game.bank[color]--;
        player.tokens[color]++;
      }
      log(game, `${player.name} 拿取了${action.colors.map((c) => COLOR_NAMES[c]).join('、')}`);
      break;
    }
    case 'reserve':
    case 'reserveDeck': {
      requireRule(player.reserved.length < 3, '最多预留 3 张卡牌');
      let card: Card;
      if (action.type === 'reserve') card = takeMarketCard(game, action.cardId);
      else {
        requireRule(
          [1, 2, 3].includes(action.tier) && game.decks[action.tier].length > 0,
          '这个等级的牌堆已空',
        );
        card = game.decks[action.tier].shift()!;
      }
      player.reserved.push(card);
      const gold = game.bank.gold > 0;
      if (gold) {
        game.bank.gold--;
        player.tokens.gold++;
      }
      log(
        game,
        `${player.name} 预留了一张 ${card.tier} 级${action.type === 'reserveDeck' ? '牌堆顶牌' : '市场卡牌'}${gold ? '，获得 1 枚黄金' : ''}`,
      );
      break;
    }
    case 'buy': {
      const reservedIndex = player.reserved.findIndex((c) => c.id === action.cardId);
      const card =
        reservedIndex >= 0
          ? player.reserved[reservedIndex]
          : Object.values(game.market)
              .flat()
              .find((c) => c?.id === action.cardId);
      requireRule(card, '这张卡牌无法购买');
      validateAmounts(action.payment);
      const cost = price(player, card);
      requireRule(
        TOKENS.every((c) => action.payment[c] <= player.tokens[c]),
        '持有的宝石不足',
      );
      requireRule(
        COLORS.every((c) => action.payment[c] <= cost[c]),
        '支付的宝石超过所需费用',
      );
      const goldNeeded = COLORS.reduce((sum, c) => sum + cost[c] - action.payment[c], 0);
      requireRule(action.payment.gold === goldNeeded, '黄金数量与剩余费用不一致');
      for (const color of TOKENS) {
        player.tokens[color] -= action.payment[color];
        game.bank[color] += action.payment[color];
      }
      if (reservedIndex >= 0) player.reserved.splice(reservedIndex, 1);
      else takeMarketCard(game, card.id);
      player.purchased.push(card);
      log(
        game,
        `${player.name} 购买了${COLOR_NAMES[card.bonus]}卡牌${card.points ? `，声望 +${card.points}` : ''}`,
      );
      break;
    }
    case 'pass':
      requireRule(canPass(game, player), '仍有可执行的行动，不能跳过回合');
      log(game, `${player.name} 无可执行行动，跳过回合`);
      break;
    default:
      throw new RuleError('当前不能执行此操作');
  }
  afterAction(game);
  return game;
}
/** Build a fresh allow-listed projection; never serialize server state directly. */
export function gameView(game: Game, selfId: string): GameView {
  return structuredClone({
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      tokens: p.tokens,
      purchased: p.purchased,
      nobles: p.nobles,
      reserved: p.reserved.map((c) => (p.id === selfId ? c : null)),
    })),
    bank: game.bank,
    market: game.market,
    nobles: game.nobles,
    deckCounts: { 1: game.decks[1].length, 2: game.decks[2].length, 3: game.decks[3].length },
    currentPlayer: game.currentPlayer,
    round: game.round,
    phase: game.phase,
    finalRound: game.finalRound,
    winners: game.winners,
    log: game.log,
    logSequence: game.logSequence,
  });
}
