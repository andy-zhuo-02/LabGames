"use strict";
// Unit tests against production functions, using small element stubs, not a browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const nodes = new Map(), storage = new Map();
function element(id) {
  if (!nodes.has(id)) nodes.set(id, {writes:0, value:"", markup:"", querySelectorAll:() => [],
    get innerHTML() { return this.markup; }, set innerHTML(value) { this.markup = value; this.writes++; },
    setAttribute() {}, classList:{toggle() {}}});
  return nodes.get(id);
}
const context = vm.createContext({
  performance:{now:() => 1000},
  document:{getElementById:element, querySelectorAll:() => []},
  localStorage:{getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v)},
  notices:[], sounds:[],
});
vm.runInContext(source.slice(0, source.indexOf('$("player-name").value =')), context);
vm.runInContext("notify = text => notices.push(text); playSound = kind => sounds.push(kind)", context);
const run = code => vm.runInContext(code, context);
const initial = {server_id:"server", version:1, mode:"multiplayer", phase:"playing", viewer_id:0,
  actor_id:0, action_number:0, hand_number:1, pot:30, hand_type:"", history:[],
  players:[{id:0, name:"我", stack:1990, bet:10, cards:["As", "Ad"]}],
  legal:{fold:true, check:false, call_amount:10, min_raise_to:40, max_raise_to:2000, all_in:true},
  room_info:{code:"ABCDEF", round_id:1, remaining_ms:30000, waiting_message:"", applications:[]}};
function accept(snapshot) { context.snapshot = structuredClone(snapshot); run("acceptState(snapshot)"); }
accept(initial);
run("renderControls(); setRaise(240)");
const writes = element("controls").writes;
assert.equal(run("raiseTo"), 240);
// Simulate incomplete typing before onchange; even that draft must survive a room poll.
element("raise-number").value = "275";
accept({...initial, version:2, room_info:{...initial.room_info, applications:[{id:"request", name:"朋友"}]}});
run("renderControls()");
assert.equal(element("controls").writes, writes, "A join request must not rebuild betting controls");
assert.equal(element("raise-number").value, "275", "Keep the uncommitted input and focused element");
assert.equal(run("raiseTo"), 240);
element("raise-number").onchange({target:{value:"275"}});
assert.equal(run("raiseTo"), 275);
for (let i = 0; i < 5; i++) {
  accept({...initial, version:3, room_info:{...initial.room_info, applications:[{id:"request", name:"朋友"}]}});
  run("renderControls()");
}
assert.equal(element("controls").writes, writes);
assert.equal(context.notices.length, 1, "The same pending request should only notify once");
assert.equal(context.sounds.length, 1, "Unrelated membership changes cannot repeat the turn sound");
const sameScope = run("actionScope()");
accept({...initial, version:999});
assert.equal(run("actionScope()"), sameScope, "All-in confirmation survives membership versions");
accept({...initial, action_number:4});
run("renderControls()");
assert.notEqual(run("actionScope()"), sameScope, "Confirmation expires after the real action changes");
assert.equal(run("raiseTo"), 40, "A new decision resets to its legal minimum");
run("setRaise(300)");
accept({...initial, action_number:4, legal:{...initial.legal, max_raise_to:100}});
run("renderControls()");
assert.equal(run("raiseTo"), 100, "A changed legal bound clamps the previous selection");
for (const change of [{server_id:"restart"}, {viewer_id:1}, {hand_number:2}, {room_info:{...initial.room_info, round_id:2}}]) {
  accept({...initial, ...change});
  assert.notEqual(run("actionScope()"), sameScope);
}
// Local history stores only room codes, and tolerates missing/corrupt storage.
for (const code of ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE", "FFFFFF"]) run(`rememberRoom("${code}")`);
assert.equal(run("recentRooms().length"), 5);
run('rememberRoom("CCCCCC")');
assert.equal(run("recentRooms()[0].code"), "CCCCCC");
assert.equal(run('recentRooms().filter(r => r.code === "CCCCCC").length'), 1);
assert.ok([...storage.values()].every(value => !value.includes("recovery_code")));
storage.set("river.rooms", "invalid json");
assert.equal(run("recentRooms().length"), 0);

const history = [{hand_number:1, profit:20, winners:["我"], board:["2s","3s","4s","5s","6s"],
  details:{payouts:[{label:"主池", awards:[{name:"我", amount:40}], participants:["我","朋友"], reason:"同花顺胜出"}],
    shown_hands:[{name:"我", player_id:0, cards:["As","Ad"], best_cards:["2s","3s","4s","5s","6s"], comparison:"6 高同花顺"}],
    actions:[{street:"河牌", player:"我", description:"过牌"}],
    stacks:[{id:0, name:"我", stack:2020}, {id:1, name:"朋友", stack:1980}]}}];
accept({...initial, history});
run("renderHistory()");
const historyWrites = element("history").writes;
assert.ok(element("history").innerHTML.includes("最佳五张"));
assert.ok(element("chip-chart").innerHTML.includes("2020"));
accept({...initial, version:4, history});
run("renderHistory()");
assert.equal(element("history").writes, historyWrites, "Polling must not collapse an opened replay");
element("history").querySelectorAll = () => [{dataset:{hand:"1"}}];
run("privacy = true; renderHistory()");
assert.match(element("history").innerHTML, /data-hand="1" open/);
assert.ok(element("history").innerHTML.includes("private-cards"));
assert.ok(element("history").innerHTML.includes("胜负比较已隐藏"));
assert.ok(element("history").innerHTML.includes("private-back"));
accept({...initial, history:[{hand_number:0, profit:0, winners:["朋友"], board:[]}]});
run("renderHistory()");
assert.ok(element("history").innerHTML.includes("旧存档"));

// Catch missing/duplicate static IDs without loading or inspecting a browser DOM.
const htmlIds = [...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, "Static element IDs must be unique");
const knownIds = new Set([...htmlIds, ...[...source.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1])]);
const missing = [...source.matchAll(/\$\("([\w-]+)"\)/g)].map(m => m[1]).filter(id => !knownIds.has(id));
assert.deepEqual(missing, [], "Every literal element reference needs a static or generated element");
console.log("Bet selection/draft stability, action confirmation scope, request deduplication, recent rooms, replay/privacy and element references passed.");
