import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Table } from "./engine.mjs";
import { make_bot, PROFILES, catalog } from "./bots.mjs";
import { BrowserGame, Conflict, now } from "./browser-game.mjs";

export const ONLINE_SECONDS = 8,
  DISCONNECT_SECONDS = 12,
  HOST_TIMEOUT = 20,
  BOT_DELAY = 0.8;
export const token = (bytes = 24) => randomBytes(bytes).toString("base64url");
export class Member {
  constructor(name, seen, player_id = 0) {
    Object.assign(this, {
      name,
      seen,
      player_id,
      member_id: token(9),
      joined_hand: 1,
      away: false,
      recovery_code: token(),
    });
  }
}
export class Room {
  constructor(
    code,
    host,
    capacity,
    fill_bots,
    bot_strategy,
    turn_seconds = 90,
  ) {
    Object.assign(this, {
      code,
      host,
      capacity,
      fill_bots,
      bot_strategy,
      turn_seconds,
      members: {},
      applicants: {},
      game: null,
      version: 1,
      last_seen: 0,
      turn_key: null,
      deadline: 0,
      notice: "",
      round_id: 1,
      ready: new Set(),
      banned: new Set(),
      recovering: false,
    });
  }
  reset_ready() {
    this.ready.clear();
    this.round_id++;
  }
  readiness_members() {
    const present = Object.keys(this.members).filter(
      (s) => !this.members[s].away,
    );
    if (this.game?.table.hand.finished && this.can_continue(true)) {
      const active = present.filter(
        (s) =>
          this.members[s].player_id == null ||
          this.game.table.players[this.members[s].player_id].stack > 0,
      );
      if (active.length) return active;
    }
    return present;
  }
  seating_plan(include_away = false) {
    if (!this.game) return [];
    const occupied = new Set(
        Object.values(this.members).map((m) => m.player_id),
      ),
      players = this.game.table.players;
    const available = Array.from(
      { length: this.capacity - players.length },
      (_, i) => i + players.length,
    );
    available.push(
      ...players
        .filter((p) => !occupied.has(p.player_id))
        .sort(
          (a, b) =>
            Number(a.stack > 0) - Number(b.stack > 0) ||
            a.player_id - b.player_id,
        )
        .map((p) => p.player_id),
    );
    const waiting = Object.keys(this.members).filter(
      (s) =>
        this.members[s].player_id == null &&
        (include_away || !this.members[s].away),
    );
    if (waiting.length > available.length)
      throw new Error("等待入座的人数超过房间容量。");
    return waiting.map((s, i) => [s, available[i]]);
  }
  can_continue(include_away = false) {
    if (!this.game) return false;
    const stacks = Object.fromEntries(
      this.game.table.players.map((p) => [p.player_id, p.stack]),
    );
    for (const [, seat] of this.seating_plan(include_away))
      stacks[seat] = this.game.table.config.starting_stack;
    if (!include_away)
      for (const m of Object.values(this.members))
        if (m.away && m.player_id != null) delete stacks[m.player_id];
    return Object.values(stacks).filter((s) => s > 0).length >= 2;
  }
  playing_members() {
    return Object.keys(this.members).filter(
      (s) => this.members[s].player_id != null && !this.members[s].away,
    );
  }
  arm_turn(time) {
    if (this.recovering || !this.game || this.game.table.hand.finished) {
      this.turn_key = null;
      this.deadline = 0;
      return;
    }
    const h = this.game.table.hand,
      key = `${h.hand_number}:${h.actions.length}:${h.actor_id}`;
    if (key !== this.turn_key) {
      this.turn_key = key;
      const away = Object.values(this.members).some(
        (m) => m.player_id === h.actor_id && m.away,
      );
      this.deadline =
        time +
        (this.game.bots[h.actor_id] || away ? BOT_DELAY : this.turn_seconds);
    }
  }
  changed(time) {
    this.version++;
    this.last_seen = time;
    this.game?.account_result();
    this.arm_turn(time);
  }
}
export class RoomRegistry {
  constructor({ clock = now, on_change = null } = {}) {
    this.rooms = {};
    this.membership = {};
    this.departures = {};
    this.clock = clock;
    this.on_change = on_change;
    this.last_checkpoint = clock();
  }
  room(sid) {
    const r = this.rooms[this.membership[sid]];
    if (!r) throw new Conflict("你还没有加入好友房间。");
    return r;
  }
  contains(sid) {
    return Object.hasOwn(this.membership, sid);
  }
  departure(sid) {
    return this.departures[sid];
  }
  new_code() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
      code = Array.from(
        { length: 6 },
        () => alphabet[randomInt(alphabet.length)],
      ).join("");
    } while (this.rooms[code]);
    return code;
  }
  name(p) {
    const name = p.name ?? "玩家";
    if (
      typeof name !== "string" ||
      !name.trim() ||
      [...name.trim()].length > 12
    )
      throw new Error("请填写 1 至 12 个字的昵称。");
    return name.trim();
  }
  snapshot(sid) {
    if (!this.contains(sid)) return null;
    const time = this.clock(),
      r = this.room(sid);
    if (r.applicants[sid]) {
      const applicant = r.applicants[sid];
      applicant.seen = time;
      return {
        version: r.version,
        phase: "pending",
        mode: "multiplayer",
        viewer_id: null,
        catalog: catalog(),
        room_info: {
          code: r.code,
          host_name: r.members[r.host].name,
          is_host: false,
          pending_approval: true,
          applicant_name: applicant.name,
        },
      };
    }
    const viewer = r.members[sid];
    viewer.seen = r.last_seen = time;
    const state = r.game
      ? r.game.snapshot(viewer.player_id, { multiplayer: true })
      : {
          phase: "waiting",
          mode: "multiplayer",
          viewer_id: viewer.player_id,
          catalog: catalog(),
        };
    if (r.game) {
      state.history = state.history.filter(
        (h) => h.hand_number >= viewer.joined_hand,
      );
      if (state.result) state.result.match_over = !r.can_continue(true);
      for (const p of state.players) {
        const human = Object.entries(r.members).find(
          ([, m]) => m.player_id === p.id,
        );
        p.online = !!human && time - human[1].seen <= ONLINE_SECONDS;
        p.away = !!human?.[1].away;
        if (p.away && p.stack > 0) p.eliminated = false;
        if (p.strategy === "human")
          p.style = human?.[0] === r.host ? "房主" : "真人牌友";
      }
    }
    state.version = r.version;
    const eligible = r.readiness_members(),
      between = !r.game || r.game.table.hand.finished;
    const connection = r.recovering ? r.playing_members() : eligible;
    const waiting_connection = connection
      .filter((s) => time - r.members[s].seen > ONLINE_SECONDS)
      .map((s) => r.members[s].name);
    const waiting_ready = eligible
      .filter(
        (s) => !r.ready.has(s) && time - r.members[s].seen <= ONLINE_SECONDS,
      )
      .map((s) => r.members[s].name);
    const messages = [];
    if (between || r.recovering) {
      if (waiting_connection.length)
        messages.push(`等待 ${waiting_connection.join("、")} 重连`);
      if (between && waiting_ready.length)
        messages.push(`等待 ${waiting_ready.join("、")} 准备`);
      if (
        !r.game &&
        eligible.length +
          (r.fill_bots ? r.capacity - Object.keys(r.members).length : 0) <
          2
      )
        messages.push("至少两位未暂离的玩家或电脑才能开局");
      if (r.game && between && r.can_continue(true) && !r.can_continue())
        messages.push("等待暂离玩家返回，至少两位有筹码的玩家才能继续");
      if (viewer.away) messages.push("你已暂离，座位和筹码保留");
      if (!messages.length)
        messages.push(
          r.recovering ? "重连完成，即将恢复本手" : "大家已准备好，即将继续",
        );
    }
    const can_ready =
      between &&
      eligible.includes(sid) &&
      (r.ready.has(sid) ||
        !!r.game ||
        Object.keys(r.members).length >= 2 ||
        r.fill_bots);
    let remaining = r.deadline;
    if (r.game && !r.game.table.hand.finished) {
      const human = Object.values(r.members).find(
        (m) => m.player_id === r.game.table.hand.actor_id,
      );
      if (human && time - human.seen > ONLINE_SECONDS)
        remaining = Math.min(remaining, human.seen + DISCONNECT_SECONDS);
    }
    state.room_info = {
      code: r.code,
      capacity: r.capacity,
      fill_bots: r.fill_bots,
      bot_style: PROFILES[r.bot_strategy].style,
      is_host: r.host === sid,
      host_name: r.members[r.host].name,
      can_start: !r.game && can_ready,
      round_id: r.round_id,
      can_ready,
      ready: r.ready.has(sid),
      ready_count: eligible.filter((s) => r.ready.has(s)).length,
      ready_total: eligible.length,
      recovering: r.recovering,
      waiting_message: messages.join("；"),
      pending_approval: false,
      waiting_for_seat: viewer.player_id == null,
      away: viewer.away,
      recovery_code: viewer.recovery_code,
      starting_stack: r.game?.table.config.starting_stack || 2000,
      applications:
        sid === r.host
          ? Object.values(r.applicants).map((m) => ({
              id: m.member_id,
              name: m.name,
              online: time - m.seen <= ONLINE_SECONDS,
              can_approve: Object.keys(r.members).length < r.capacity,
            }))
          : [],
      waiting_for_connection: waiting_connection,
      waiting_for_ready: between ? waiting_ready : [],
      members: Object.entries(r.members).map(([s, m]) => ({
        id: m.member_id,
        player_id: m.player_id,
        name: m.name,
        is_you: s === sid,
        is_host: s === r.host,
        online: time - m.seen <= ONLINE_SECONDS,
        ready: r.ready.has(s),
        needs_ready: eligible.includes(s),
        waiting_for_seat: m.player_id == null,
        away: m.away,
        can_kick: sid === r.host && s !== sid,
      })),
      turn_seconds: r.turn_seconds,
      disconnect_seconds: DISCONNECT_SECONDS,
      remaining_seconds: remaining
        ? Math.max(0, Math.ceil(remaining - time))
        : 0,
      remaining_ms: remaining
        ? Math.max(0, Math.round((remaining - time) * 1000))
        : 0,
      notice: r.notice,
    };
    return state;
  }
  perform(sid, route, p) {
    this.perform_action(sid, route, p);
    this.on_change?.(this);
  }
  perform_action(sid, route, p) {
    const time = this.clock();
    if (route === "room/recover") {
      if (this.contains(sid))
        throw new Conflict("请先退出当前房间或撤回申请，再找回原座位。");
      if (
        typeof p.code !== "string" ||
        typeof p.recovery_code !== "string" ||
        !/^[\w-]{32}$/.test(p.recovery_code)
      )
        throw new Conflict("房间码或座位恢复码不正确。");
      const r = this.rooms[p.code.trim().toUpperCase()];
      const old =
        r &&
        Object.keys(r.members).find((s) =>
          timingSafeEqual(
            Buffer.from(r.members[s].recovery_code),
            Buffer.from(p.recovery_code),
          ),
        );
      if (!old) throw new Conflict("房间码或座位恢复码不正确。");
      const member = r.members[old];
      r.members = Object.fromEntries(
        Object.entries(r.members).map(([s, m]) => [s === old ? sid : s, m]),
      );
      delete this.membership[old];
      this.membership[sid] = r.code;
      if (r.ready.delete(old)) r.ready.add(sid);
      if (r.host === old) r.host = sid;
      r.banned.add(old);
      member.seen = time;
      member.recovery_code = token();
      this.departures[old] = {
        code: r.code,
        message: "你的座位已在另一浏览器找回，当前页面已退出。",
      };
      delete this.departures[sid];
      r.notice = `${member.name} 已找回原座位。`;
      r.changed(time);
      return;
    }
    if (route === "room/create") {
      if (this.contains(sid)) throw new Conflict("请先退出当前好友房间。");
      const name = this.name(p),
        capacity = p.capacity ?? 4,
        fill = p.fill_bots ?? true,
        style = p.bot_strategy ?? "calling_station",
        seconds = p.turn_seconds ?? 90;
      if (!Number.isInteger(capacity) || capacity < 2 || capacity > 6)
        throw new Error("好友房支持 2 至 6 个座位。");
      if (typeof fill !== "boolean" || !Object.hasOwn(PROFILES, style))
        throw new Error("请选择有效的电脑补位设置。");
      if (![15, 30, 60, 90, 120].includes(seconds))
        throw new Error("思考时间请选择 15、30、60、90 或 120 秒。");
      if (Object.keys(this.rooms).length >= 64)
        throw new Conflict("当前房间太多，请稍后再试。");
      const code = this.new_code(),
        r = new Room(code, sid, capacity, fill, style, seconds);
      r.last_seen = time;
      r.members[sid] = new Member(name, time);
      this.rooms[code] = r;
      this.membership[sid] = code;
      delete this.departures[sid];
      return;
    }
    if (route === "room/join") {
      if (typeof p.code !== "string") throw new Error("请输入六位房间码。");
      const code = p.code.trim().toUpperCase(),
        r = this.rooms[code];
      if (code.length !== 6 || !r)
        throw new Conflict("没有找到房间，请核对房间码和访问地址。");
      if (this.contains(sid)) {
        if (this.membership[sid] === code) return;
        throw new Conflict("请先退出当前好友房间。");
      }
      if (r.banned.has(sid))
        throw new Conflict("你已被房主移出这个房间，暂不能重新加入。");
      const name = this.name(p);
      if (
        [...Object.values(r.members), ...Object.values(r.applicants)].some(
          (m) => m.name === name,
        )
      )
        throw new Conflict("房间里已有同名牌友，请换个昵称。");
      if (Object.keys(r.applicants).length >= 12)
        throw new Conflict("等待审批的人数较多，请稍后再申请。");
      r.applicants[sid] = new Member(name, time, null);
      this.membership[sid] = code;
      delete this.departures[sid];
      r.changed(time);
      return;
    }
    if (route === "room/leave" && !this.contains(sid)) return;
    const r = this.room(sid);
    if (p.room_code !== r.code)
      throw new Conflict("房间已更新，请按当前画面操作。");
    if (r.applicants[sid]) {
      if (route !== "room/leave")
        throw new Conflict("请等待房主批准入桌申请。");
      delete r.applicants[sid];
      delete this.membership[sid];
      r.changed(time);
      return;
    }
    if (["room/start", "next", "room/rematch"].includes(route)) {
      if (!Number.isInteger(p.round_id) || p.round_id !== r.round_id)
        throw new Conflict("准备阶段已更新，请确认当前牌局后再操作。");
    } else if (
      ![
        "room/leave",
        "room/kick",
        "room/approve",
        "room/reject",
        "room/away",
      ].includes(route) &&
      (!Number.isInteger(p.version) || p.version !== r.version)
    )
      throw new Conflict("房间已更新，请按当前画面操作。");
    r.members[sid].seen = r.last_seen = time;
    if (route === "room/leave") {
      this.remove_member(r, sid, time);
      return;
    }
    if (route === "room/away") {
      if (typeof p.away !== "boolean")
        throw new Error("暂离状态必须为 true 或 false。");
      const m = r.members[sid];
      if (m.away !== p.away) {
        m.away = p.away;
        r.ready.delete(sid);
        if (r.game?.table.hand.actor_id === m.player_id) r.turn_key = null;
        r.notice =
          `${m.name} ` +
          (p.away
            ? "已暂离，本手自动过牌或弃牌，下一手不发牌。"
            : "已返回，请准备后参与下一手。");
        r.changed(time);
      }
      return;
    }
    if (["room/approve", "room/reject"].includes(route)) {
      if (sid !== r.host) throw new Conflict("只有房主可以审批入桌申请。");
      const target = Object.keys(r.applicants).find(
        (s) => r.applicants[s].member_id === p.target_id,
      );
      if (!target) throw new Conflict("这份入桌申请已处理或已撤回。");
      if (route === "room/approve") {
        if (Object.keys(r.members).length >= r.capacity)
          throw new Conflict("真人座位已满，请先移出一位玩家再批准。");
        const m = r.applicants[target];
        delete r.applicants[target];
        m.player_id = r.game ? null : Object.keys(r.members).length;
        m.joined_hand = r.game ? r.game.table.hand_number + 1 : 1;
        r.members[target] = m;
        r.notice =
          `房主已批准 ${m.name} 入桌。` +
          (r.game ? "从下一手开始参与。" : "请准备后开局。");
      } else {
        delete r.applicants[target];
        delete this.membership[target];
        this.departures[target] = {
          code: r.code,
          message: "房主未批准本次入桌申请。",
        };
      }
      r.changed(time);
      return;
    }
    if (route === "room/kick") {
      if (sid !== r.host) throw new Conflict("只有房主可以移出玩家。");
      const target = Object.keys(r.members).find(
        (s) => r.members[s].member_id === p.target_id,
      );
      if (!target || target === sid)
        throw new Conflict("请选择房间中的其他玩家。");
      r.banned.add(target);
      this.remove_member(r, target, time, true);
      return;
    }
    if (["room/start", "next", "room/rematch"].includes(route)) {
      if (route === "room/start" && r.game)
        throw new Conflict("当前不在开局等候室。");
      if (
        route === "next" &&
        (!r.game?.table.hand.finished || !r.can_continue(true))
      )
        throw new Conflict("当前不能准备下一手。");
      if (
        route === "room/rematch" &&
        (!r.game?.table.hand.finished || r.can_continue(true))
      )
        throw new Conflict("整桌结束后才能共同确认重新组桌。");
      if (!r.readiness_members().includes(sid))
        throw new Conflict(
          "你已暂离或筹码已用尽，可以继续观战，无需准备下一手。",
        );
      const ready = p.ready ?? true;
      if (typeof ready !== "boolean")
        throw new Error("准备状态必须为 true 或 false。");
      if (ready && !r.game && Object.keys(r.members).length < 2 && !r.fill_bots)
        throw new Conflict("至少需要两位玩家，或者开启电脑补位。");
      if (ready) r.ready.add(sid);
      else r.ready.delete(sid);
      r.notice = "等待所有参与玩家确认；准备后也可以取消。";
      this.advance_if_ready(r, time);
    } else if (route === "action") {
      if (!r.game) throw new Conflict("大家还没有全部准备好。");
      if (r.recovering) throw new Conflict("本手已恢复，等待玩家重连后继续。");
      if (r.members[sid].away) throw new Conflict("你已暂离，请先回到牌桌。");
      if (r.members[sid].player_id == null)
        throw new Conflict("你将从下一手入座，本手请先观战。");
      r.game.table.apply_action(r.members[sid].player_id, {
        kind: p.kind,
        amount: p.amount,
      });
    } else
      throw new Conflict("好友房的电脑由服务器统一推进，请等待当前玩家行动。");
    r.changed(time);
  }
  remove_member(r, sid, time, kicked = false) {
    const m = r.members[sid];
    delete r.members[sid];
    r.ready.delete(sid);
    delete this.membership[sid];
    if (kicked)
      this.departures[sid] = { code: r.code, message: "你已被房主移出房间。" };
    if (!Object.keys(r.members).length) {
      for (const s of Object.keys(r.applicants)) {
        delete this.membership[s];
        this.departures[s] = {
          code: r.code,
          message: "房间已关闭，入桌申请已取消。",
        };
      }
      delete this.rooms[r.code];
      return;
    }
    if (r.host === sid) r.host = Object.keys(r.members)[0];
    r.notice = `${m.name} ${kicked ? "被房主移出" : "已离开"}房间。`;
    if (r.game && m.player_id != null) {
      r.game.strategies[m.player_id] = "calling_station";
      r.game.bots[m.player_id] = make_bot("calling_station");
      if (r.game.table.hand.actor_id === m.player_id) r.turn_key = null;
      r.notice += "该座位由电脑接替。";
    }
    this.advance_if_ready(r, time);
    r.changed(time);
  }
  advance_if_ready(r, time) {
    const eligible = r.readiness_members();
    if (
      !eligible.length ||
      eligible.some(
        (s) => !r.ready.has(s) || time - r.members[s].seen > ONLINE_SECONDS,
      )
    )
      return false;
    if (!r.game) {
      if (
        eligible.length +
          (r.fill_bots ? r.capacity - Object.keys(r.members).length : 0) <
        2
      )
        return false;
      const members = Object.values(r.members),
        names = members.map((m) => m.name),
        styles = members.map(() => "human");
      if (r.fill_bots)
        for (let i = 0, count = r.capacity - names.length; i < count; i++) {
          names.push(`${PROFILES[r.bot_strategy].name} AI${i + 1}`);
          styles.push(r.bot_strategy);
        }
      const game = new BrowserGame();
      game.strategies = styles;
      game.room = "好友同桌";
      game.table = new Table(names);
      game.table.sitting_out = new Set(
        members.flatMap((m, i) => (m.away ? [i] : [])),
      );
      styles.forEach((s, i) => {
        if (s !== "human") game.bots[i] = make_bot(s);
      });
      game.table.start_hand();
      members.forEach((m, i) => {
        m.player_id = i;
        m.joined_hand = 1;
      });
      r.game = game;
      r.notice = "大家都准备好了，开始第一手。";
    } else if (r.game.table.hand.finished) {
      if (!r.can_continue(true)) {
        r.game = null;
        Object.values(r.members).forEach((m, i) => {
          m.player_id = i;
          m.joined_hand = 1;
        });
        r.notice = "大家同意重新组桌，已返回等候室。";
      } else {
        if (!r.can_continue()) return false;
        const game = r.game;
        for (const [sid, seat] of r.seating_plan()) {
          const m = r.members[sid];
          game.table.players[seat] = {
            player_id: seat,
            name: m.name,
            stack: game.table.config.starting_stack,
          };
          game.strategies[seat] = "human";
          delete game.bots[seat];
          delete game.player_wins[seat];
          delete game.player_hands[seat];
          m.player_id = seat;
          m.joined_hand = game.table.hand_number + 1;
        }
        game.table.sitting_out = new Set(
          Object.values(r.members)
            .filter((m) => m.away && m.player_id != null)
            .map((m) => m.player_id),
        );
        game.table.start_hand();
        r.notice = "全员准备，新一手开始。";
      }
    } else return false;
    r.reset_ready();
    return true;
  }
  tick() {
    const versions = JSON.stringify(
        Object.values(this.rooms).map((r) => [r.code, r.version]),
      ),
      time = this.clock();
    for (const r of Object.values(this.rooms)) {
      if (time - r.last_seen > 86400) {
        for (const sid of [
          ...Object.keys(r.members),
          ...Object.keys(r.applicants),
        ])
          delete this.membership[sid];
        delete this.rooms[r.code];
        continue;
      }
      if (time - r.members[r.host].seen > HOST_TIMEOUT) {
        const replacement = Object.keys(r.members).find(
          (s) => time - r.members[s].seen <= ONLINE_SECONDS,
        );
        if (replacement) {
          r.host = replacement;
          r.notice = `原房主暂时离线，${r.members[replacement].name} 接任房主。`;
          r.changed(time);
        }
      }
      if (r.recovering) {
        if (
          r
            .playing_members()
            .some((s) => time - r.members[s].seen > ONLINE_SECONDS)
        )
          continue;
        r.recovering = false;
        r.turn_key = null;
        r.notice = "玩家已重连，继续恢复的这一手。";
        r.changed(time);
      }
      if (this.advance_if_ready(r, time)) r.changed(time);
      if (!r.game || r.game.table.hand.finished) continue;
      r.arm_turn(time);
      const h = r.game.table.hand,
        actor = h.actor_id,
        member = Object.values(r.members).find((m) => m.player_id === actor);
      const disconnected =
        !r.game.bots[actor] &&
        member &&
        time - member.seen >= DISCONNECT_SECONDS;
      if (time < r.deadline && !disconnected) continue;
      const observation = h.observe(actor);
      let action = { kind: observation.legal.check ? "check" : "fold" };
      if (r.game.bots[actor]) {
        try {
          action = r.game.bots[actor].choose_action(observation);
        } catch {
          /* fall back to a free action */
        }
      } else
        r.notice = `${r.game.table.players[actor].name} ${member?.away ? "暂离牌桌" : disconnected ? "离线超过 12 秒" : `超过 ${r.turn_seconds} 秒未操作`}，自动${action.kind === "check" ? "过牌" : "弃牌"}。`;
      r.game.table.apply_action(actor, action);
      r.changed(time);
    }
    if (
      versions !==
        JSON.stringify(
          Object.values(this.rooms).map((r) => [r.code, r.version]),
        ) ||
      time - this.last_checkpoint >= 10
    ) {
      this.on_change?.(this);
      this.last_checkpoint = time;
    }
  }
}
