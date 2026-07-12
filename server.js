/**
 * 길드 지렁이 게임 - 실시간 멀티플레이 서버 (권위 서버 방식)
 *
 * 모든 위치/충돌/점수 계산은 여기서만 일어난다. 클라이언트는 입력(마우스 각도, 부스트)만
 * 보내고, 서버가 계산한 결과(state)를 받아서 그리기만 한다. => 클라이언트 조작으로
 * 점수를 위조할 수 없는 구조.
 *
 * 방 시스템: 방 하나에 최대 15명(실제 유저) + AI 지렁이 5마리 상주.
 *           실유저가 0명이 되면 방을 없앤다.
 *
 * 점수 규칙:
 *   - 정상입장(mode=paid): 일반먹이/골드먹이/처치드랍 전부 100% 점수 인정
 *   - 무료입장(mode=free) : 먹이는 크기만 커지고 점수 0. 처치드랍만 10% 점수 인정
 *   - 크기(mass)는 모드 무관 항상 100% 성장 (재미 요소는 누구나 동일)
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "guild1234";
const PORT = process.env.PORT || 3000;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const COLLECTION_ADDRESS = "GtX6UQ1E4QXCwvYkMzweoVeCC5PrpaQrw4xfeZxSvvVy"; // Punky Kongz

const WORLD_SIZE = 4000;
const ROOM_MAX_PLAYERS = 15;
const BOT_COUNT = 5;
const FOOD_TARGET = 320;
const GOLD_FOOD_CHANCE = 0.1; // 골드먹이 스폰 비율
const TICK_MS = 66; // 15 tick/sec (15명 대비 트래픽 1/3)
const BASE_SPEED = 6;    // 체감속도 상향 (루즈함 해결)
const BOOST_SPEED = 10;
const TURN_RATE = 0.22; // 초당 각도 보정 비율
const START_MASS = 20;
const KILL_DROP_RATIO = 0.7; // 죽으면 보유량의 70%를 흩뿌림
const FREE_MODE_KILL_RATE = 0.1; // 무료입장 처치점수 10%만 인정
const MIN_PLAY_SECONDS = 30; // 이 미만이면 점수 미지급(어뷰징 방지)

const BUFF_EFFECT = {
  magnet: { pickupRadiusMul: 1.8 },
  size: { startMassBonus: 60 },
  shield: { shieldCount: 1 },
};

// 특수 아이템 (랜덤 등장/소멸, 좋은 것과 나쁜 것)
const ITEM_TYPES = {
  diamond: { glyph: "💎", good: true },   // 점수 +30, 몸 +12
  boost:   { glyph: "⚡", good: true },   // 5초 스피드업 (질량 소모 없음)
  magnet:  { glyph: "🧲", good: true },   // 8초 자석 범위 2배
  shroom:  { glyph: "🍄", good: false },  // 몸 20% 감소
  snail:   { glyph: "🐌", good: false },  // 5초 느려짐
};
const ITEM_KEYS_GOOD = ["diamond", "boost", "magnet"];
const ITEM_KEYS_BAD = ["shroom", "snail"];
const ITEM_MAX_PER_ROOM = 6;
const ITEM_TTL_MS = [12000, 18000]; // 수명 12~18초 (끝나기 전 깜빡임)
const DIAMOND_SCORE = 30;
const DIAMOND_MASS = 12;

// ===== Apps Script 연동 =====
const TEST_MODE = process.env.TEST_MODE === "1"; // 1이면 시트에 기록 안 함 (테스트용)
async function callBackend(action, name, arg) {
  if (TEST_MODE && (action === "game_enter" || action === "game_end" || action === "city_stage")) {
    return null; // 테스트 중: 참가비/정산을 시트에 기록하지 않음
  }
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("여기에") === 0) {
    console.warn("[경고] APPS_SCRIPT_URL 미설정 - 백엔드 호출 생략 (테스트 모드)");
    return null;
  }
  const url = `${APPS_SCRIPT_URL}?token=${encodeURIComponent(BOT_TOKEN)}&action=${encodeURIComponent(action)}&name=${encodeURIComponent(name)}&arg=${encodeURIComponent(arg || "")}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    return text;
  } catch (e) {
    console.error("백엔드 호출 실패:", e.message);
    return null;
  }
}

// 게임 입장: 참가비+버프 차감을 서버(우리)가 대신 요청. 실패/미설정 시 기본 무료모드로 처리
async function enterGame(name, wantBuffs) {
  const raw = await callBackend("game_enter", name, wantBuffs.join(","));
  if (!raw) {
    return { ok: true, mode: "free", buffs: [], nft: 0, point: 0 }; // 테스트 모드 기본값
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { ok: false, message: raw };
  }
}

async function submitScore(name, score, label) {
  if (score <= 0) return;
  await callBackend("game_end", name, String(Math.floor(score)) + "|" + (label || "지렁이게임"));
}

// ===== 유틸 =====
function rand(min, max) { return Math.random() * (max - min) + min; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function angleDiff(a, b) { let d = (b - a + Math.PI * 3) % (Math.PI * 2) - Math.PI; return d; }
function radiusFromMass(mass) { return 6 + Math.sqrt(mass) * 1.1; }
function segCountFromMass(mass) { return Math.max(6, Math.floor(mass / 4)); }

let roomCounter = 1;

class Snake {
  constructor(id, name, isBot, mode, buffs, nft) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.mode = mode; // 'paid' | 'free' | 'bot'
    this.buffs = buffs || [];
    this.nft = nft || 0;

    let mass = START_MASS;
    if (this.buffs.indexOf("size") >= 0) mass += BUFF_EFFECT.size.startMassBonus;
    this.mass = mass;
    this.score = 0; // 포인트로 환산될 "정산 점수"
    this.kills = 0;
    this.shieldLeft = this.buffs.indexOf("shield") >= 0 ? BUFF_EFFECT.shield.shieldCount : 0;
    this.pickupRadiusMul = this.buffs.indexOf("magnet") >= 0 ? BUFF_EFFECT.magnet.pickupRadiusMul : 1;

    this.x = rand(200, WORLD_SIZE - 200);
    this.y = rand(200, WORLD_SIZE - 200);
    this.angle = rand(0, Math.PI * 2);
    this.targetAngle = this.angle;
    this.boosting = false;
    this.alive = true;
    this.path = [{ x: this.x, y: this.y }]; // 머리 이동 궤적(몸통은 여기서 파생)
    this.joinedAt = Date.now();
    // 아이템 효과 (만료 시각 ms)
    this.itemBoostUntil = 0;
    this.itemSlowUntil = 0;
    this.itemMagnetUntil = 0;

    if (isBot) {
      this.botRetargetAt = 0;
    }
  }

  get radius() { return radiusFromMass(this.mass); }
  get speed() {
    const now = Date.now();
    let s = this.boosting && this.mass > START_MASS * 0.6 ? BOOST_SPEED : BASE_SPEED;
    if (now < this.itemBoostUntil) s *= 1.45; // ⚡ 부스트젤리
    if (now < this.itemSlowUntil) s *= 0.55;  // 🐌 슬라임
    return s;
  }
  get effectivePickupMul() {
    return this.pickupRadiusMul * (Date.now() < this.itemMagnetUntil ? 2 : 1); // 🧲
  }

  segments() {
    const count = segCountFromMass(this.mass);
    const step = Math.max(1, Math.floor(this.path.length / count));
    const out = [];
    for (let i = 0; i < this.path.length; i += step) out.push(this.path[i]);
    return out.slice(0, count);
  }
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map(); // socketId -> Snake
    this.bots = [];
    this.food = new Map(); // foodId -> {id,x,y,value,gold,fromKill}
    this.items = new Map(); // itemId -> {id,x,y,type,expiresAt}
    this.nextFoodId = 1;
    this.nextItemId = 1;
    this.nextItemSpawnAt = Date.now() + 3000;
    this.createdAt = Date.now();
    for (let i = 0; i < BOT_COUNT; i++) this.spawnBot();
    this.fillFood();
  }

  spawnItem() {
    if (this.items.size >= ITEM_MAX_PER_ROOM) return;
    const good = Math.random() < 0.6;
    const keys = good ? ITEM_KEYS_GOOD : ITEM_KEYS_BAD;
    const type = keys[Math.floor(Math.random() * keys.length)];
    const id = this.nextItemId++;
    this.items.set(id, {
      id, type,
      x: rand(120, WORLD_SIZE - 120),
      y: rand(120, WORLD_SIZE - 120),
      expiresAt: Date.now() + rand(ITEM_TTL_MS[0], ITEM_TTL_MS[1]),
    });
  }

  spawnBot() {
    const bot = new Snake("bot_" + Math.random().toString(36).slice(2, 8), "AI지렁이", true, "bot", [], 0);
    this.bots.push(bot);
  }

  fillFood() {
    while (this.food.size < FOOD_TARGET) this.spawnFood();
  }

  spawnFood(x, y, value, fromKill) {
    const id = this.nextFoodId++;
    const gold = value ? false : Math.random() < GOLD_FOOD_CHANCE;
    this.food.set(id, {
      id,
      x: x != null ? x : rand(50, WORLD_SIZE - 50),
      y: y != null ? y : rand(50, WORLD_SIZE - 50),
      value: value != null ? value : (gold ? 5 : 1),
      gold: !!gold && !value,
      fromKill: !!fromKill,
    });
  }

  realPlayerCount() {
    let n = 0;
    for (const s of this.players.values()) if (s.alive || true) n++;
    return n;
  }
}

const rooms = new Map();

function findJoinableRoom() {
  for (const room of rooms.values()) {
    if (room.players.size < ROOM_MAX_PLAYERS) return room;
  }
  const room = new Room("room-" + roomCounter++);
  rooms.set(room.id, room);
  return room;
}

function roomList() {
  return Array.from(rooms.values()).map((r) => ({ id: r.id, count: r.players.size, max: ROOM_MAX_PLAYERS }));
}

// ===== 게임 루프 =====
function stepSnake(snake, room, dtSec) {
  if (!snake.alive) return;

  // 각도 보간 (급격한 회전 방지, 자연스러운 조향)
  const diff = angleDiff(snake.angle, snake.targetAngle);
  snake.angle += diff * Math.min(1, TURN_RATE * (dtSec * 20));

  const spd = snake.speed;
  snake.x += Math.cos(snake.angle) * spd;
  snake.y += Math.sin(snake.angle) * spd;

  // 월드 경계
  snake.x = Math.max(10, Math.min(WORLD_SIZE - 10, snake.x));
  snake.y = Math.max(10, Math.min(WORLD_SIZE - 10, snake.y));

  snake.path.unshift({ x: snake.x, y: snake.y });
  const maxLen = segCountFromMass(snake.mass) * 3 + 10;
  if (snake.path.length > maxLen) snake.path.length = maxLen;

  // 부스트하면 질량 살짝 소모 (자기 몸에서 미세하게 먹이 떨어뜨림)
  if (snake.boosting && snake.mass > START_MASS * 0.6) {
    snake.mass -= 0.05;
    if (Math.random() < 0.15) room.spawnFood(snake.x, snake.y, 1, false);
  }
}

function botAI(bot, room, now) {
  if (!bot.alive) return;
  if (now < bot.botRetargetAt) return;
  bot.botRetargetAt = now + rand(350, 800); // 더 자주 판단 (똑똑하게)
  bot.boosting = false;

  const snakes = allSnakes(room);

  // 1) 진행 방향 앞에 남의 몸통이 있으면 급회피 (최우선)
  const aheadX = bot.x + Math.cos(bot.angle) * 100;
  const aheadY = bot.y + Math.sin(bot.angle) * 100;
  for (const s of snakes) {
    if (s === bot || !s.alive) continue;
    const segs = s.segments();
    for (let i = 1; i < segs.length; i++) {
      const rr = (s.radius * 1.7);
      if (dist2(aheadX, aheadY, segs[i].x, segs[i].y) < rr * rr) {
        bot.targetAngle = bot.angle + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + rand(0, 0.5));
        return;
      }
    }
  }

  // 2) 위협/사냥감 스캔
  let flee = null, fleeD = Infinity, prey = null, preyD = Infinity;
  for (const s of snakes) {
    if (s === bot || !s.alive) continue;
    const d = dist2(bot.x, bot.y, s.x, s.y);
    if (s.mass > bot.mass * 1.25 && d < 280 * 280 && d < fleeD) { flee = s; fleeD = d; }
    if (s.mass < bot.mass * 0.7 && d < 340 * 340 && d < preyD) { prey = s; preyD = d; }
  }

  if (flee) {
    // 큰 놈에게서 도망 (부스트!)
    bot.targetAngle = Math.atan2(bot.y - flee.y, bot.x - flee.x);
    bot.boosting = bot.mass > START_MASS * 1.5;
  } else if (prey && Math.random() < 0.7) {
    // 작은 놈 사냥: 머리 진행 방향 앞을 가로채기
    const px = prey.x + Math.cos(prey.angle) * 70;
    const py = prey.y + Math.sin(prey.angle) * 70;
    bot.targetAngle = Math.atan2(py - bot.y, px - bot.x);
    bot.boosting = bot.mass > START_MASS * 2 && Math.random() < 0.6;
  } else {
    // 3) 좋은 아이템 > 골드/드랍 먹이 > 일반 먹이 순으로 탐색
    let target = null, best = Infinity;
    for (const it of room.items.values()) {
      if (!ITEM_TYPES[it.type].good) continue;
      const d = dist2(bot.x, bot.y, it.x, it.y);
      if (d < best) { best = d; target = it; }
    }
    if (!target || best > 500 * 500) {
      best = Infinity;
      for (const f of room.food.values()) {
        let d = dist2(bot.x, bot.y, f.x, f.y);
        if (f.gold || f.fromKill) d *= 0.35; // 값진 먹이 선호
        if (d < best) { best = d; target = f; }
      }
    }
    if (target) {
      bot.targetAngle = Math.atan2(target.y - bot.y, target.x - bot.x);
    } else {
      bot.targetAngle = rand(0, Math.PI * 2);
    }
  }

  // 4) 벽 근처면 안쪽으로 (항상 최종 보정)
  if (bot.x < 220 || bot.x > WORLD_SIZE - 220 || bot.y < 220 || bot.y > WORLD_SIZE - 220) {
    bot.targetAngle = Math.atan2(WORLD_SIZE / 2 - bot.y + rand(-300, 300), WORLD_SIZE / 2 - bot.x + rand(-300, 300));
    bot.boosting = false;
  }
}

function allSnakes(room) {
  return [...room.players.values(), ...room.bots];
}

function handleFoodPickup(snake, room) {
  const pr = snake.radius * snake.effectivePickupMul + 12;
  for (const [fid, f] of room.food) {
    if (dist2(snake.x, snake.y, f.x, f.y) <= pr * pr) {
      room.food.delete(fid);
      snake.mass += f.value;

      let scoreGain = 0;
      if (f.fromKill) {
        scoreGain = snake.mode === "free" ? f.value * FREE_MODE_KILL_RATE : f.value;
      } else {
        scoreGain = snake.mode === "free" ? 0 : f.value;
      }
      snake.score += scoreGain;
    }
  }
  room.fillFood();

  // 특수 아이템 획득
  const now = Date.now();
  for (const [iid, it] of room.items) {
    if (dist2(snake.x, snake.y, it.x, it.y) > (pr + 6) * (pr + 6)) continue;
    room.items.delete(iid);
    if (it.type === "diamond") {
      snake.mass += DIAMOND_MASS;
      snake.score += snake.mode === "free" ? 0 : DIAMOND_SCORE;
    } else if (it.type === "boost") {
      snake.itemBoostUntil = now + 5000;
    } else if (it.type === "magnet") {
      snake.itemMagnetUntil = now + 8000;
    } else if (it.type === "shroom") {
      snake.mass = Math.max(START_MASS * 0.6, snake.mass * 0.8);
    } else if (it.type === "snail") {
      snake.itemSlowUntil = now + 5000;
    }
  }
}

function killSnake(victim, room, io) {
  victim.alive = false;
  const dropTotal = victim.mass * KILL_DROP_RATIO;
  const dropCount = Math.max(5, Math.min(40, Math.floor(dropTotal / 4)));
  const per = dropTotal / dropCount;
  for (let i = 0; i < dropCount; i++) {
    const ang = rand(0, Math.PI * 2);
    const r = rand(0, 60);
    room.spawnFood(victim.x + Math.cos(ang) * r, victim.y + Math.sin(ang) * r, per, true);
  }
}

function checkCollisions(room, io) {
  const snakes = allSnakes(room);
  for (const a of snakes) {
    if (!a.alive) continue;
    for (const b of snakes) {
      if (a === b || !b.alive) continue;
      // a의 머리가 b의 몸통에 닿으면 a 사망
      const segs = b.segments();
      const rSum = a.radius * 0.5 + b.radius * 0.6;
      for (let i = 2; i < segs.length; i++) { // 앞부분(머리 근처) 제외해서 정면충돌 오탐 완화
        if (dist2(a.x, a.y, segs[i].x, segs[i].y) <= rSum * rSum) {
          if (a.shieldLeft > 0) {
            a.shieldLeft -= 1;
            // 쉴드 소모: 살짝 뒤로 밀어내고 생존
            a.x -= Math.cos(a.angle) * 80;
            a.y -= Math.sin(a.angle) * 80;
          } else {
            if (!b.isBot) b.kills += 1;
            // PvP 강탈: 둘 다 실제 유저면 피해자 콩달러 일부가 킬러에게
            if (!a.isBot && !b.isBot && db.players[a.name] && a.name !== b.name) {
              const vic = db.players[a.name];
              const vStage = Math.min(30, Math.max(1, vic.stage || 1));
              const cap = Math.max(300, Math.floor((STAGE_THRESHOLDS[vStage] || 0) / 200)) * 3;
              const loot = Math.min(Math.floor(Math.max(0, vic.money || 0) * 0.05), cap);
              if (loot > 0) {
                vic.money -= loot;
                if (!db.players[b.name]) db.players[b.name] = {};
                db.players[b.name].money = (db.players[b.name].money || 0) + loot;
                markDirty();
                io.to(b.id).emit("loot", { amount: loot, from: a.name });
                io.to(a.id).emit("looted", { amount: loot, by: b.name });
              }
            }
            killSnake(a, room, io);
          }
          break;
        }
      }
    }
  }
}

function tick(io) {
  const now = Date.now();
  for (const room of rooms.values()) {
    const dt = TICK_MS / 1000;

    // 아이템 스폰/소멸 관리
    if (now >= room.nextItemSpawnAt) {
      room.spawnItem();
      room.nextItemSpawnAt = now + rand(4000, 9000);
    }
    for (const [iid, it] of room.items) if (now >= it.expiresAt) room.items.delete(iid);

    for (const bot of room.bots) botAI(bot, room, now);
    for (const s of allSnakes(room)) stepSnake(s, room, dt);
    checkCollisions(room, io);
    for (const s of allSnakes(room)) if (s.alive) handleFoodPickup(s, room);

    // 죽은 봇 리스폰
    room.bots = room.bots.filter((b) => b.alive);
    while (room.bots.length < BOT_COUNT) room.spawnBot();

    // 상태 브로드캐스트 (내가 접속중인 방에만)
    const snapshot = {
      food: Array.from(room.food.values()),
      items: Array.from(room.items.values()).map((it) => ({
        id: it.id, x: it.x, y: it.y, type: it.type,
        glyph: ITEM_TYPES[it.type].glyph, good: ITEM_TYPES[it.type].good,
        ttl: Math.max(0, it.expiresAt - now),
      })),
      snakes: allSnakes(room).map((s) => {
        let segs = s.segments();
        if (segs.length > 40) { const st = Math.ceil(segs.length / 40); segs = segs.filter((_, i) => i % st === 0); }
        return ({
        id: s.id, name: s.name, isBot: s.isBot, alive: s.alive,
        x: Math.round(s.x), y: Math.round(s.y), mass: Math.round(s.mass), radius: Math.round(s.radius),
        segments: segs.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })), shieldLeft: s.shieldLeft, mode: s.mode,
        fx: {
          b: Math.max(0, s.itemBoostUntil - now),
          m: Math.max(0, s.itemMagnetUntil - now),
          s: Math.max(0, s.itemSlowUntil - now),
        },
      }); }),
      worldSize: WORLD_SIZE,
    };
    io.to(room.id).emit("state", snapshot);
  }
}

// =====================================================================
// 펑키시티 (키우기) — 저장/조회/포인트 정산 API
// =====================================================================
const DATA_DIR = path.join(__dirname, "data");
const SAVE_FILE = path.join(DATA_DIR, "saves.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { players: {}, tower: { bricks: 0 } };
try {
  if (fs.existsSync(SAVE_FILE)) db = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
} catch (e) { console.warn("세이브 로드 실패, 새로 시작:", e.message); }

let saveDirty = false;
let backupDirty = false;
function markDirty() { saveDirty = true; backupDirty = true; }
setInterval(() => {
  if (!saveDirty) return;
  saveDirty = false;
  fs.writeFile(SAVE_FILE, JSON.stringify(db), (e) => { if (e) console.error("세이브 실패:", e.message); });
}, 5000);

// ===== 구글 시트 백업/복원 (무료 클라우드 재시작 대비) =====
async function backupToSheet() {
  if (TEST_MODE) return; // 테스트 중엔 시트 백업도 중지
  if (!backupDirty) return;
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("여기에") === 0) return;
  backupDirty = false;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: BOT_TOKEN, action: "idle_backup", data: JSON.stringify(db) }),
    });
    const text = await res.text();
    if (text.indexOf('"ok":true') < 0) console.warn("시트 백업 응답 이상:", text.slice(0, 120));
  } catch (e) { backupDirty = true; console.warn("시트 백업 실패:", e.message); }
}
setInterval(backupToSheet, 5 * 60 * 1000);

async function restoreFromSheet() {
  // 로컬 세이브가 없을 때(새 서버/재시작)만 시트에서 복원
  if (Object.keys(db.players).length > 0) return;
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("여기에") === 0) return;
  try {
    const url = `${APPS_SCRIPT_URL}?token=${encodeURIComponent(BOT_TOKEN)}&action=idle_restore&name=server`;
    const res = await fetch(url);
    const text = (await res.text()).trim();
    if (!text || text.indexOf("{") !== 0) return;
    const restored = JSON.parse(text);
    if (restored && restored.players) {
      db = restored;
      console.log(`시트 백업에서 복원 완료: 플레이어 ${Object.keys(db.players).length}명`);
    }
  } catch (e) { console.warn("시트 복원 실패(무시):", e.message); }
}
restoreFromSheet();

// 등급 임계값(누적 수익) / 등급 달성 포인트 보상 — 클라이언트와 동일해야 함 (24단계)
const STAGE_THRESHOLDS = [0,0,500,2500,12500,62500,312500,1562500,7812500,39062500,195312500,976562500,4882812500,24414062500,122070312500,610351562500,3051757812500,15258789062500,76293945312500,381469726562500,1907348632812500,9536743164062500,47683715820312496,238418579101562496,1192092895507812352,5960464477539061760,29802322387695308800,149011611938476556288,745058059692382748672,3725290298461913612288,18626451492309567537152];
const STAGE_REWARDS =    [0,0,10,18,26,34,42,50,58,66,74,82,90,98,106,114,122,130,138,146,154,162,170,178,186,194,202,210,218,226,234];
const DAILY_COLLECT_CAP = 100; // 일일 수금 상한 (포인트)

function todayStr() {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // KST
  return d.toISOString().slice(0, 10);
}

// 보유 NFT 번호 조회 (Helius, 10분 캐시)
const nftCache = new Map(); // wallet -> {ids, ts}
async function getOwnedTokenIds(wallet) {
  if (!wallet || !HELIUS_API_KEY) return [];
  const hit = nftCache.get(wallet);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.ids;
  const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  const ids = [];
  let page = 1;
  try {
    while (page <= 3) { // 최대 3000개면 충분
      const body = {
        jsonrpc: "2.0", id: "1", method: "getAssetsByOwner",
        params: { ownerAddress: wallet, page, limit: 1000, displayOptions: { showFungible: false } },
      };
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      const items = (json.result && json.result.items) || [];
      for (const it of items) {
        const grouping = it.grouping || [];
        const inColl = grouping.some((g) => g.group_key === "collection" && g.group_value === COLLECTION_ADDRESS);
        if (!inColl) continue;
        const nm = ((it.content || {}).metadata || {}).name || "";
        const m = nm.match(/#(\d+)/);
        if (m) ids.push(parseInt(m[1], 10));
      }
      if (items.length < 1000) break;
      page++;
    }
  } catch (e) { console.warn("Helius 조회 실패:", e.message); }
  ids.sort((a, b) => a - b);
  nftCache.set(wallet, { ids, ts: Date.now() });
  return ids;
}

function checkToken(req, res) {
  const t = (req.query.token || (req.body && req.body.token) || "").trim();
  if (t !== BOT_TOKEN) { res.status(403).json({ ok: false, error: "토큰 불일치" }); return false; }
  return true;
}

// ===== Express + Socket.io =====
const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/rooms", (req, res) => res.json(roomList()));

// 프로필: 시트(등록·NFT수·포인트) + 보유 NFT 번호(이미지용)
const TEST_WALLET = process.env.TEST_WALLET || "";
app.get("/api/profile", async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String(req.query.name || "").trim();
  if (!name) return res.json({ ok: false, error: "이름 없음" });
  let profile = { ok: true, registered: false, nft: 0, point: 0, wallet: "" };
  const raw = await callBackend("profile", name, "");
  if (raw) { try { profile = JSON.parse(raw); } catch (e) { /* 구버전 배포면 기본값 유지 */ } }
  // 지갑 미연동 유저: 테스트 지갑으로 콩즈 표시 (정식 오픈 때 TEST_WALLET 제거)
  if (!profile.wallet && TEST_WALLET) profile.wallet = TEST_WALLET;
  let tokenIds = [];
  if (profile.wallet) tokenIds = await getOwnedTokenIds(profile.wallet);
  // 시트 NFT 수량이 없으면(미연동/테스트) 지갑 실보유 수로 동료 보너스 계산
  if (!profile.nft && tokenIds.length) profile.nft = tokenIds.length;
  res.json({ ...profile, tokenIds: tokenIds.slice(0, 60), imageBase: "https://punkykongz.com/nft/punkykongz/image/" });
});

