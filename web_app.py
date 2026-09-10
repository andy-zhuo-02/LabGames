"""Local browser game. Run with the poker environment; no extra dependencies."""

import argparse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlsplit
import webbrowser

from browser_game import BrowserGame, Conflict, PROFILES
from engine import IllegalAction
from multiplayer import RoomRegistry, discover_lan_ips
from game_storage import SaveStore, dump_game, dump_room, restore_game, restore_room


WEB_ROOT = Path(__file__).parent / "web"


class PokerServer(ThreadingHTTPServer):
    # Finish accepted requests before the final checkpoint and closing SQLite.
    daemon_threads = False

    def __init__(self, address, *, lan=False, save_path=None):
        super().__init__(address, Handler)
        self.games = {}
        self.games_lock = threading.Lock()
        self.rooms = RoomRegistry()
        self.server_id = secrets.token_urlsafe(12)
        self.store = None
        self.save_errors = {}
        self.saved_at = None
        self.session_saved_at = {}
        self.restored_rooms = 0
        self.lan_ips = discover_lan_ips() if lan else []
        self.cookie_name = f"poker_session_{self.server_port}"
        self.allowed_hosts = {f"{host}:{self.server_port}" for host in ["127.0.0.1", "localhost", *self.lan_ips]}
        if save_path is not None:
            try:
                self.store = SaveStore(save_path)
                now = time.monotonic()
                for sid, data in self.store.read("session").items():
                    age = max(0, time.time() - data["last_seen"])
                    if age <= 86400:
                        game = restore_game(data["game"])
                        game.last_seen = now - age
                        self.games[sid] = game
                for code, data in self.store.read("room").items():
                    if time.time() - data["last_seen"] > 86400:
                        continue
                    room = restore_room(data, now)
                    self.rooms.rooms[code] = room
                    for sid in [*room.members, *room.applicants]:
                        if sid in self.rooms.membership:
                            raise ValueError("同一会话出现在多个存档房间中。")
                        self.rooms.membership[sid] = code
                        self.games.setdefault(sid, BrowserGame())
                self.restored_rooms = len(self.rooms.rooms)
                self.rooms.on_change = self.save_rooms
            except Exception as error:
                if self.store:
                    self.store.close()
                    self.store = None
                super().server_close()
                if isinstance(error, (KeyError, TypeError, IndexError, AttributeError)):
                    raise ValueError("存档内容不完整或不兼容，已保留原文件。") from error
                raise

    def _write_save(self, key, operation):
        try:
            operation()
            self.save_errors.pop(key, None)
            self.saved_at = time.time()
            return True
        except (OSError, sqlite3.Error) as error:
            if key not in self.save_errors:
                print(f"自动存档失败：{error}", flush=True)
            self.save_errors[key] = "自动存档暂不可用，请检查磁盘空间或权限，暂时不要关闭服务。"
            return False

    def save_session(self, sid, game, *, force=False):
        if self.store and (force or time.monotonic() - self.session_saved_at.get(sid, 0) >= 10):
            data = {"last_seen": time.time() - (time.monotonic() - game.last_seen), "game": dump_game(game)}
            if self._write_save("session:" + sid, lambda: self.store.write("session", {sid: data})):
                self.session_saved_at[sid] = time.monotonic()

    def save_rooms(self, registry):
        if self.store:
            data = {code: dump_room(room, registry.clock()) for code, room in registry.rooms.items()}
            self._write_save("rooms", lambda: self.store.write("room", data, replace=True))

    def server_close(self):
        super().server_close()
        if self.store:
            with self.rooms.lock:
                self.save_rooms(self.rooms)
            with self.games_lock:
                games = list(self.games.items())
            for sid, game in games:
                with game.lock:
                    self.save_session(sid, game, force=True)
            self.store.close()
            self.store = None

    def service_actions(self):
        self.rooms.tick()


