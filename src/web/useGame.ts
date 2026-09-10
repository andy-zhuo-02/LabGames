import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Command, Reply, RoomView } from '../shared/types.js';

const TOKEN_KEY = 'splendor.seat.v1';
const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
const saveToken = (token?: string) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* session remains usable */
  }
};
export function actionId(): string {
  // getRandomValues is available on ordinary HTTP LAN origins; randomUUID is not.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
export function useGame() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline' | 'replaced'>(
    'connecting',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const socket = useRef<Socket | null>(null),
    roomRef = useRef<RoomView | null>(null),
    busyRef = useRef(false);
  function accept(next: RoomView) {
    const current = roomRef.current;
    if (current && current.code === next.code && next.version < current.version) return;
    roomRef.current = next;
    setRoom(next);
  }
  useEffect(() => {
    const client = io({ autoConnect: false });
    socket.current = client;
    client.on('connect', async () => {
      const token = readToken();
      if (!token) {
        setConnection('connected');
        return;
      }
      setConnection('connecting');
      try {
        const result: Reply = await client.timeout(6000).emitWithAck('room:resume', token);
        if (result.ok && result.room) accept(result.room);
        else {
          saveToken();
          roomRef.current = null;
          setRoom(null);
          setError(result.error ?? '请重新加入房间');
        }
        setConnection('connected');
      } catch {
        setConnection('offline');
        client.disconnect().connect();
      }
    });
    client.on('disconnect', (reason) => {
      if (reason !== 'io server disconnect') setConnection('offline');
    });
    client.on('connect_error', () => setConnection('offline'));
    client.on('room:state', accept);
    client.on('session:replaced', () => {
      setConnection('replaced');
      setError('这个座位已在另一个标签页打开，请在那个页面继续');
    });
    client.connect();
    return () => {
      client.removeAllListeners();
      client.disconnect();
      socket.current = null;
    };
  }, []);
  async function send(event: string, data: unknown, retry = false): Promise<Reply | undefined> {
    if (!socket.current?.connected || connection !== 'connected' || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      let result: Reply;
      try {
        result = await socket.current.timeout(6000).emitWithAck(event, data);
      } catch (error) {
        if (!retry || !socket.current.connected) throw error;
        result = await socket.current.timeout(6000).emitWithAck(event, data);
      }
      if (result.token) saveToken(result.token);
      if (result.room) accept(result.room);
      if (result.left) {
        saveToken();
        roomRef.current = null;
        setRoom(null);
        window.history.replaceState(null, '', window.location.pathname);
      }
      if (!result.ok) setError(result.error ?? '操作失败');
      return result;
    } catch {
      setError('未收到操作确认，正在恢复连接；请核对恢复后的棋盘');
      socket.current?.disconnect().connect();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function command(command: Command) {
    if (!roomRef.current) return Promise.resolve(undefined);
    return send(
      'room:command',
      { actionId: actionId(), version: roomRef.current.version, command },
      true,
    );
  }
  return {
    room,
    connection,
    busy,
    error,
    setError,
    command,
    create: (name: string) => send('room:create', { name }),
    join: (name: string, code: string) => send('room:join', { name, code }),
  };
}
export type GameClient = ReturnType<typeof useGame>;