// 세이브 로드/저장
app.get("/api/idle/load", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String(req.query.name || "").trim();
  res.json({ ok: true, save: db.players[name] || null, tower: db.tower });
});

app.post("/api/idle/save", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim();
  const save = req.body.save;
  if (!name || typeof save !== "object") return res.json({ ok: false });
  const prev = db.players[name] || {};
  db.players[name] = { ...save, rewardedStage: prev.rewardedStage || save.rewardedStage || 1, lastCollectDate: prev.lastCollectDate || "" };
  markDirty();
  res.json({ ok: true });
});

// 등급 달성 보상 (서버가 누적수익 검증 후 포인트 지급)
app.post("/api/idle/stage", async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim();
  const p = db.players[name];
  if (!p) return res.json({ ok: false, error: "세이브 없음" });
  let granted = 0;
  let cur = p.rewardedStage || 1;
  while (cur + 1 < STAGE_THRESHOLDS.length && (p.lifetime || 0) >= STAGE_THRESHOLDS[cur + 1]) {
    cur++;
    granted += STAGE_REWARDS[cur] || 0;
  }
  if (granted <= 0) return res.json({ ok: true, granted: 0 });
  p.rewardedStage = cur;
  db.tower.bricks += 1;
  markDirty();
  // 출석 보너스용 시티등급 갱신 (환생 시 souls*30 누적 → 31,32...)
  callBackend("city_stage", name, String((p.souls || 0) * 30 + (p.stage || cur)));
  await submitScore(name, granted * GAME_SCORE_TO_POINT_INV, "등급보상"); // 아래 상수 참고
  res.json({ ok: true, granted, rewardedStage: cur, tower: db.tower });
});

