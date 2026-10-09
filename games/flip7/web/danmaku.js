const PREF_KEY = "labgames.flip7.danmaku.v1";
const MAX_LENGTH = 40;

// These nodes live outside the table so incoming game snapshots cannot erase a draft.
export class Danmaku {
  constructor({ send, onError }) {
    this.send = send;
    this.onError = onError;
    this.panel = document.querySelector("#danmaku-panel");
    this.layer = document.querySelector("#danmaku-layer");
    this.input = document.querySelector("#danmaku-input");
    this.count = document.querySelector("#danmaku-count");
    this.button = document.querySelector("#danmaku-send");
    this.toggle = document.querySelector("#danmaku-toggle");
    this.feedback = document.querySelector("#danmaku-feedback");
    this.announcer = document.querySelector("#danmaku-announcer");
    this.quick = [...this.panel.querySelectorAll("[data-danmaku-quick]")];
    this.enabled = true;
    this.code = null;
    this.queue = [];
    this.active = new Map();
    this.cooldown = 0;
    this.sending = false;
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    try {
      this.enabled = localStorage.getItem(PREF_KEY) !== "off";
    } catch {
      /* Optional display preference. */
    }
    document
      .querySelector("#danmaku-form")
      .addEventListener("submit", (event) => {
        event.preventDefault();
        void this.submit(this.input.value, true);
      });
    this.input.addEventListener("input", () => this.update());
    for (const button of this.quick)
      button.addEventListener(
        "click",
        () => void this.submit(button.dataset.danmakuQuick),
      );
    this.toggle.addEventListener("click", () => {
      this.enabled = !this.enabled;
      if (!this.enabled) this.clear();
      try {
        localStorage.setItem(PREF_KEY, this.enabled ? "on" : "off");
      } catch {
        /* Best effort. */
      }
      this.update();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clear();
    });
    this.motion.addEventListener("change", () => this.clear());
  }
  setContext({ code = null, selfId = null, connected = false }) {
    if (this.code !== code) {
      this.clear();
      this.input.value = "";
      this.cooldown = 0;
      this.sending = false;
      this.feedback.textContent =
        "每 2 秒可以发送一条，关闭弹幕仅影响自己的画面。";
    }
    Object.assign(this, { code, selfId, connected });
    this.update();
  }
  update() {
    const count = [...this.input.value.trim()].length;
    const cooling = performance.now() < this.cooldown;
    const blocked = !this.connected || this.sending || cooling;
    this.panel.hidden = !this.code;
    this.layer.hidden = !this.code || !this.enabled;
    document.body.classList.toggle("has-danmaku", !!this.code);
    this.toggle.textContent = this.enabled ? "弹幕：开" : "弹幕：关";
    this.toggle.setAttribute("aria-pressed", String(this.enabled));
    this.count.textContent = `${count}/${MAX_LENGTH}`;
    this.count.classList.toggle("too-long", count > MAX_LENGTH);
    this.input.setAttribute("aria-invalid", String(count > MAX_LENGTH));
    this.button.disabled = blocked || !count || count > MAX_LENGTH;
    this.button.textContent = this.sending
      ? "发送中"
      : cooling
        ? "稍等"
        : "发送";
    for (const button of this.quick) button.disabled = blocked;
  }
  async submit(raw, fromInput = false) {
    const text = raw.trim();
    if (
      !this.code ||
      !this.connected ||
      this.sending ||
      performance.now() < this.cooldown
    )
      return;
    if (!text || [...text].length > MAX_LENGTH) {
      this.onError("弹幕需要 1～40 个字符");
      return;
    }
    const code = this.code;
    this.sending = true;
    this.update();
    try {
      await this.send(text);
      if (this.code !== code) return;
      if (fromInput && this.input.value === raw) this.input.value = "";
      this.cooldown = performance.now() + 2000;
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = setTimeout(() => this.update(), 2010);
      this.feedback.textContent = this.enabled
        ? "弹幕已发送"
        : "弹幕已发送，你已关闭本机弹幕显示";
    } catch (error) {
      if (this.code === code) {
        this.feedback.textContent = error.message;
        this.onError(error.message);
      }
    } finally {
      if (this.code === code) {
        this.sending = false;
        this.update();
      }
    }
  }
  receive(message) {
    if (message.code !== this.code || !this.enabled || document.hidden) return;
    this.queue.push({ ...message, receivedAt: performance.now() });
    if (this.queue.length > 12) this.queue.shift();
    const line = document.createElement("p");
    line.textContent = `${message.name}：${message.text}`;
    this.announcer.append(line);
    while (this.announcer.children.length > 10)
      this.announcer.firstElementChild.remove();
    this.drain();
  }
  drain() {
    const capacity = this.motion.matches ? 1 : 3;
    while (this.queue.length && this.active.size < capacity) {
      const message = this.queue.shift();
      if (performance.now() - message.receivedAt > 12_000) continue;
      const lane = [0, 1, 2].find((index) => !this.active.has(index));
      const bubble = document.createElement("div");
      bubble.className = `danmaku-bubble${message.playerId === this.selfId ? " is-mine" : ""}${this.motion.matches ? " is-still" : ""}`;
      bubble.dataset.lane = lane;
      const name = document.createElement("b");
      name.textContent = message.name;
      const text = document.createElement("span");
      text.textContent = message.text;
      bubble.append(name, text);
      this.layer.append(bubble);
      const finish = () => {
        if (this.active.get(lane)?.bubble !== bubble) return;
        bubble.remove();
        this.active.delete(lane);
        this.drain();
      };
      if (this.motion.matches) {
        this.active.set(lane, { bubble, timer: setTimeout(finish, 6000) });
      } else {
        const distance = this.layer.clientWidth + bubble.offsetWidth;
        const animation = bubble.animate(
          [
            { transform: "translateX(0)" },
            { transform: `translateX(-${distance}px)` },
          ],
          { duration: Math.max(6500, distance / 0.15), easing: "linear" },
        );
        this.active.set(lane, { bubble, animation });
        animation.finished.then(finish).catch(() => {});
      }
    }
  }
  clear() {
    this.queue = [];
    for (const { bubble, timer, animation } of this.active.values()) {
      clearTimeout(timer);
      animation?.cancel();
      bubble.remove();
    }
    this.active.clear();
    this.announcer.replaceChildren();
  }
}