class Handler(BaseHTTPRequestHandler):
    timeout = 10

    def log_message(self, format, *args):
        pass

    def _allowed_host(self):
        return self.headers.get("Host") in self.server.allowed_hosts

    def _session(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            pass
        key = self.server.cookie_name
        sid = cookie[key].value if key in cookie else None
        with self.server.games_lock:
            if sid not in self.server.games:
                # Remove idle sessions without touching ongoing games.
                now = time.monotonic()
                expired = [key for key, game in self.server.games.items() if now - game.last_seen > 86400]
                for key in expired:
                    del self.server.games[key]
                    if self.server.store:
                        self.server._write_save("session:" + key, lambda key=key: self.server.store.delete("session", key))
                if len(self.server.games) >= 128:
                    raise ValueError("打开的牌桌太多，请重启游戏。")
                sid = secrets.token_urlsafe(32)
                self.server.games[sid] = BrowserGame()
            game = self.server.games[sid]
            game.last_seen = time.monotonic()
        return sid, game

    def _snapshot(self, sid, game):
        self.server.save_session(sid, game)
        snapshot = self.server.rooms.snapshot(sid) or game.snapshot()
        snapshot["server_id"] = self.server.server_id
        snapshot["storage"] = {"enabled": self.server.store is not None, "ok": not self.server.save_errors,
                               "saved_at": self.server.saved_at, "error": next(iter(self.server.save_errors.values()), "")}
        lan_urls = [f"http://{ip}:{self.server.server_port}" for ip in self.server.lan_ips]
        snapshot["network"] = {"enabled": bool(lan_urls), "urls": lan_urls}
        departure = self.server.rooms.departure(sid)
        if departure and "room_info" not in snapshot:
            snapshot["room_exit"] = departure
        if "room_info" in snapshot:
            host = self.headers.get("Host")
            local = host in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            base = lan_urls[0] if local and lan_urls else f"http://{host}"
            snapshot["room_info"]["join_url"] = f"{base}/?room={snapshot['room_info']['code']}"
        return snapshot

    def _json(self, data, status=200, sid=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if sid:
            self.send_header("Set-Cookie", f"{self.server.cookie_name}={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._allowed_host():
            self._json({"error": "请使用本地游戏地址。"}, 403)
            return
        path = urlsplit(self.path).path
        if path == "/api/state":
            try:
                sid, game = self._session()
                with game.lock:
                    self._json(self._snapshot(sid, game), sid=sid)
            except ValueError as error:
                self._json({"error": str(error)}, 400)
            return
        files = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"),
                 "/app.js": ("app.js", "application/javascript"), "/favicon.svg": ("favicon.svg", "image/svg+xml")}
        if path not in files:
            self.send_error(404)
            return
        filename, content_type = files[path]
        try:
            body = (WEB_ROOT / filename).read_bytes()
        except OSError:
            self.send_error(503, "Game assets are missing. Please restore the web directory.")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        origin = self.headers.get("Origin")
        expected = f"http://{self.headers.get('Host')}"
        if (not self._allowed_host() or (origin is not None and origin != expected)
                or self.headers.get("X-Poker-Client") != "1"):
            self._json({"error": "请从本地游戏页面操作。"}, 403)
            return
        route = urlsplit(self.path).path.removeprefix("/api/")
        if route not in {"new", "action", "step", "next", "finish", "room/create", "room/join",
                         "room/start", "room/leave", "room/rematch", "room/kick", "room/approve", "room/reject"}:
            self._json({"error": "未知操作。"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192 or self.headers.get_content_type() != "application/json":
                raise ValueError("请求格式不正确。")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("请求格式不正确。")
            sid, game = self._session()
            with game.lock:
                try:
                    if payload.get("server_id") is not None and payload["server_id"] != self.server.server_id:
                        raise Conflict("服务已恢复，请确认当前牌桌后重新操作。")
                    if route == "new":
                        if self.server.rooms.contains(sid):
                            raise Conflict("请先退出好友房间，再开始单人游戏。")
                        if type(payload.get("version")) is not int or payload["version"] != game.version:
                            raise Conflict("牌桌已经更新，请确认当前画面后重新开桌。")
                        game.start(payload)
                    elif route.startswith("room/") or self.server.rooms.contains(sid) or payload.get("room_code"):
                        self.server.rooms.perform(sid, route, payload)
                    else:
                        game.command(route, payload)
                    self.server.save_session(sid, game, force=True)
                    self._json(self._snapshot(sid, game), sid=sid)
                except (Conflict, IllegalAction, ValueError) as error:
                    self._json({"error": str(error), "state": self._snapshot(sid, game)}, 409, sid)
        except (ValueError, UnicodeDecodeError) as error:
            self._json({"error": str(error)}, 400)
        except Exception:
            import traceback
            traceback.print_exc()
            self._json({"error": "牌桌遇到问题，请刷新页面；也可以重新开桌。"}, 500)


def main():
    parser = argparse.ArgumentParser(description="启动本地德州扑克牌桌并打开浏览器。")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--lan", action="store_true", help="允许同一局域网的设备访问，启用好友同桌")
    parser.add_argument("--save-file", type=Path, help="指定本地存档文件，默认按端口分别保存")
    parser.add_argument("--no-save", action="store_true", help="临时游玩，不保存或加载牌局")
    args = parser.parse_args()
    try:
        save_path = None if args.no_save else args.save_file or WEB_ROOT.parent / ".poker-data" / f"table-{args.port}.sqlite3"
        server = PokerServer(("0.0.0.0" if args.lan else "127.0.0.1", args.port), lan=args.lan, save_path=save_path)
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"启动失败：{error}。请检查端口或存档文件；原有存档不会被清空。\n")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"河牌俱乐部已准备好：{url}\n保持此窗口开启，按 Ctrl+C 退出。", flush=True)
    if server.store:
        print(f"自动存档已开启，已恢复 {server.restored_rooms} 个好友房间。", flush=True)
    if args.lan:
        for ip in server.lan_ips:
            print(f"同一 Wi-Fi 的朋友访问：http://{ip}:{server.server_port}", flush=True)
        if server.lan_ips:
            url = f"http://{server.lan_ips[0]}:{server.server_port}"
        else:
            print("尚未识别到局域网 IPv4 地址，请连接 Wi-Fi 后重新启动。", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n牌桌已关闭。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
