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

// ===== 전역 안전망: 어떤 오류도 서버 프로세스를 죽이지 못하게 =====
process.on("uncaughtException", (e) => { console.error("[uncaughtException]", (e && e.stack) || e); });
process.on("unhandledRejection", (e) => { console.error("[unhandledRejection]", (e && e.stack) || e); });

const express = require("express");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
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

  spawnFood(x, y, value, fromKill, own) {
    const id = this.nextFoodId++;
    const gold = value ? false : Math.random() < GOLD_FOOD_CHANCE;
    this.food.set(id, {
      id,
      x: x != null ? x : rand(50, WORLD_SIZE - 50),
      y: y != null ? y : rand(50, WORLD_SIZE - 50),
      value: value != null ? value : (gold ? 5 : 1),
      gold: !!gold && !value,
      fromKill: !!fromKill,
      own: own || "",
      exp: own ? Date.now() + 60000 : 0,
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

  // 월드 경계 = 벽. 부딪히면 즉사
  if (snake.x < 10 || snake.x > WORLD_SIZE - 10 || snake.y < 10 || snake.y > WORLD_SIZE - 10) {
    snake.x = Math.max(10, Math.min(WORLD_SIZE - 10, snake.x));
    snake.y = Math.max(10, Math.min(WORLD_SIZE - 10, snake.y));
    snake.hitWall = true;
    return;
  }

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

// ===== 저축(뱅크) =====
function bankOf(name) {
  const p = db.players[name] || (db.players[name] = {});
  if (!p.bank) p.bank = { p: 0, k: 0, hist: [] };
  return p.bank;
}
function bankAdd(name, dp, dk, txt) {
  if (!name || (dp <= 0 && dk <= 0)) return;
  const b = bankOf(name);
  b.p += dp; b.k += dk;
  b.hist.unshift({ t: Date.now(), txt, p: dp, k: dk });
  if (b.hist.length > 50) b.hist.length = 50;
  markDirty();
}

function killSnake(victim, room, io) {
  victim.alive = false;
  const dropTotal = victim.mass * KILL_DROP_RATIO;
  const dropCount = Math.max(5, Math.min(40, Math.floor(dropTotal / 4)));
  const per = dropTotal / dropCount;
  for (let i = 0; i < dropCount; i++) {
    const ang = rand(0, Math.PI * 2);
    const r = rand(0, 60);
    room.spawnFood(victim.x + Math.cos(ang) * r, victim.y + Math.sin(ang) * r, per, true, victim.isBot ? "" : victim.name);
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

    // 사망 잔해: 1분 뒤 사라지며 주인 저축으로
    const reclaim = {};
    for (const [fid, f] of room.food) {
      if (f.own && f.exp && now >= f.exp) {
        reclaim[f.own] = (reclaim[f.own] || 0) + f.value;
        room.food.delete(fid);
      }
    }
    for (const owner of Object.keys(reclaim)) {
      const m = reclaim[owner];
      bankAdd(owner, Math.round(m / 10), Math.round(m / 2), "💀 사망 잔해 회수 (남은 점수 " + Math.round(m) + ")");
    }

    for (const bot of room.bots) botAI(bot, room, now);
    for (const s of allSnakes(room)) {
      stepSnake(s, room, dt);
      if (s.hitWall && s.alive) { s.hitWall = false; killSnake(s, room, io); }
    }
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
// (복원 완료 후 서버 오픈 — 파일 하단 server.listen 참고)

// 등급 임계값(누적 수익) / 등급 달성 포인트 보상 — 클라이언트와 동일해야 함 (24단계)
const CITY_DIFF = 10; // 펑키시티 난이도 배율 — 클라(index.html)와 동일해야 함
const STAGE_THRESHOLDS = [0, 0]; for (let _s = 2; _s <= 50; _s++) STAGE_THRESHOLDS[_s] = Math.round(500 * Math.pow(2.9, _s - 2) * CITY_DIFF);
const STAGE_REWARDS = [0, 0]; for (let _r = 2; _r <= 50; _r++) STAGE_REWARDS[_r] = 10 + (_r - 2) * 8;
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
        const img = ((it.content || {}).links || {}).image || "";
        const m = nm.match(/#(\d+)/);
        if (m) ids.push({ id: parseInt(m[1], 10), img });
      }
      if (items.length < 1000) break;
      page++;
    }
  } catch (e) { console.warn("Helius 조회 실패:", e.message); }
  ids.sort((a, b) => a.id - b.id);
  nftCache.set(wallet, { ids, ts: Date.now() });
  return ids;
}

// 기기 잠금: 계정(이름)은 최초 접속 기기에 묶임 — 남의 링크로 플레이 방지
const LINK_SECRET = process.env.LINK_SECRET || ""; // 카톡 봇 링크 서명 비밀키
const ADMIN_NAMES = ["김동건"]; // 게임 내 '전체 초기화' 버튼 허용 관리자 계정 (본인 세션 검증)
function validSig(name, ph, sig) {
  if (!LINK_SECRET) return true; // 미설정 시 기존 동작
  if (!sig) return false;
  return crypto.createHash("sha256").update(name + "|" + ph + "|" + LINK_SECRET, "utf8").digest("hex") === String(sig).toLowerCase();
}
function pinHash(name, pin) {
  return crypto.createHash("sha256").update(pin + "|" + name, "utf8").digest("hex");
}
function makeSes() { return crypto.randomBytes(16).toString("hex"); }

function validSes(p, ses) {
  if (!p || !ses) return false;
  if (p.ses && ses === p.ses) return true; // 구버전 단일 세션 호환
  return Array.isArray(p.sess) && p.sess.indexOf(ses) >= 0;
}
function pushSes(p) {
  const ses = makeSes();
  if (!Array.isArray(p.sess)) p.sess = p.ses ? [p.ses] : [];
  p.sess.push(ses);
  if (p.sess.length > 5) p.sess = p.sess.slice(-5); // 기기 5대까지 동시 로그인
  delete p.ses;
  markDirty();
  setTimeout(() => backupToSheet().catch(() => {}), 10000); // 세션은 곧 백업 (재배포 대비)
  return ses;
}

function checkDev(name, key, sig, ph, ses) {
  if (!name) return false;
  if (validSes(db.players[name], ses)) return true; // 로그인 세션
  if (!validSig(name, ph || "", sig)) return false; // 아니면 봇이 만든 링크만 유효
  if (!db.players[name]) db.players[name] = {};
  const p = db.players[name];
  if (ph) {
    if (!p.ph) { p.ph = ph; markDirty(); }
    else if (p.ph !== ph) return false; // 같은 닉네임, 다른 사람 (프로필 다름)
  }
  return true;
}
const LOCK_MSG = "본인 카카오톡의 [게임시작] 링크로 접속해주세요! (링크가 오래됐거나, 동일 닉네임 사칭이 감지된 경우입니다)";
// 이 기기가 주인인 계정 찾기 (타인 링크 → 내 계정 자동 우회용)
function findNameByKey(key) {
  if (!key) return null;
  for (const [nm, p] of Object.entries(db.players || {})) {
    if (p && p.devKey === key) return nm;
  }
  return null;
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

// 지렁이 입장료 미리보기 (등급 비례 — join 로직과 동일 공식)
app.get("/api/worm/fee", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String(req.query.name || "").trim().normalize("NFC");
  const sv = db.players[name] || {};
  const stage = Math.min(30, Math.max(1, sv.stage || 1));
  const money = Math.max(0, Math.floor(sv.money || 0));
  const feePaid = Math.max(300, Math.floor((STAGE_THRESHOLDS[stage] || 0) / 200));
  const feeKongz = Math.max(800, feePaid * 2.5 | 0);
  res.json({ ok: true, stage, money, feePaid, feeKongz });
});

// 프로필: 시트(등록·NFT수·포인트) + 보유 NFT 번호(이미지용)
const TEST_WALLET = process.env.TEST_WALLET || "";
app.get("/api/profile", async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String(req.query.name || "").trim().normalize("NFC");
  if (!name) return res.json({ ok: false, error: "이름 없음" });
  if (!checkDev(name, String(req.query.key || ""), String(req.query.sig || ""), String(req.query.ph || ""), String(req.query.ses || ""))) return res.json({ ok: false, error: "locked", message: LOCK_MSG, yours: findNameByKey(String(req.query.key || (req.body&&req.body.key) || "")) });
  let profile = { ok: true, registered: false, nft: 0, point: 0, wallet: "" };
  const raw = await callBackend("profile", name, "");
  if (raw) { try { profile = JSON.parse(raw); } catch (e) { /* 구버전 배포면 기본값 유지 */ } }
  // 지갑 미연동 유저: 테스트 지갑으로 콩즈 표시 (정식 오픈 때 TEST_WALLET 제거)
  if (!profile.wallet && TEST_WALLET) profile.wallet = TEST_WALLET;
  let tokenIds = [];
  if (profile.wallet) tokenIds = await getOwnedTokenIds(profile.wallet);
  // 시트 NFT 수량이 없으면(미연동/테스트) 지갑 실보유 수로 동료 보너스 계산
  if (!profile.nft && tokenIds.length) profile.nft = tokenIds.length;
  const toks = tokenIds.slice(0, 1000); // 대량 홀더(300+) 대응 — 지갑 실보유 전부
  const imgMap = {};
  toks.forEach((t) => { if (t.img) imgMap[t.id] = t.img; });
  res.json({ ...profile, tokenIds: toks.map((t) => t.id), imgMap, imageBase: "https://punkykongz.com/nft/punkykongz/image/" });
});

// 세이브 로드/저장
app.get("/api/idle/load", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String(req.query.name || "").trim().normalize("NFC");
  if (!checkDev(name, String(req.query.key || ""), String(req.query.sig || ""), String(req.query.ph || ""), String(req.query.ses || ""))) return res.json({ ok: false, error: "locked", message: LOCK_MSG, yours: findNameByKey(String(req.query.key || (req.body&&req.body.key) || "")) });
  res.json({ ok: true, save: db.players[name] || null, tower: db.tower, gen: (db.saveGen || 0) });
});

