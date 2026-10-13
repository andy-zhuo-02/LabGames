import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { BrowserGame, Conflict, now } from "./src/browser-game.mjs";
import { RoomRegistry, token } from "./src/rooms.mjs";
import {
  SaveStore,
  dump_game,
  restore_game,
  dump_room,
  restore_room,
  read_legacy,
} from "./src/storage.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/style.css", ["style.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/room-background-v1.png", ["room-background-v1.png", "image/png"]],
]);
export const lanIPs = () => [
  ...new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal)
      .map((a) => a.address),
  ),
];
export function createApp({
  lan = false,
  savePath = null,
  importPath = null,
  clock = now,
} = {}) {
  const games = new Map(),
    rooms = new RoomRegistry({ clock }),
    id = token(12),
    ips = lan ? lanIPs() : [];
  let store = null,
    savedAt = null,
    stopping = false;
  const errors = new Map(),
    lastSaved = new Map();
  const save = (key, operation) => {
    try {
      operation();
      errors.delete(key);
      savedAt = now();
      return true;
    } catch (e) {
      errors.set(
        key,
        "自动存档暂不可用，请检查磁盘空间或权限，暂时不要关闭服务。",
      );
      console.error("自动存档失败：", e.message);
      return false;
    }
  };
  const saveSession = (sid, game, force = false) => {
    if (store && (force || clock() - (lastSaved.get(sid) || 0) >= 10))
      if (
        save("session:" + sid, () =>
          store.write("session", {
            [sid]: { last_seen: game.last_seen, game: dump_game(game) },
          }),
        )
      )
        lastSaved.set(sid, clock());
  };
  const saveRooms = () => {
    if (store)
      save("rooms", () =>
        store.write(
          "room",
          Object.fromEntries(
            Object.values(rooms.rooms).map((r) => [r.code, dump_room(r)]),
          ),
          true,
        ),
      );
  };
  try {
    if (savePath) {
      if (importPath && existsSync(savePath))
        throw new Error(
          "导入目标已存在，请指定新的 --save-file，避免覆盖现有牌局。",
        );
      const imported = importPath ? read_legacy(importPath) : null;
      store = new SaveStore(savePath);
      if (imported) {
        store.write("session", imported.sessions);
        store.write("room", imported.rooms);
      }
      for (const [sid, data] of Object.entries(store.read("session")))
        if (clock() - data.last_seen <= 86400) {
          const game = restore_game(data.game);
          game.last_seen = data.last_seen;
          games.set(sid, game);
        }
      for (const [code, data] of Object.entries(store.read("room")))
        if (clock() - data.last_seen <= 86400) {
          const room = restore_room(data, clock());
          rooms.rooms[code] = room;
          for (const sid of [
            ...Object.keys(room.members),
            ...Object.keys(room.applicants),
          ]) {
            if (rooms.contains(sid))
              throw new Error("同一会话出现在多个存档房间中。");
            rooms.membership[sid] = code;
            if (!games.has(sid)) games.set(sid, new BrowserGame());
          }
        }
      rooms.on_change = saveRooms;
    }
  } catch (e) {
    store?.close();
    throw e;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    const port = server.address().port,
      cookieName = `poker_session_${port}`;
    const json = (status, data, sid) => {
      if (sid)
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        );
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    const allowed = new Set(
      ["127.0.0.1", "localhost", ...ips].map((h) => `${h}:${port}`),
    );
    if (!allowed.has(req.headers.host)) {
      json(403, { error: "请使用本地游戏地址。" });
      return;
    }
    const session = () => {
      let sid = req.headers.cookie
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1);
      if (!games.has(sid)) {
        for (const [key, game] of games)
          if (clock() - game.last_seen > 86400 && !rooms.contains(key)) {
            games.delete(key);
            if (store)
              save("session:" + key, () => store.delete("session", key));
          }
        if (games.size >= 128) throw new Error("打开的牌桌太多，请稍后再试。");
        sid = token(32);
        games.set(sid, new BrowserGame());
      }
      const game = games.get(sid);
      game.last_seen = clock();
      return [sid, game];
    };
    const snapshot = (sid, game) => {
      saveSession(sid, game);
      const state = rooms.snapshot(sid) || game.snapshot(),
        urls = ips.map((ip) => `http://${ip}:${port}`);
      state.server_id = id;
      state.storage = {
        enabled: !!store,
        ok: errors.size === 0,
        saved_at: savedAt,
        error: [...errors.values()][0] || "",
      };
      state.network = { enabled: urls.length > 0, urls };
      if (rooms.departure(sid) && !state.room_info)
        state.room_exit = rooms.departure(sid);
      if (state.room_info) {
        const local = ["127.0.0.1", "localhost"].some(
          (h) => req.headers.host === `${h}:${port}`,
        );
        state.room_info.join_url = `${local && urls.length ? urls[0] : `http://${req.headers.host}`}/?room=${state.room_info.code}`;
      }
      return state;
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/api/health") {
        json(200, { ok: true, game: "poker", version: "0.3.0" });
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        const [sid, game] = session();
        json(200, snapshot(sid, game), sid);
        return;
      }
      if (req.method === "GET" && path === "/api/invite-qr") {
        const [sid, game] = session(),
          room = snapshot(sid, game).room_info;
        if (!room || room.pending_approval) {
          json(409, { error: "入桌后才能生成邀请二维码。" });
          return;
        }
        const body = await QRCode.toString(room.join_url, {
          type: "svg",
          margin: 4,
        });
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }
      if (req.method === "POST") {
        if (
          (req.headers.origin &&
            req.headers.origin !== `http://${req.headers.host}`) ||
          req.headers["x-poker-client"] !== "1"
        ) {
          json(403, { error: "请从本地游戏页面操作。" });
          return;
        }
        const routes = [
          "new",
          "action",
          "step",
          "next",
          "finish",
          "room/create",
          "room/join",
          "room/start",
          "room/leave",
          "room/rematch",
          "room/kick",
          "room/approve",
          "room/reject",
          "room/away",
          "room/recover",
        ];
        if (!path.startsWith("/api/") || !routes.includes(path.slice(5))) {
          json(404, { error: "未知操作。" });
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          json(400, { error: "请求格式不正确。" });
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) {
            json(413, { error: "请求过长。" });
            return;
          }
          chunks.push(chunk);
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          json(400, { error: "请求格式不正确。" });
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          json(400, { error: "请求格式不正确。" });
          return;
        }
        const [sid, game] = session(),
          route = path.slice(5);
        try {
          if (payload.server_id != null && payload.server_id !== id)
            throw new Conflict("服务已恢复，请确认当前牌桌后重新操作。");
          if (route === "new") {
            if (rooms.contains(sid))
              throw new Conflict("请先退出好友房间，再开始单人游戏。");
            if (
              !Number.isInteger(payload.version) ||
              payload.version !== game.version
            )
              throw new Conflict("牌桌已经更新，请确认当前画面后重新开桌。");
            game.start(payload);
          } else if (
            route.startsWith("room/") ||
            rooms.contains(sid) ||
            payload.room_code
          )
            rooms.perform(sid, route, payload);
          else game.command(route, payload);
          saveSession(sid, game, true);
          json(200, snapshot(sid, game), sid);
        } catch (e) {
          json(409, { error: e.message, state: snapshot(sid, game) }, sid);
        }
        return;
      }
      const asset = files.get(path);
      if (!["GET", "HEAD"].includes(req.method) || !asset) {
        json(404, { error: "Not found" });
        return;
      }
      const body = await readFile(resolve(ROOT, "web", asset[0]));
      res.writeHead(200, {
        "Content-Type":
          asset[1] + (asset[1].startsWith("image/") ? "" : "; charset=utf-8"),
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(500, { error: "牌桌遇到问题，请刷新页面。" });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const interval = setInterval(() => {
    try {
      rooms.tick();
    } catch (e) {
      console.error("牌桌推进失败：", e);
    }
  }, 250);
  interval.unref();
  server.rooms = rooms;
  server.games = games;
  server.stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
    saveRooms();
    for (const [sid, game] of games) saveSession(sid, game, true);
    store?.close();
    store = null;
  };
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values: args } = parseArgs({
      options: {
        port: { type: "string" },
        host: { type: "string" },
        lan: { type: "boolean" },
        "no-browser": { type: "boolean" },
        "save-file": { type: "string" },
        "no-save": { type: "boolean" },
        "import-save": { type: "string" },
      },
    });
    const port = Number(args.port ?? process.env.PORT ?? 8765),
      host = args.host ?? process.env.HOST ?? "0.0.0.0";
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("端口必须为 1～65535 的整数。");
    const savePath = args["no-save"]
      ? null
      : resolve(
          args["save-file"] ??
            process.env.POKER_DATA_FILE ??
            `${ROOT}/.poker-data/table-${port}.node.sqlite3`,
        );
    const legacy = resolve(ROOT, ".poker-data", `table-${port}.sqlite3`);
    const importPath =
      args["import-save"] ??
      (savePath && !existsSync(savePath) && existsSync(legacy) ? legacy : null);
    if (args["no-save"] && args["import-save"])
      throw new Error("--no-save 不能与 --import-save 同时使用。");
    const server = createApp({
      lan: args.lan || host === "0.0.0.0",
      savePath,
      importPath,
    });
    server.on("error", async (e) => {
      console.error("启动失败：", e.message);
      await server.stop();
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`\n德州扑克 · http://localhost:${port}`);
      if (host === "0.0.0.0")
        for (const ip of lanIPs()) console.log(`局域网：http://${ip}:${port}`);
      if (importPath) console.log("已导入旧版存档，原文件保持不变。");
      console.log("按 Ctrl+C 停止。");
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => void server.stop());
  } catch (e) {
    console.error("启动失败：", e.message);
    process.exitCode = 1;
  }
}