// 일일 수금: 게임 자산 규모에 비례(로그 스케일), 하루 1회, 상한
app.post("/api/idle/collect", async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim();
  const p = db.players[name];
  if (!p) return res.json({ ok: false, error: "세이브 없음" });
  const today = todayStr();
  if (p.lastCollectDate === today) return res.json({ ok: false, error: "오늘은 이미 수금했어요! 내일 다시 오세요." });
  const assets = Math.max(0, p.money || 0);
  const points = Math.min(DAILY_COLLECT_CAP, Math.max(1, Math.floor(Math.log10(assets + 10) * 8)));
  p.lastCollectDate = today;
  db.tower.bricks += 1;
  markDirty();
  await submitScore(name, points * GAME_SCORE_TO_POINT_INV, "일일수금");
  res.json({ ok: true, points, tower: db.tower });
});

// =====================================================================
// AI 아바타 변신 (Gemini) — 등급에 맞는 콩즈 모습 생성 + 영구 캐싱
// =====================================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const AVATAR_DIR = path.join(__dirname, "public", "gen");
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_DAILY_CAP = 30; // 하루 생성 상한 (무료 티어 보호)
let avatarGen = { date: todayStr(), n: 0 };
const avatarPending = new Set();

// 등급별 의상/분위기 (콩즈 정체성은 유지, 차림새만 변신)
const STAGE_OUTFITS = [null,
  "a homeless beggar: tattered patched rags, holding a small begging bowl, gloomy night alley mood",
  "a cardboard collector: worn gloves and knit cap, rope over shoulder, stacked cardboard behind",
  "a street food vendor: cozy apron and paper hat, holding a fish-shaped bread snack",
  "a convenience store part-timer: mint-green store vest uniform with a name tag",
  "a delivery rider: helmet and delivery jacket, holding a delivery box",
  "a claw-machine arcade owner: casual hoodie, hugging a plush toy",
  "an office worker: neat shirt and tie with an employee ID lanyard",
  "a fried chicken shop owner: chef apron and cap, proudly holding fried chicken",
  "a PC-bang owner: gamer headset around neck, RGB monitor glow",
  "an e-commerce seller: warehouse vest, holding a parcel box",
  "a startup CEO: smart-casual blazer over a T-shirt",
  "a crypto mining tycoon: tech jacket, glowing GPU rigs behind",
  "a famous streamer: studio headphones and microphone, ring-light glow",
  "a building owner: fine long coat, holding golden building keys",
  "a Gangnam mall tycoon: sharp luxury suit with shopping bags",
  "a skyscraper owner: premium black suit, night city view behind",
  "a chaebol: luxurious silk robe and gold watch, mansion vibe",
  "a resort king: tropical shirt, sunglasses on head, holding a cocktail",
  "an art gallery director: black turtleneck and beret, artistic mood",
  "an entertainment mogul: flashy stage jacket, holding a microphone",
  "a penthouse chairman: royal purple suit with a golden ring",
  "an astronaut tycoon: white-gold space suit, helmet under arm",
  "a Mars pioneer: red-orange exploration suit, martian glow",
  "a space station owner: sleek white-gold station uniform with PKC patch",
  "an asteroid mining king: rugged heavy space mining suit with glowing drill",
  "an alien trade tycoon: exotic merchant robe with alien trinkets and galactic goods",
  "a galactic chaebol: cosmic luxury suit with starfield pattern and nebula glow",
  "a dimension pioneer: futuristic portal-tech cloak with swirling energy",
  "the Punkyverse emperor: holographic royal attire with digital crown",
  "the PUNKY KING: majestic golden royal robe and golden crown, radiant golden aura"];