app.post("/api/idle/save", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim().normalize("NFC");
  if (!checkDev(name, String((req.body.key || "")), String((req.body.sig || "")), String((req.body.ph || "")), String((req.body.ses || "")))) return res.json({ ok: false, error: "locked", message: LOCK_MSG, yours: findNameByKey(String(req.query.key || (req.body&&req.body.key) || "")) });
  const save = req.body.save;
  if (!name || typeof save !== "object" || save === null) return res.json({ ok: false });
  // 리셋 이후 아직 새로고침 안 한 옛 클라의 저장은 무효화 (초기화 되돌림 방지)
  if (Number(req.body.gen || 0) < (db.saveGen || 0)) return res.json({ ok: false, error: "stale", gen: db.saveGen });
  // 게임 세이브 필드만 갱신 (인증·저축·로또·기기 필드는 절대 클라 세이브로 덮어쓰지 않음)
  const GAME_FIELDS = ["money", "lifetime", "stage", "levels", "souls", "avatarId", "lastSeen",
                       "bnDate", "bnCount", "mgDate", "moleN", "simonN",
                       "szMeta", "szBest", "szN", "szRun", "tapN", "tapLv", "bothLv"];
  const p = db.players[name] || (db.players[name] = {});
  for (const f of GAME_FIELDS) if (f in save) p[f] = save[f];
  // rewardedStage/lastCollectDate 는 서버가 관리(중복 보상·수금 방지) → 클라값 무시
  if (p.rewardedStage == null) p.rewardedStage = 1;
  if (p.lastCollectDate == null) p.lastCollectDate = "";
  markDirty();
  res.json({ ok: true });
});

