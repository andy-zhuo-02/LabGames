import { z } from 'zod';
import { COLORS } from './types.js';

const amount = z.number().int().min(0).max(20);
const tokens = z
  .object({ white: amount, blue: amount, green: amount, red: amount, black: amount, gold: amount })
  .strict();
const id = z.string().min(1).max(64);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('take'), colors: z.array(z.enum(COLORS)).min(1).max(3) }).strict(),
  z.object({ type: z.literal('reserve'), cardId: id }).strict(),
  z
    .object({
      type: z.literal('reserveDeck'),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    })
    .strict(),
  z.object({ type: z.literal('buy'), cardId: id, payment: tokens }).strict(),
  z.object({ type: z.literal('return'), tokens }).strict(),
  z.object({ type: z.literal('noble'), nobleId: id }).strict(),
  z.object({ type: z.literal('pass') }).strict(),
]);
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addBot') }).strict(),
  z.object({ type: z.literal('removeBot'), playerId: id }).strict(),
  z.object({ type: z.literal('ready'), ready: z.boolean() }).strict(),
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('action'), action: actionSchema }).strict(),
  z.object({ type: z.literal('rematch') }).strict(),
  z.object({ type: z.literal('kick'), playerId: id }).strict(),
  z.object({ type: z.literal('end') }).strict(),
  z.object({ type: z.literal('leave') }).strict(),
]);
export const envelopeSchema = z
  .object({
    actionId: z.string().min(8).max(80),
    version: z.number().int().nonnegative(),
    command: commandSchema,
  })
  .strict();
const name = z
  .string()
  .trim()
  .min(1, '请输入昵称')
  .max(16, '昵称最多 16 个字')
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, '昵称含有无效字符');
export const createSchema = z.object({ name }).strict();
export const joinSchema = z
  .object({
    name,
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z2-9]{6}$/),
  })
  .strict();