function avatarFile(id, stage) { return path.join(AVATAR_DIR, `avatar_${id}_${stage}.png`); }

async function generateAvatar(id, stage) {
  const key = `${id}_${stage}`;
  if (avatarPending.has(key)) return;
  if (avatarGen.date !== todayStr()) avatarGen = { date: todayStr(), n: 0 };
  if (avatarGen.n >= AVATAR_DAILY_CAP) return;
  avatarPending.add(key);
  avatarGen.n++;
  try {
    // 원본 콩즈 이미지 (Helius CDN 리사이즈 → 실패 시 원본)
    const orig = `https://punkykongz.com/nft/punkykongz/image/${id}.jpg`;
    let imgRes = await fetch(`https://cdn.helius-rpc.com/cdn-cgi/image/width=512/${orig}`);
    if (!imgRes.ok) imgRes = await fetch(orig);
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    const prompt =
      `Transform this exact gorilla NFT character into ${STAGE_OUTFITS[stage]}. ` +
      "Keep the same gorilla's face, fur color, expression style and identity clearly recognizable. " +
      "Same premium 3D cartoon render style, bust portrait, centered, vivid solid color background " +
      "matching the mood, square composition, no text, no watermark.";

    const body = {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const json = await res.json();
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    for (const p of parts) {
      if (p.inlineData && p.inlineData.data) {
        fs.writeFileSync(avatarFile(id, stage), Buffer.from(p.inlineData.data, "base64"));
        console.log(`AI 아바타 생성: 콩즈#${id} 등급${stage} (오늘 ${avatarGen.n}/${AVATAR_DAILY_CAP})`);
        return;
      }
    }
    console.warn("아바타 생성 응답에 이미지 없음:", JSON.stringify(json).slice(0, 200));
  } catch (e) {
    console.warn("아바타 생성 실패:", e.message);
  } finally {
    avatarPending.delete(key);
  }
}

// 아바타 변신 이미지 조회 (없으면 백그라운드 생성 시작)
app.get("/api/avatar-url", (req, res) => {
  if (!checkToken(req, res)) return;
  const id = parseInt(req.query.id, 10);
  const stage = Math.min(24, Math.max(1, parseInt(req.query.stage, 10) || 1));
  if (!id || !GEMINI_API_KEY) return res.json({ ok: false });
  const file = avatarFile(id, stage);
  if (fs.existsSync(file)) return res.json({ ok: true, ready: true, url: `/gen/avatar_${id}_${stage}.png` });
  generateAvatar(id, stage); // 비동기 시작 (기다리지 않음)
  res.json({ ok: true, ready: false });
});

// 광고 보상: 하루 5회 제한 (서버가 횟수 관리)
const AD_DAILY_CAP = 1; // 트윗 참여 보너스: 하루 1회
app.post("/api/ad/watch", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim();
  if (!name) return res.json({ ok: false });
  if (!db.players[name]) db.players[name] = {};
  const p = db.players[name];
  const today = todayStr();
  if (p.adDate !== today) { p.adDate = today; p.adCount = 0; }
  if (p.adCount >= AD_DAILY_CAP) return res.json({ ok: false, error: "오늘 트윗 보너스는 이미 받으셨어요! 내일 또 참여해주세요 🐦" });
  p.adCount++;
  markDirty();
  res.json({ ok: true, left: AD_DAILY_CAP - p.adCount, n: p.adCount });
});