// 등급 달성 보상 (서버가 누적수익 검증 후 포인트 지급)
app.post("/api/idle/stage", async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim().normalize("NFC");
  if (!checkDev(name, String((req.body.key || "")), String((req.body.sig || "")), String((req.body.ph || "")), String((req.body.ses || "")))) return res.json({ ok: false, error: "locked", message: LOCK_MSG, yours: findNameByKey(String(req.query.key || (req.body&&req.body.key) || "")) });
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
  const name = String((req.body.name || "")).trim().normalize("NFC");
  if (!checkDev(name, String((req.body.key || "")), String((req.body.sig || "")), String((req.body.ph || "")), String((req.body.ses || "")))) return res.json({ ok: false, error: "locked", message: LOCK_MSG, yours: findNameByKey(String(req.query.key || (req.body&&req.body.key) || "")) });
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
// 여러 키 지원: 쉼표로 구분해 넣으면 순환 사용 + 한도 소진 시 다음 키로 폴백
// (실제 무료 용량이 늘려면 서로 다른 구글 계정의 키여야 함)
const GEMINI_KEYS = (process.env.GEMINI_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean);
const GEMINI_API_KEY = GEMINI_KEYS[0] || ""; // 하위호환(존재 확인용)
let geminiKeyIdx = 0;
const geminiKeyDead = new Set(); // 오늘 한도 소진/무효 키 (자정 초기화)
const AVATAR_DIR = path.join(__dirname, "public", "gen");
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_DAILY_CAP = 30; // 하루 생성 상한 (무료 티어 보호)
let avatarGen = { date: todayStr(), n: 0 };
const avatarPending = new Set();
let lastAvatarErr = ""; // 디버그용 마지막 실패 사유

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

async function generateAvatar(id, stage, srcImg) {
  const key = `${id}_${stage}`;
  if (avatarPending.has(key)) return;
  if (avatarGen.date !== todayStr()) { avatarGen = { date: todayStr(), n: 0 }; geminiKeyDead.clear(); } // 자정: 카운터+죽은키 초기화
  if (avatarGen.n >= AVATAR_DAILY_CAP * Math.max(1, GEMINI_KEYS.length)) return; // 키 수만큼 상한 확대
  avatarPending.add(key);
  avatarGen.n++;
  try {
    // 원본 콩즈 이미지 (Helius CDN 리사이즈 → 실패 시 원본)
    const orig = (srcImg && srcImg.indexOf("https://punkykongz.com/") === 0)
      ? srcImg : `https://punkykongz.com/nft/punkykongz/image/${id}.jpg`;
    let imgRes = await fetch(`https://cdn.helius-rpc.com/cdn-cgi/image/width=512/${orig}`);
    if (!imgRes.ok) imgRes = await fetch(orig);
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    const prompt =
      `Take the gorilla character from the first image and place him naturally INTO the scene of the second image, ` +
      `dressed and acting as ${STAGE_OUTFITS[stage]}. ` +
      "Keep the gorilla's face, fur color and identity clearly recognizable. " +
      "The character must be FULLY visible from head to FEET, standing ON the ground surface — " +
      "never buried in the ground, never cropped by the frame edges. " +
      "Position him center, feet clearly on the floor, interacting with the environment naturally, " +
      "matching the scene's lighting, perspective and art style. Keep the background composition. " +
      "The artwork must FILL the entire canvas edge-to-edge: no white borders, no margins, no letterboxing. " +
      "Wide 3:2 landscape, no text, no watermark.";

    const parts = [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: b64 } }];
    const bgPath = path.join(__dirname, "public", "assets", "bg", `stage${stage}.webp`);
    if (fs.existsSync(bgPath)) {
      parts.push({ inline_data: { mime_type: "image/webp", data: fs.readFileSync(bgPath).toString("base64") } });
    }
    const body = {
      contents: [{ parts }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:2" } },
    };
    // 살아있는 키들을 순환하며 시도 — 한도/무효 키는 오늘 제외하고 다음 키로
    const live = GEMINI_KEYS.filter((k) => !geminiKeyDead.has(k));
    if (live.length === 0) { lastAvatarErr = "all-keys-dead: 모든 키가 소진/무효"; return; }
    for (let attempt = 0; attempt < live.length; attempt++) {
      const key = live[geminiKeyIdx % live.length];
      geminiKeyIdx++;
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      const json = await res.json();
      const outParts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
      let got = null;
      for (const p of outParts) { if (p.inlineData && p.inlineData.data) { got = p.inlineData.data; break; } }
      if (got) {
        fs.writeFileSync(avatarFile(id, stage), Buffer.from(got, "base64"));
        console.log(`AI 아바타 생성: 콩즈#${id} 등급${stage} (키${(geminiKeyIdx - 1) % live.length + 1}/${live.length}, 오늘 ${avatarGen.n}/${AVATAR_DAILY_CAP})`);
        return;
      }
      // 실패 원인 분석: 한도(429)·무효(400 API_KEY) 키는 오늘 제외하고 다음 키로 재시도
      const code = (json.error && json.error.code) || res.status;
      const reason = ((json.error && json.error.status) || "") + " " + ((json.error && json.error.message) || "");
      if (code === 429 || /RESOURCE_EXHAUSTED|quota/i.test(reason) || /API_KEY_INVALID|API key not valid/i.test(reason)) {
        geminiKeyDead.add(key);
        lastAvatarErr = `key-dead(${key.slice(0, 8)}…): ${reason.slice(0, 120)}`;
        continue; // 다음 키로
      }
      lastAvatarErr = "no-image: " + JSON.stringify(json).slice(0, 300);
      console.warn("아바타 생성 응답에 이미지 없음:", JSON.stringify(json).slice(0, 200));
      break; // 한도/무효가 아닌 다른 오류면 중단
    }
  } catch (e) {
    lastAvatarErr = "exception: " + e.message;
    console.warn("아바타 생성 실패:", e.message);
  } finally {
    avatarPending.delete(key);
  }
}

// 아바타 생성 상태 디버그 (관리자 전용)
app.get("/api/avatar-debug", (req, res) => {
  if (!LINK_SECRET || String(req.query.secret || "") !== LINK_SECRET) return res.status(403).json({ ok: false });
  let genDir = [];
  try { genDir = fs.readdirSync(path.join(__dirname, "public", "gen")); } catch (e) { genDir = ["(폴더 없음: " + e.message + ")"]; }
  res.json({ ok: true, date: avatarGen.date, n: avatarGen.n, cap: AVATAR_DAILY_CAP,
    pending: Array.from(avatarPending), lastErr: lastAvatarErr, keyCount: GEMINI_KEYS.length,
    deadKeys: geminiKeyDead.size, hasKey: !!GEMINI_API_KEY, files: genDir.slice(0, 20) });
});

// 아바타 변신 이미지 조회 (없으면 백그라운드 생성 시작)
app.get("/api/avatar-url", (req, res) => {
  if (!checkToken(req, res)) return;
  const id = parseInt(req.query.id, 10);
  const stage = Math.min(30, Math.max(1, parseInt(req.query.stage, 10) || 1));
  if (!id || !GEMINI_API_KEY) return res.json({ ok: false });
  const file = avatarFile(id, stage);
  if (fs.existsSync(file)) return res.json({ ok: true, ready: true, url: `/gen/avatar_${id}_${stage}.png` });
  generateAvatar(id, stage, String(req.query.img || "")); // 비동기 시작
  res.json({ ok: true, ready: false });
});

