const SESSION_KEY = "labgames.flip7.room.v1";
// crypto.randomUUID is not available on many plain-HTTP LAN origins.
export const requestId = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export class NetworkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export class RoomClient {
  constructor({
    onSnapshot,
    onConnection,
    onSessionLost,
    onStorageError,
    onDanmaku,
  }) {
    Object.assign(this, {
      onSnapshot,
      onConnection,
      onSessionLost,
      onStorageError,
      onDanmaku,
    });
    this.session = null;
    this.controller = null;
    this.retryTimer = null;
    this.generation = 0;
    this.connected = false;
    this.snapshot = null;
    this.seenDanmaku = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (
        saved &&
        /^[A-Z2-9]{6}$/.test(saved.code) &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.token)
      )
        this.session = saved;
    } catch {
      /* Unreadable browser storage does not prevent a new room. */
    }
  }
  async request(path, payload, credential = this.session?.token) {
    let response;
    try {
      response = await fetch(path, {
        method: payload === undefined ? "GET" : "POST",
        credentials: "omit",
        headers: {
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new NetworkError(0, "连接不到房间服务器，请检查网络后重试");
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new NetworkError(
        error instanceof SyntaxError ? response.status : 0,
        "服务器响应中断，请检查网络后重试",
      );
    }
    if (!response.ok)
      throw new NetworkError(response.status, data.error || "请求失败");
    return data;
  }
  remember(session) {
    this.seenDanmaku.clear();
    this.session = session;
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      this.onStorageError?.();
    }
  }
  async enter(name, code, options = {}) {
    const path = code ? `/api/rooms/${code.toUpperCase()}/join` : "/api/rooms";
    const result = await this.request(
      path,
      code ? { name } : { name, cardTracker: options.cardTracker === true },
      null,
    );
    this.disconnect();
    this.remember({ code: result.code, token: result.token });
    this.receive(result.snapshot);
    this.connect();
  }
  receive(snapshot) {
    if (!this.session || snapshot.code !== this.session.code) return;
    if (snapshot.removed) {
      this.forget();
      this.onSessionLost?.("已离开房间");
      return;
    }
    if (
      this.snapshot &&
      snapshot.code === this.snapshot.code &&
      snapshot.revision < this.snapshot.revision
    )
      return;
    this.snapshot = snapshot;
    this.onSnapshot(snapshot);
  }
  async refresh() {
    if (!this.session) return;
    this.receive(await this.request(`/api/rooms/${this.session.code}`));
  }
  async command(command, id = requestId()) {
    if (!this.session || !this.snapshot)
      throw new NetworkError(0, "房间尚未连接");
    const payload = {
      requestId: id,
      expectedRevision: this.snapshot.revision,
      command,
    };
    // Retry only an uncertain transport failure, preserving the exact operation ID and revision.
    const path = `/api/rooms/${this.session.code}/commands`;
    const credential = this.session.token;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.receive(await this.request(path, payload, credential));
        return;
      } catch (error) {
        if (error.status === 0 && attempt === 0) continue;
        if (error.status === 409) await this.refresh().catch(() => {});
        if (
          [401, 404].includes(error.status) &&
          this.session?.token === credential
        ) {
          this.forget();
          this.onSessionLost?.("房间身份已失效或房间已关闭");
        }
        throw error;
      }
    }
  }
  receiveDanmaku(message) {
    if (
      !this.session ||
      message.code !== this.session.code ||
      this.seenDanmaku.has(message.id)
    )
      return;
    this.seenDanmaku.add(message.id);
    if (this.seenDanmaku.size > 256)
      this.seenDanmaku.delete(this.seenDanmaku.values().next().value);
    this.onDanmaku?.(message);
  }
  async sendDanmaku(text) {
    if (!this.session || !this.connected)
      throw new NetworkError(0, "连接恢复后才能发送弹幕");
    const { code, token } = this.session;
    const payload = { requestId: requestId(), text };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const message = await this.request(
          `/api/rooms/${code}/danmaku`,
          payload,
          token,
        );
        if (this.session?.token === token) this.receiveDanmaku(message);
        return;
      } catch (error) {
        if (error.status === 0 && attempt === 0) continue;
        if (
          [401, 404].includes(error.status) &&
          this.session?.token === token
        ) {
          this.forget();
          this.onSessionLost?.("房间身份已失效或房间已关闭");
        }
        throw error;
      }
    }
  }
  connect() {
    this.disconnect();
    if (!this.session) return;
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation || !this.session) return;
      this.controller = new AbortController();
      const controller = this.controller;
      let watchdog;
      const resetWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), 25_000);
      };
      resetWatchdog();
      this.connected = false;
      this.onConnection(false);
      try {
        const response = await fetch(
          `/api/rooms/${this.session.code}/events?danmaku=1`,
          {
            headers: { Authorization: `Bearer ${this.session.token}` },
            credentials: "omit",
            signal: this.controller.signal,
          },
        );
        if (generation !== this.generation) return;
        if ([401, 404].includes(response.status)) {
          this.forget();
          this.onSessionLost?.("房间身份已失效或房间已关闭");
          return;
        }
        if (!response.ok || !response.body)
          throw new Error("stream unavailable");
        this.connected = true;
        this.onConnection(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (generation === this.generation) {
          const { value, done } = await reader.read();
          if (done) break;
          if (generation !== this.generation) break;
          resetWatchdog();
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = event.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              const data = JSON.parse(line.slice(6));
              if (event.split("\n").includes("event: danmaku"))
                this.receiveDanmaku(data);
              else this.receive(data);
            }
          }
        }
      } catch {
        /* A closed stream resumes from the next complete server snapshot. */
      } finally {
        clearTimeout(watchdog);
        controller.abort();
      }
      if (generation === this.generation && this.session) {
        this.connected = false;
        this.onConnection(false);
        this.retryTimer = setTimeout(run, 1500);
      }
    };
    void run();
  }
  disconnect() {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.controller?.abort();
    this.controller = null;
    this.connected = false;
  }
  forget() {
    this.disconnect();
    this.remember(null);
    this.snapshot = null;
  }
}
