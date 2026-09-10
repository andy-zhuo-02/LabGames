import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Game, Seat } from '../shared/types.js';

export interface Room {
  code: string;
  hostId: string;
  version: number;
  status: 'waiting' | 'playing' | 'finished';
  seats: Omit<Seat, 'online'>[];
  game: Game | null;
}
export interface Session {
  playerId: string;
  roomCode: string;
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL,
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_code);
      CREATE TABLE IF NOT EXISTS commands (
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        player_id TEXT NOT NULL, action_id TEXT NOT NULL,
        PRIMARY KEY(room_code, player_id, action_id)
      );
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getRoom(code: string): Room | undefined {
    const row = this.db.prepare('SELECT state FROM rooms WHERE code = ?').get(code) as
      | { state: string }
      | undefined;
    return row ? (JSON.parse(row.state) as Room) : undefined;
  }
  saveRoom(room: Room) {
    this.db
      .prepare(
        `INSERT INTO rooms (code, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(room.code, JSON.stringify(room), Date.now());
  }
  addSession(token: string, session: Session) {
    this.db
      .prepare('INSERT INTO sessions (token_hash, player_id, room_code) VALUES (?, ?, ?)')
      .run(hash(token), session.playerId, session.roomCode);
  }
  session(token: string): Session | undefined {
    return this.db
      .prepare(
        'SELECT player_id AS playerId, room_code AS roomCode FROM sessions WHERE token_hash = ?',
      )
      .get(hash(token)) as Session | undefined;
  }
  hasCommand(roomCode: string, playerId: string, actionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM commands WHERE room_code = ? AND player_id = ? AND action_id = ?')
      .get(roomCode, playerId, actionId);
  }
  recordCommand(roomCode: string, playerId: string, actionId: string) {
    this.db
      .prepare('INSERT INTO commands (room_code, player_id, action_id) VALUES (?, ?, ?)')
      .run(roomCode, playerId, actionId);
  }
  removeSeat(roomCode: string, playerId: string) {
    this.db
      .prepare('DELETE FROM sessions WHERE room_code = ? AND player_id = ?')
      .run(roomCode, playerId);
  }
  removeRoom(code: string) {
    this.db.prepare('DELETE FROM rooms WHERE code = ?').run(code);
  }
  close() {
    this.db.close();
  }
}