// 광고 보상: 하루 5회 제한 (서버가 횟수 관리)
const AD_DAILY_CAP = 1; // 트윗 참여 보너스: 하루 1회
app.post("/api/ad/watch", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim().normalize("NFC");
  if (!checkDev(name, String((req.body.key || "")), String((req.body.sig || "")), String((req.body.ph || "")), String((req.body.ses || "")))) return res.json({ ok: false, error: "locked", message: LOCK_MSG, yours: findNameByKey(String(req.query.key || (req.body&&req.body.key) || "")) });
  const type = req.body.type === "yt" ? "yt" : "x"; // x(트위터) / yt(유튜브) 각각 하루 1회
  if (!name) return res.json({ ok: false });
  if (!db.players[name]) db.players[name] = {};
  const p = db.players[name];
  const today = todayStr();
  if (p.bonusDate !== today) { p.bonusDate = today; p.bx = 0; p.byt = 0; }
  const key = type === "yt" ? "byt" : "bx";
  if (p[key] >= 1) return res.json({ ok: false, error: (type==="yt"?"유튜브":"트윗") + " 보너스는 오늘 이미 받으셨어요! 내일 또 💛" });
  p[key] = 1;
  markDirty();
  res.json({ ok: true });
});

// 봇 링크로 세션 발급 (서명 = 본인 인증)
app.post("/api/linklogin", (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().normalize("NFC");
  const ph = String(b.ph || "");
  if (!name || !validSig(name, ph, String(b.sig || ""))) return res.status(403).json({ ok: false, message: "링크가 유효하지 않아요. 카톡에서 [게임시작]으로 새 링크를 받아주세요." });
  const p = db.players[name] || (db.players[name] = {});
  if (ph) { if (!p.ph) p.ph = ph; else if (p.ph !== ph) return res.json({ ok: false, message: "동일 닉네임 사칭이 의심돼요. 관리자에게 문의하세요." }); }
  // 이미 비밀번호가 있는 계정 = 설정 완료됨. 링크만으로는 로그인 불가(비번 필수).
  // → 남에게 링크가 유출돼도 계정 탈취 불가. 본인이면 닉네임+비번으로 로그인.
  if (p.pinHash) return res.json({ ok: true, hasPin: true, name });
  // 비밀번호가 아직 없는 최초 유저만 링크로 세션 발급 (첫 설정용)
  const ses = pushSes(p);
  res.json({ ok: true, ses, name, token: BOT_TOKEN, needPin: true });
});

// 로그인 (닉네임+비밀번호 → 세션)
app.post("/api/login", (req, res) => {
  const name = String((req.body && req.body.name) || "").trim().normalize("NFC");
  const pin = String((req.body && req.body.pin) || "");
  const p = db.players[name];
  if (!p || !p.pinHash) return res.json({ ok: false, error: "nopin", message: "비밀번호가 아직 없어요. 카카오톡에서 [게임시작] 링크로 접속해 먼저 비밀번호를 만들어주세요!" });
  if (pinHash(name, pin) !== p.pinHash) return res.json({ ok: false, error: "badpin", message: "닉네임 또는 비밀번호가 달라요." });
  const ses = pushSes(p);
  res.json({ ok: true, ses, name, token: BOT_TOKEN });
});

// 비밀번호 설정/변경 (봇 서명 링크 또는 기존 세션으로만 가능)
app.post("/api/pin/set", (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().normalize("NFC");
  const pin = String(b.pin || "");
  if (!name || pin.length < 4) return res.json({ ok: false, message: "비밀번호는 4자 이상이어야 해요." });
  const p = db.players[name] || (db.players[name] = {});
  const authed = validSes(p, String(b.ses || "")) || validSig(name, String(b.ph || ""), String(b.sig || ""));
  if (!authed) return res.status(403).json({ ok: false, message: "본인 링크로 접속해야 비밀번호를 만들 수 있어요." });
  const ph = String(b.ph || "");
  if (ph) { if (!p.ph) p.ph = ph; else if (p.ph !== ph) return res.status(403).json({ ok: false, message: "사칭 의심 — 관리자에게 문의하세요." }); }
  p.pinHash = pinHash(name, pin);
  p.sess = []; // 비밀번호 변경 = 모든 기기 로그아웃
  const ses = pushSes(p);
  res.json({ ok: true, ses });
});

// 관리자: 기기 잠금 해제 (LINK_SECRET 필요 — 링크에 노출되지 않는 비밀)
app.get("/api/admin/unbind", (req, res) => {
  if (!LINK_SECRET || String(req.query.secret || "") !== LINK_SECRET) return res.status(403).json({ ok: false });
  const name = String(req.query.name || "").trim().normalize("NFC");
  if (name === "ALL") {
    let n = 0;
    const wipePin = String(req.query.pin || "") === "1";
    for (const p of Object.values(db.players || {})) {
      if (!p) continue;
      if (p.devKey) { delete p.devKey; n++; }
      if (wipePin) { delete p.pinHash; delete p.ses; delete p.sess; delete p.ph; }
    }
    markDirty();
    return res.json({ ok: true, cleared: n });
  }
  const t = db.players[name];
  if (t) {
    delete t.devKey;
    if (String(req.query.pin || "") === "1") { delete t.pinHash; delete t.ses; delete t.sess; delete t.ph; }
    markDirty(); return res.json({ ok: true, cleared: 1 });
  }
  res.json({ ok: true, cleared: 0 });
});

// 이 기기의 주인 계정 조회 (링크 무시하고 내 계정으로 입장)
app.get("/api/whoami", (req, res) => {
  if (!checkToken(req, res)) return;
  res.json({ ok: true, name: findNameByKey(String(req.query.key || "")) });
});

// 게임 내 지갑 신청 → 백엔드로 전달
app.post("/api/wallet/apply", async (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim().normalize("NFC");
  if (!checkDev(name, String((req.body.key || "")), String((req.body.sig || "")), String((req.body.ph || "")), String((req.body.ses || "")))) return res.json({ ok: false, error: "locked", message: LOCK_MSG, yours: findNameByKey(String(req.query.key || (req.body&&req.body.key) || "")) });
  const wallet = String((req.body.wallet || "")).trim();
  if (!name || !wallet) return res.json({ ok: false, message: "입력값 부족" });
  const raw = await callBackend("wallet_apply", name, wallet);
  res.json({ ok: true, message: raw || "서버 연결 실패 — 잠시 후 다시" });
});

// 길드타워 현황
app.get("/api/tower", (req, res) => {
  res.json({ ok: true, bricks: db.tower.bricks, floor: Math.floor(db.tower.bricks / 10) });
});

