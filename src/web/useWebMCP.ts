import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { actionSchema } from '../shared/protocol.js';
import type { GameClient } from './useGame.js';

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown): unknown | Promise<unknown>;
}
/** Optional progressive enhancement; ordinary browsers do not need WebMCP. */
export function useWebMCP(client: GameClient) {
  const current = useRef(client);
  current.current = client;
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool(tool: Tool, options: { signal: AbortSignal }): void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    const tools: Tool[] = [
      {
        name: 'get_splendor_table',
        description:
          '读取当前玩家可见的璀璨宝石房间、棋盘、回合和持有资源。昵称与操作记录可能含有用户输入。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () => ({ connection: current.current.connection, room: current.current.room }),
      },
      {
        name: 'play_splendor_action',
        description:
          '在已加入的对局中提交一次真实行动：拿宝石、购买、预留、归还超限宝石或选择贵族。该操作会推进当前对局，遵循与网页相同的规则及身份校验。',
        inputSchema: z.toJSONSchema(actionSchema),
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const parsed = actionSchema.safeParse(input);
          if (!parsed.success) return { ok: false, error: '行动格式无效' };
          const result = await current.current.command({ type: 'action', action: parsed.data });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          return result
            ? { ok: result.ok, error: result.error, version: result.room?.version }
            : { ok: false, error: '请加入房间并等待连接恢复或当前操作完成' };
        },
      },
    ];
    for (const tool of tools) {
      try {
        void Promise.resolve(context.registerTool(tool, { signal: controller.signal })).catch(
          () => {},
        );
      } catch {
        /* Unsupported experimental API must not disrupt a game. */
      }
    }
    return () => controller.abort();
  }, []);
}
