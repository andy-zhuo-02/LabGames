export const COLORS = ['white', 'blue', 'green', 'red', 'black'] as const;
export type Color = (typeof COLORS)[number];
export type Token = Color | 'gold';
export const TOKENS: readonly Token[] = [...COLORS, 'gold'];
export const COLOR_NAMES: Record<Token, string> = {
  white: '钻石',
  blue: '蓝宝石',
  green: '祖母绿',
  red: '红宝石',
  black: '缟玛瑙',
  gold: '黄金',
};
export type Gems = Record<Color, number>;
export type Tokens = Record<Token, number>;
export type Tier = 1 | 2 | 3;
export interface Card {
  id: string;
  tier: Tier;
  bonus: Color;
  points: number;
  cost: Gems;
}
export interface Noble {
  id: string;
  points: number;
  cost: Gems;
}
export interface Player {
  id: string;
  name: string;
  tokens: Tokens;
  purchased: Card[];
  reserved: Card[];
  nobles: Noble[];
}
export interface Game {
  players: Player[];
  bank: Tokens;
  decks: Record<Tier, Card[]>;
  market: Record<Tier, (Card | null)[]>;
  nobles: Noble[];
  currentPlayer: number;
  round: number;
  phase: 'action' | 'return' | 'noble' | 'finished';
  finalRound: boolean;
  winners: string[];
  log: { id: number; text: string }[];
  logSequence: number;
}
export type Action =
  | { type: 'take'; colors: Color[] }
  | { type: 'reserve'; cardId: string }
  | { type: 'reserveDeck'; tier: Tier }
  | { type: 'buy'; cardId: string; payment: Tokens }
  | { type: 'return'; tokens: Tokens }
  | { type: 'noble'; nobleId: string }
  | { type: 'pass' };
export interface Seat {
  id: string;
  name: string;
  ready: boolean;
  online: boolean;
  /** Missing on existing saves means a human seat. */
  bot?: boolean;
}
export type PlayerView = Omit<Player, 'reserved'> & { reserved: (Card | null)[] };
export type GameView = Omit<Game, 'players' | 'decks'> & {
  players: PlayerView[];
  deckCounts: Record<Tier, number>;
};
export interface RoomView {
  code: string;
  hostId: string;
  selfId: string;
  version: number;
  status: 'waiting' | 'playing' | 'finished';
  seats: Seat[];
  game: GameView | null;
}
export type Command =
  | { type: 'addBot' }
  | { type: 'removeBot'; playerId: string }
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'action'; action: Action }
  | { type: 'rematch' }
  | { type: 'kick'; playerId: string }
  | { type: 'end' }
  | { type: 'leave' };
export interface Reply {
  ok: boolean;
  error?: string;
  token?: string;
  room?: RoomView;
  left?: boolean;
}
export const emptyGems = (): Gems => ({ white: 0, blue: 0, green: 0, red: 0, black: 0 });
export const emptyTokens = (): Tokens => ({ ...emptyGems(), gold: 0 });
export const totalTokens = (tokens: Tokens): number =>
  TOKENS.reduce((sum, c) => sum + tokens[c], 0);
export const bonuses = (player: Pick<Player, 'purchased'>): Gems => {
  const result = emptyGems();
  for (const card of player.purchased) result[card.bonus]++;
  return result;
};
export const score = (player: Pick<Player, 'purchased' | 'nobles'>): number =>
  [...player.purchased, ...player.nobles].reduce((sum, card) => sum + card.points, 0);
export const price = (player: Pick<Player, 'purchased'>, card: Card): Gems => {
  const discount = bonuses(player);
  return Object.fromEntries(
    COLORS.map((c) => [c, Math.max(0, card.cost[c] - discount[c])]),
  ) as Gems;
};
export const suggestedPayment = (
  player: Pick<Player, 'purchased' | 'tokens'>,
  card: Card,
): Tokens => {
  const cost = price(player, card),
    payment = emptyTokens();
  for (const color of COLORS) {
    payment[color] = Math.min(cost[color], player.tokens[color]);
    payment.gold += cost[color] - payment[color];
  }
  return payment;
};
export const canAfford = (player: Pick<Player, 'purchased' | 'tokens'>, card: Card): boolean =>
  suggestedPayment(player, card).gold <= player.tokens.gold;