// 백엔드 환산비(게임점수 10 = 1P)의 역수: 포인트 X를 주려면 score = X*10
const GAME_SCORE_TO_POINT_INV = 10;

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ===== 콩즈 파이터 PvP (실시간 매칭 + 도전장 + 승수랭킹) =====
const FG_TURN_MS = 20000;         // 각 라운드 선택 제한시간
const fgQueue = [];               // 대기열 [{socket,name,avatarId,want}]
const fgSockRoom = new Map();     // socket.id -> match
if (!db.fgWins) db.fgWins = {};   // name -> 누적 승수

function fgDequeue(id) { const i = fgQueue.findIndex((q) => q.socket.id === id); if (i >= 0) fgQueue.splice(i, 1); }

function fgEnd(match, winnerIdx, reason) {
  if (match.over) return;
  match.over = true;
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  match.players.forEach((p, i) => {
    fgSockRoom.delete(p.socket.id);
    const win = winnerIdx === i;
    let reward = 0, wins = db.fgWins[p.name] || 0;
    if (win && winnerIdx >= 0) {
      wins = db.fgWins[p.name] = wins + 1;
      const pl = db.players[p.name] || (db.players[p.name] = {});
      const today = todayStr();
      if (pl.fgDay !== today) { pl.fgDay = today; pl.fgRewarded = 0; }
      if ((pl.fgRewarded || 0) < 5) { pl.fgRewarded = (pl.fgRewarded || 0) + 1; reward = 3; submitScore(p.name, reward, "파이터승리").catch(() => {}); }
      markDirty();
    }
    try { p.socket.emit("fight:end", { win, tie: winnerIdx < 0, reward, wins, reason: reason || "" }); } catch (e) {}
  });
}

function fgResolve(match) {
  if (match.over) return;
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  const A = match.players[0], B = match.players[1];
  let ma = A.pick, mb = B.pick;
  if (ma == null) ma = 1; if (mb == null) mb = 1;         // 미선택 = 가드
  if (ma === 3 && A.g < 3) ma = 1;                        // 게이지 없이 필살기 불가(서버 검증)
  if (mb === 3 && B.g < 3) mb = 1;
  let dmgA = 0, dmgB = 0;
  const superA = ma === 3, superB = mb === 3;
  if (superA) A.g -= 3; if (superB) B.g -= 3;
  if (superA || superB) {
    if (superA && superB) { /* 충돌 */ }
    else if (superA) { if (mb === 1) B.g = Math.min(3, B.g + 2); else dmgB = 35; }
    else { if (ma === 1) A.g = Math.min(3, A.g + 2); else dmgA = 35; }
  } else {
    const w = (ma - mb + 3) % 3;
    if (w === 0) { A.g = Math.min(3, A.g + 1); B.g = Math.min(3, B.g + 1); }
    else if (w === 1) {
      if (ma === 0) { dmgB = 15; A.g = Math.min(3, A.g + 1); }
      else if (ma === 1) A.g = Math.min(3, A.g + 2);
      else { dmgB = 12; A.g = Math.min(3, A.g + 1); }
    } else {
      if (mb === 0) { dmgA = 15; B.g = Math.min(3, B.g + 1); }
      else if (mb === 1) B.g = Math.min(3, B.g + 2);
      else { dmgA = 12; B.g = Math.min(3, B.g + 1); }
    }
  }
  A.hp = Math.max(0, A.hp - dmgA); B.hp = Math.max(0, B.hp - dmgB);
  A.pick = null; B.pick = null; match.round++;
  try { A.socket.emit("fight:round", { round: match.round, me: { hp: A.hp, g: A.g, act: ma }, opp: { hp: B.hp, g: B.g, act: mb } }); } catch (e) {}
  try { B.socket.emit("fight:round", { round: match.round, me: { hp: B.hp, g: B.g, act: mb }, opp: { hp: A.hp, g: A.g, act: ma } }); } catch (e) {}
  if (A.hp <= 0 || B.hp <= 0) {
    const winner = (A.hp <= 0 && B.hp <= 0) ? -1 : (B.hp <= 0 ? 0 : 1);
    setTimeout(() => { try { fgEnd(match, winner); } catch (e) { console.error("[fgEnd]", e); } }, 900);
  } else {
    fgBeginRound(match);
  }
}

function fgBeginRound(match) {
  if (match.over) return;
  if (match.timer) clearTimeout(match.timer);
  match.players.forEach((p) => { try { p.socket.emit("fight:go", { round: match.round + 1 }); } catch (e) {} });
  match.timer = setTimeout(() => { try { if (!match.over) fgResolve(match); } catch (e) { console.error("[fgResolve-timer]", e); } }, FG_TURN_MS);
}

function fgStartMatch(a, b) {
  const match = { players: [a, b], round: 0, over: false, timer: null };
  [a, b].forEach((p) => { p.hp = 100; p.g = 0; p.pick = null; fgSockRoom.set(p.socket.id, match); });
  try { a.socket.emit("fight:matched", { opp: b.name, oppId: b.avatarId, wins: db.fgWins[a.name] || 0 }); } catch (e) {}
  try { b.socket.emit("fight:matched", { opp: a.name, oppId: a.avatarId, wins: db.fgWins[b.name] || 0 }); } catch (e) {}
  fgBeginRound(match);
}

function fgTryQueue(entry) {
  for (let i = 0; i < fgQueue.length; i++) {
    const q = fgQueue[i];
    if (!q.socket.connected || q.socket.id === entry.socket.id) continue;
    const iWantThem = !entry.want || entry.want.toLowerCase() === q.name.toLowerCase();
    const theyWantMe = !q.want || q.want.toLowerCase() === entry.name.toLowerCase();
    if (iWantThem && theyWantMe) { fgQueue.splice(i, 1); fgStartMatch(q, entry); return; }
  }
  fgQueue.push(entry);
  try { entry.socket.emit("fight:waiting", { want: entry.want || "" }); } catch (e) {}
}

function fgOnLeave(socket) {
  fgDequeue(socket.id);
  const match = fgSockRoom.get(socket.id);
  if (match && !match.over) {
    const winnerIdx = match.players[0].socket.id === socket.id ? 1 : 0;
    fgEnd(match, winnerIdx, "상대가 나갔어요");
  }
}