// 길드타워 현황
app.get("/api/tower", (req, res) => {
  res.json({ ok: true, bricks: db.tower.bricks, floor: Math.floor(db.tower.bricks / 10) });
});

// 백엔드 환산비(게임점수 10 = 1P)의 역수: 포인트 X를 주려면 score = X*10
const GAME_SCORE_TO_POINT_INV = 10;

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  let mySnake = null;
  let myRoom = null;

  socket.on("join", async (payload) => {
    try {
      const name = String((payload && payload.name) || "").trim();
      const wantBuffs = (payload && Array.isArray(payload.buffs)) ? payload.buffs : [];
      const roomIdReq = payload && payload.roomId;
      if (!name) { socket.emit("joinError", "이름 정보가 없어요."); return; }

      // 콩달러 입장료 (재산 비례 — 인플레 대응)
      const mySave = db.players[name] || {};
      const myMoney = Math.max(0, mySave.money || 0);
      const myStage = Math.min(30, Math.max(1, mySave.stage || 1));
      const feePaid = Math.max(300, Math.floor((STAGE_THRESHOLDS[myStage] || 0) / 200));  // 등급 비례: 승급비의 0.5%
      const feeKongz = Math.max(800, feePaid * 2.5 | 0); // 포인트 없으면 2.5배
      if (myMoney < 300) {
        socket.emit("joinError", "콩달러가 부족해요! 펑키시티에서 최소 ₭300은 벌어오세요 🦍");
        return;
      }

      const entry = await enterGame(name, wantBuffs);
      if (!entry || entry.ok === false) {
        socket.emit("joinError", (entry && entry.message) || "입장할 수 없어요.");
        return;
      }

      let kFee;
      if (entry.mode === "paid") {
        kFee = feePaid; // 포인트 50P는 백엔드에서 이미 차감됨
      } else {
        // 포인트 부족 → 콩달러 단독 입장 (점수 제한 모드 유지)
        if (myMoney < feeKongz) {
          socket.emit("joinError", "포인트도 부족하고 콩달러도 모자라요! (₭" + feeKongz.toLocaleString() + " 필요)");
          return;
        }
        kFee = feeKongz;
      }
      if (!db.players[name]) db.players[name] = {};
      db.players[name].money = myMoney - kFee;
      markDirty();
      entry.kFee = kFee;

      const room = roomIdReq && rooms.has(roomIdReq) && rooms.get(roomIdReq).players.size < ROOM_MAX_PLAYERS
        ? rooms.get(roomIdReq) : findJoinableRoom();

      const snake = new Snake(socket.id, name, false, entry.mode, entry.buffs || [], entry.nft || 0);
      room.players.set(socket.id, snake);
      mySnake = snake;
      myRoom = room;

      socket.join(room.id);
      socket.emit("joined", {
        roomId: room.id, mode: entry.mode, buffs: entry.buffs || [], nft: entry.nft || 0,
        worldSize: WORLD_SIZE, myId: socket.id, kFee: entry.kFee || 0,
      });
    } catch (e) {
      console.error(e);
      socket.emit("joinError", "입장 중 오류가 발생했어요.");
    }
  });

  socket.on("input", (data) => {
    if (!mySnake || !mySnake.alive) return;
    if (typeof data.angle === "number") mySnake.targetAngle = data.angle;
    mySnake.boosting = !!data.boost;
  });

  socket.on("leave", async () => {
    await finishAndLeave();
  });

  socket.on("disconnect", async () => {
    await finishAndLeave();
  });

  async function finishAndLeave() {
    if (!mySnake || !myRoom) return;
    const playedSec = (Date.now() - mySnake.joinedAt) / 1000;
    const finalScore = playedSec >= MIN_PLAY_SECONDS ? mySnake.score : 0;
    myRoom.players.delete(socket.id);
    if (finalScore > 0) {
      if (!db.worm) db.worm = {};
      db.worm[mySnake.name] = (db.worm[mySnake.name] || 0) + finalScore;
      markDirty();
      await submitScore(mySnake.name, finalScore, "지렁이게임");
    }
    if (myRoom.players.size === 0) {
      rooms.delete(myRoom.id); // 실유저 없으면 방 소멸
    }
    mySnake = null; myRoom = null;
  }
});

