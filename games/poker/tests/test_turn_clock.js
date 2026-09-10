"use strict";
// Exercise the actual clock and notification logic without a browser or UI automation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
let now = 1000;
const classes = new Set();
const badge = {dataset:{turnCountdown:"0"}, setAttribute() {}, closest() { return {classList:{toggle(name, on) { on ? classes.add(name) : classes.delete(name); }}}; }};
const context = vm.createContext({
  performance:{now:() => now},
  document:{querySelectorAll:() => [badge]},
  events:[],
});
// Load declarations only; keep network requests and page event wiring out of unit tests.
vm.runInContext(source.slice(0, source.indexOf('$("player-name").value =')), context);
vm.runInContext('const originalSound = playSound; playSound = (kind) => events.push(kind);', context);
const snapshot = {server_id:"old", mode:"multiplayer", phase:"playing", version:1, viewer_id:0,
  actor_id:0, action_number:0, hand_number:1, room_info:{code:"ABCDEF", round_id:1, remaining_ms:30000, recovering:false},
  players:[{id:0, name:"玩家", strategy:"human"}]};
function accept(data) { context.snapshot = structuredClone(data); vm.runInContext("acceptState(snapshot); renderCountdown();", context); }
accept(snapshot);
assert.equal(badge.textContent, "30s");
assert.deepEqual(Array.from(context.events), ["turn"]);
for (let i = 0; i < 5; i++) accept({...snapshot, version:2});
assert.equal(context.events.length, 1, "Membership versions/polls must not repeat the turn sound");
now += 24999;
vm.runInContext("renderCountdown()", context);
assert.equal(badge.textContent, "6s");
assert.equal(classes.has("turn-urgent"), false);
now += 1;
vm.runInContext("renderCountdown()", context);
assert.equal(badge.textContent, "5s");
assert.equal(classes.has("turn-urgent"), true);
vm.runInContext("offline = true; renderCountdown()", context);
assert.equal(badge.textContent, "Ⅱ");
assert.equal(classes.has("turn-urgent"), false);
vm.runInContext("offline = false", context);
accept({...snapshot, room_info:{...snapshot.room_info, recovering:true, remaining_ms:0}});
assert.equal(context.events.length, 1);
assert.equal(badge.textContent, "Ⅱ");
accept({...snapshot, server_id:"restarted"});
assert.equal(context.events.length, 2, "A resumed turn is a new notification");
accept({...snapshot, action_number:1, actor_id:1});
assert.equal(badge.hidden, true);
accept({...snapshot, action_number:2});
assert.equal(context.events.length, 3, "The player's following turn must notify");
accept({...snapshot, phase:"finished"});
assert.equal(badge.hidden, true);
const beforeObserver = context.events.length;
accept({...snapshot, viewer_id:null, room_info:{...snapshot.room_info, waiting_for_seat:true}});
assert.equal(vm.runInContext("viewerId()", context), null, "An unseated observer must never be treated as player zero");
assert.equal(context.events.length, beforeObserver, "Observers must not receive player zero's turn notification");
accept({phase:"pending", viewer_id:null, mode:"multiplayer", room_info:{code:"ABCDEF", pending_approval:true}});
assert.equal(badge.hidden, true);
vm.runInContext('let audioStarts = 0; sound = false; window = {AudioContext:function() { audioStarts++; throw new Error("No audio backend in unit tests"); }}; originalSound("turn")', context);
assert.equal(vm.runInContext("audioStarts", context), 0, "Muted audio must never be created");
console.log("Countdown, final-five warning, pause, turn deduplication and mute checks passed.");