io.on("connection", (socket) => {
  let mySnake = null;
  let myRoom = null;

  socket.on("join", async (payload) => {
    try {
      const name = String((payload && payload.name) || "").trim().normalize("NFC");
      const wantBuffs = (payload && Array.isArray(payload.buffs)) ? payload.buffs : [];
      const roomIdReq = payload && payload.roomId;
      if (!name) { socket.emit("joinError", "이름 정보가 없어요."); return; }
      if (!checkDev(name, String((payload && payload.key) || ""), String((payload && payload.sig) || ""), String((payload && payload.ph) || ""), String((payload && payload.ses) || ""))) { socket.emit("joinError", LOCK_MSG); return; }

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
      db.lottoPot = (db.lottoPot || 0) + kFee; // 지렁이 입장료 전액 → 주간 로또 팟
      db.players[name].lottoMine = (db.players[name].lottoMine || 0) + kFee;
      db.players[name].lottoWeek = (db.players[name].lottoWeek || 0) + kFee; // 이번주 응모권
      markDirty();
      entry.kFee = kFee;

      const room = roomIdReq && rooms.has(roomIdReq) && rooms.get(roomIdReq).players.size < ROOM_MAX_PLAYERS
        ? rooms.get(roomIdReq) : findJoinableRoom();

      const snake = new Snake(socket.id, name, false, entry.mode, entry.buffs || [], entry.nft || 0);
      snake.kFeePaid = kFee;
      snake.pFeePaid = entry.mode === "paid" ? 50 : 0;
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

  // ----- 콩즈 파이터 PvP -----
  socket.on("fight:queue", (d) => {
    const name = String((d && d.name) || "").trim().normalize("NFC");
    if (!name) return;
    if (!checkDev(name, String((d && d.key) || ""), String((d && d.sig) || ""), String((d && d.ph) || ""), String((d && d.ses) || ""))) { try { socket.emit("fight:error", { message: "본인 인증 실패 — 다시 로그인해주세요." }); } catch (e) {} return; }
    fgDequeue(socket.id);
    fgTryQueue({ socket, name, avatarId: (d && d.avatarId) || 1, want: (d && d.want) ? String(d.want).trim().normalize("NFC") : "" });
  });
  socket.on("fight:pick", (d) => {
    const match = fgSockRoom.get(socket.id);
    if (!match || match.over) return;
    const p = match.players.find((x) => x.socket.id === socket.id);
    if (!p || p.pick != null) return;
    let a = parseInt(d && d.action, 10); if (!(a >= 0 && a <= 3)) a = 1;
    p.pick = a;
    const other = match.players.find((x) => x.socket.id !== socket.id);
    if (other && other.pick != null) { try { fgResolve(match); } catch (e) { console.error("[fgResolve]", e); } }
  });
  socket.on("fight:leave", () => fgOnLeave(socket));

  socket.on("disconnect", async () => {
    fgOnLeave(socket);
    await finishAndLeave();
  });

  async function finishAndLeave() {
    if (!mySnake || !myRoom) return;
    const playedSec = (Date.now() - mySnake.joinedAt) / 1000;
    const finalScore = playedSec >= MIN_PLAY_SECONDS ? mySnake.score : 0;
    if (mySnake.alive && playedSec >= MIN_PLAY_SECONDS) {
      bankAdd(mySnake.name, Math.ceil((mySnake.pFeePaid || 0) * 0.1), Math.ceil((mySnake.kFeePaid || 0) * 0.1), "🏦 정상 퇴장 — 입장료 10% 저축");
    }
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

// 관리자: 등급/콩달러 강제 설정 (LINK_SECRET 필요)
app.get("/api/admin/set", (req, res) => {
  if (!LINK_SECRET || String(req.query.secret || "") !== LINK_SECRET) return res.status(403).json({ ok: false });
  const name = String(req.query.name || "").trim().normalize("NFC");
  if (!name || !db.players[name]) return res.json({ ok: false, error: "no-player" });
  const p = db.players[name];
  const out = { ok: true, name };
  const st = parseInt(req.query.stage, 10);
  if (st >= 1 && st <= 50) {
    p.stage = st;
    if (p.save && Array.isArray(p.save.levels)) { /* 클라 세이브 구조 대비 */ }
    out.stage = st;
  }
  const money = parseInt(req.query.money, 10);
  if (!isNaN(money) && money >= 0) { p.money = money; out.money = money; }
  markDirty();
  res.json(out);
});

// ===== 주간 로또 (매주 월 13:00 KST 자동 추첨) =====
// 적립: ① 모든 ₭ 지출의 1% ② 지렁이 입장료 전액 → 기여 비례 가중추첨 3명
if (typeof db.lottoPot !== "number") db.lottoPot = 0;
if (typeof db.saveGen !== "number") db.saveGen = 0; // 리셋 세대 — 리셋 후 옛 클라 저장 무효화

// 가장 최근에 지난 '월요일 13:00 KST' 의 실제 UTC 타임스탬프
function lastMonday13KST(nowMs) {
  const KST = 9 * 3600 * 1000, now = nowMs || Date.now();
  const d = new Date(now + KST); // d의 UTC필드 = KST 벽시계
  const daysSinceMon = (d.getUTCDay() + 6) % 7; // 월=0..일=6
  const monWall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMon, 13, 0, 0);
  let monMs = monWall - KST; // KST 벽시계 → 실제 UTC
  if (monMs > now) monMs -= 7 * 24 * 3600 * 1000; // 월요일 13시 이전이면 지난주로
  return monMs;
}
function weightedPick(pool) { // pool: [[name, weight], ...]
  const total = pool.reduce((a, e) => a + e[1], 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const [n, w] of pool) { r -= w; if (r <= 0) return n; }
  return pool[pool.length - 1][0];
}
function performLottoDraw(due, force) {
  const pot = Math.floor(db.lottoPot || 0);
  let pool = [];
  for (const [nm, pl] of Object.entries(db.players || {})) {
    const w = Math.floor((pl && pl.lottoWeek) || 0);
    if (w > 0) pool.push([nm, w]);
  }
  const splits = [0.5, 0.3, 0.2]; // 1등 50% 2등 30% 3등 20%
  const winners = [];
  let paid = 0;
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const nm = weightedPick(pool);
    if (!nm) break;
    const contrib = Math.floor((pool.find((e) => e[0] === nm) || [null, 0])[1]);
    const raw = Math.floor(pot * splits[i]);   // 팟 배분액
    const cap = contrib * 100;                 // 상한: 응모금(이번주 기여)의 100배
    const prize = Math.min(raw, cap);          // 상한 초과분은 못 받음
    if (db.players[nm]) db.players[nm].money = (db.players[nm].money || 0) + prize;
    winners.push({ name: nm, prize, contrib, rank: i + 1, capped: prize < raw, raw });
    paid += prize;
    pool = pool.filter((e) => e[0] !== nm); // 중복 당첨 방지
  }
  const carry = Math.max(0, pot - paid); // 상한 초과분 + 미배정(당첨자<3) 전액 → 차주 이월
  db.lottoDraw = { drawnFor: due, at: Date.now(), pot, winners, carry };
  db.lottoPot = carry; // 이월금으로 새 주 시작 (추첨과 동시에 누적 재개)
  for (const pl of Object.values(db.players || {})) { if (pl) pl.lottoWeek = 0; }
  markDirty();
  backupToSheet().catch(() => {});
  console.log(`🎰 주간 로또: 팟 ${pot} → 지급 ${paid}, 이월 ${carry} | 당첨 ${winners.map((w) => w.name + "(" + w.prize + (w.capped ? "★상한" : "") + ")").join(", ") || "없음"}`);
}
function checkLottoDraw() {
  const due = lastMonday13KST();
  if (!db.lottoDraw) { db.lottoDraw = { drawnFor: due, at: 0, pot: 0, winners: [] }; markDirty(); return; } // 첫 가동: 다음주부터
  if (db.lottoDraw.drawnFor !== due) performLottoDraw(due);
}
setInterval(checkLottoDraw, 60 * 1000);
setTimeout(checkLottoDraw, 5000); // 부팅 후 1회
const LOTTO_DISPLAY_MS = 24 * 3600 * 1000; // 당첨자 발표 노출 시간 (월13~화13)
app.get("/api/lotto", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String(req.query.name || "").trim().normalize("NFC");
  const p = db.players[name] || {};
  const draw = db.lottoDraw || { at: 0, winners: [] };
  const showing = draw.at > 0 && Date.now() < draw.at + LOTTO_DISPLAY_MS && (draw.winners || []).length > 0;
  const pot = Math.floor(db.lottoPot || 0);
  const mine = Math.floor(p.lottoWeek || 0);
  const odds = pot > 0 ? Math.min(100, Math.round((mine / pot) * 1000) / 10) : 0;
  res.json({
    ok: true, pot, mine, odds,
    open: !showing,                                   // 발표중이면 응모 불가
    winners: showing ? draw.winners : null,
    resumeAt: showing ? draw.at + LOTTO_DISPLAY_MS : null, // 응모 재개 시각(=화 13시)
    nextDrawAt: lastMonday13KST() + 7 * 24 * 3600 * 1000,  // 다음 추첨(월 13시)
  });
});
// 관리자: 로또 팟 설정/리셋 (주간 추첨 후 0으로) — LINK_SECRET 필요
app.get("/api/admin/lotto", (req, res) => {
  if (!LINK_SECRET || String(req.query.secret || "") !== LINK_SECRET) return res.status(403).json({ ok: false });
  if (req.query.draw === "1") { performLottoDraw(lastMonday13KST(), true); return res.json({ ok: true, drew: true, winners: db.lottoDraw.winners }); }
  const set = req.query.set;
  if (set !== undefined) {
    db.lottoPot = Math.max(0, Math.floor(Number(set) || 0));
    if (req.query.reset === "1") { // 완전 초기화 (주간기여+발표 지움)
      for (const pp of Object.values(db.players || {})) { if (pp) { pp.lottoWeek = 0; } }
      db.lottoDraw = { drawnFor: lastMonday13KST(), at: 0, pot: 0, winners: [] };
    }
    markDirty();
  }
  res.json({ ok: true, pot: Math.floor(db.lottoPot || 0), draw: db.lottoDraw || null });
});
app.post("/api/lotto/add", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body && req.body.name) || "").trim().normalize("NFC");
  if (!checkDev(name, String((req.body.key || "")), String((req.body.sig || "")), String((req.body.ph || "")), String((req.body.ses || "")))) return res.json({ ok: false, error: "locked" });
  let amt = Math.floor(Number(req.body && req.body.amount) || 0);
  if (amt <= 0) return res.json({ ok: true, pot: Math.floor(db.lottoPot || 0) });
  if (amt > 1e15) amt = 1e15; // 비정상 방지 상한
  db.lottoPot = (db.lottoPot || 0) + amt;
  const p = db.players[name] || (db.players[name] = {});
  p.lottoMine = (p.lottoMine || 0) + amt;   // 전체 누적(참고용)
  p.lottoWeek = (p.lottoWeek || 0) + amt;   // 이번주 기여(= 응모권, 추첨 시 리셋)
  markDirty();
  res.json({ ok: true, pot: Math.floor(db.lottoPot), mine: Math.floor(p.lottoWeek) });
});