// ===== 랭킹 API (지렁이 누적 / 펑키시티) =====
if (!db.worm) db.worm = {};
app.get("/api/rank/worm", (req, res) => {
  if (!checkToken(req, res)) return;
  const list = Object.entries(db.worm || {})
    .map(([name, total]) => ({ name, total: Math.floor(total) }))
    .sort((a, b) => b.total - a.total).slice(0, 10);
  res.json({ ok: true, list });
});
app.get("/api/rank/idle", (req, res) => {
  if (!checkToken(req, res)) return;
  const list = Object.entries(db.players || {})
    .filter(([, s]) => s && typeof s.stage === "number")
    .map(([name, s]) => ({ name, stage: s.stage, lifetime: Math.floor(s.lifetime || 0) }))
    .sort((a, b) => b.stage - a.stage || b.lifetime - a.lifetime).slice(0, 10);
  res.json({ ok: true, list });
});

setInterval(() => tick(io), TICK_MS);

server.listen(PORT, () => {
  console.log(`길드 지렁이 게임 서버 실행 중: http://localhost:${PORT}`);
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("여기에") === 0) {
    console.warn("⚠️  .env 의 APPS_SCRIPT_URL 이 설정되지 않아 테스트 모드(포인트 연동 없음)로 동작합니다.");
  }
});