// 저축 조회 (잔액 + 이력)
app.get("/api/bank", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String(req.query.name || "").trim().normalize("NFC");
  if (!checkDev(name, String(req.query.key || ""), String(req.query.sig || ""), String(req.query.ph || ""), String(req.query.ses || ""))) {
    return res.status(403).json({ ok: false, error: "locked" });
  }
  const b = bankOf(name);
  res.json({ ok: true, p: Math.floor(b.p), k: Math.floor(b.k), hist: (b.hist || []).slice(0, 30) });
});

// ===== 랭킹 API (지렁이 누적 / 펑키시티) =====
if (!db.worm) db.worm = {};
const SPY_TEST_RE = /\d{5,}|테스터|검증|테스트|뷰어|롯또|겜검|몰수|도전[A-Z가-힣]?$|행인|최종검|완주|정규화|사칭|선점|세이브|기여자|대박이|중간이|소액이|공격러|잡기러|디버그|파이터[AB]|라이브검/;
app.get("/api/admin/delplayer", (req, res) => {
  if (!LINK_SECRET || String(req.query.secret || "") !== LINK_SECRET) return res.status(403).json({ ok: false });
  const names = String(req.query.names || "").split(",").map((x) => x.trim().normalize("NFC")).filter(Boolean);
  let del = 0;
  names.forEach((n) => { if (db.players[n]) { delete db.players[n]; del++; } if (db.fgWins && db.fgWins[n]) delete db.fgWins[n]; if (db.worm && db.worm[n]) delete db.worm[n]; });
  markDirty();
  res.json({ ok: true, deleted: del });
});
// 게임 진행만 초기화 (인증·지갑·저축·로또는 보존 → 재로그인/재등록 불필요)
// 사용: /api/admin/reset?secret=시크릿&all=1   또는   ...&names=이름1,이름2
app.get("/api/admin/reset", (req, res) => {
  if (!LINK_SECRET || String(req.query.secret || "") !== LINK_SECRET) return res.status(403).json({ ok: false });
  const all = String(req.query.all || "") === "1";
  const names = String(req.query.names || "").split(",").map((x) => x.trim().normalize("NFC")).filter(Boolean);
  const targets = all ? Object.keys(db.players) : names;
  // 리셋할 게임 필드만 명시 (인증 pinHash/sess/ph, 지갑 tokenIds/wallet, 저축 bank, 로또는 건드리지 않음)
  const GAME = { money: 0, lifetime: 0, stage: 1, souls: 0, rewardedStage: 1, lastCollectDate: "", avatarId: 0,
                 szMeta: {}, szBest: 0, szN: 0, szRun: null,
                 moleN: 0, simonN: 0, skyN: 0, k2N: 0, k3N: 0, rnN: 0, tdN: 0, tapN: 0, bnDate: "", bnCount: 0, mgDate: "",
                 bank: null, lottoMine: 0, lottoWeek: 0 }; // 저축·로또도 초기화
  let n = 0;
  targets.forEach((name) => {
    const p = db.players[name]; if (!p) return;
    Object.assign(p, GAME);
    p.levels = null; p.tapLv = null; p.bothLv = null; // 클라가 fresh 세이브로 재초기화
    if (db.fgWins && db.fgWins[name] != null) delete db.fgWins[name];
    n++;
  });
  // 전체 초기화(all=1)면 전역 상태(로또 팟·추첨·타워)도 리셋
  if (all) { db.lottoPot = 0; db.lottoDraw = null; db.tower = { bricks: 0 }; }
  db.saveGen = (db.saveGen || 0) + 1; // 접속 중 클라의 옛 저장 무효화
  markDirty(); backupDirty = true; backupToSheet(); // 시트 백업 즉시 갱신 (재시작 시 옛 데이터 복원 방지)
  res.json({ ok: true, reset: n, globals: all, kept: "pinHash·sess·ph·tokenIds·wallet(지갑등록)" });
});
// 관리자 계정 세션으로 전체 초기화 (게임 내 버튼용 — LINK_SECRET 불필요, 본인 세션 검증)
app.post("/api/admin/selfreset", (req, res) => {
  if (!checkToken(req, res)) return;
  const name = String((req.body.name || "")).trim().normalize("NFC");
  if (!checkDev(name, String(req.body.key || ""), String(req.body.sig || ""), String(req.body.ph || ""), String(req.body.ses || ""))) return res.json({ ok: false, error: "잠금(세션)" });
  if (ADMIN_NAMES.indexOf(name) < 0) return res.json({ ok: false, error: "관리자 계정이 아닙니다" });
  const GAME = { money: 0, lifetime: 0, stage: 1, souls: 0, rewardedStage: 1, lastCollectDate: "", avatarId: 0,
                 szMeta: {}, szBest: 0, szN: 0, szRun: null,
                 moleN: 0, simonN: 0, skyN: 0, k2N: 0, k3N: 0, rnN: 0, tdN: 0, tapN: 0, bnDate: "", bnCount: 0, mgDate: "",
                 bank: null, lottoMine: 0, lottoWeek: 0 };
  let n = 0;
  for (const nm of Object.keys(db.players)) { const p = db.players[nm]; if (!p) continue; Object.assign(p, GAME); p.levels = null; p.tapLv = null; p.bothLv = null; if (db.fgWins && db.fgWins[nm] != null) delete db.fgWins[nm]; n++; }
  db.lottoPot = 0; db.lottoDraw = null; db.tower = { bricks: 0 };
  db.saveGen = (db.saveGen || 0) + 1; // 접속 중 클라의 옛 저장 무효화
  markDirty(); backupDirty = true; backupToSheet();
  console.log(`[selfreset] ${name} 님이 전체 초기화 실행 → ${n}명 (saveGen=${db.saveGen})`);
  res.json({ ok: true, reset: n });
});
app.get("/api/admin/inspect", async (req, res) => {
  if (!LINK_SECRET || String(req.query.secret || "") !== LINK_SECRET) return res.status(403).json({ ok: false });
  const name = String(req.query.name || "").trim().normalize("NFC");
  const p = db.players[name];
  let sheet = null;
  try { const raw = await callBackend("profile", name, ""); if (raw) sheet = JSON.parse(raw); } catch (e) { sheet = { err: String(e) }; }
  let tokenIds = 0, helErr = null;
  const wallet = (sheet && sheet.wallet) || "";
  if (wallet) { try { const ids = await getOwnedTokenIds(wallet); tokenIds = ids.length; } catch (e) { helErr = String(e); } }
  res.json({ ok: true, name, exists: !!p,
    hasPin: !!(p && p.pinHash), sessCount: (p && p.sess && p.sess.length) || (p && p.ses ? 1 : 0),
    ph: !!(p && p.ph), stage: p && p.stage, money: p && Math.floor(p.money || 0),
    hasHeliusKey: !!HELIUS_API_KEY, serverTokenIds: tokenIds, helErr, sheet });
});
app.get("/api/spectate", (req, res) => {
  if (!checkToken(req, res)) return;
  const list = Object.entries(db.players || {})
    .filter(([n, p]) => p && !SPY_TEST_RE.test(n) && ((p.stage || 0) >= 2 || p.avatarId || ((db.fgWins && db.fgWins[n]) || 0) > 0))
    .map(([name, p]) => ({ name, stage: p.stage || 1, money: Math.floor(p.money || 0), avatarId: p.avatarId || 0, wins: (db.fgWins && db.fgWins[name]) || 0 }))
    .sort((a, b) => (b.stage - a.stage) || (b.money - a.money))
    .slice(0, 60);
  res.json({ ok: true, list });
});
app.get("/api/rank/fighter", (req, res) => {
  if (!checkToken(req, res)) return;
  const list = Object.entries(db.fgWins || {}).map(([name, w]) => ({ name, wins: w }))
    .sort((a, b) => b.wins - a.wins).slice(0, 10);
  res.json({ ok: true, list });
});
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

restoreFromSheet().then(() => {
  server.listen(PORT, () => {
    console.log(`길드 지렁이 게임 서버 실행 중: http://localhost:${PORT}`);
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf("여기에") === 0) {
      console.warn("⚠️  .env 의 APPS_SCRIPT_URL 이 설정되지 않아 테스트 모드(포인트 연동 없음)로 동작합니다.");
    }
  });
});
