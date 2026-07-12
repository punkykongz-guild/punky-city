(function () {
  var qs = new URLSearchParams(location.search);
  var savedId=null; try{ savedId=JSON.parse(localStorage.getItem("pkc_id")||"null"); }catch(e){}
var loginId=null; try{ loginId=JSON.parse(localStorage.getItem("pkc_login")||"null"); }catch(e){}
var nameFromUrl = (loginId&&loginId.name) || (savedId&&savedId.name) || qs.get("name") || "";

  var lobby = document.getElementById("lobby");
  var gameWrap = document.getElementById("gameWrap");
  var nameBox = document.getElementById("nameBox");
  var roomListEl = document.getElementById("roomList");
  var msgEl = document.getElementById("msg");
  var canvas = document.getElementById("canvas");
  var ctx = canvas.getContext("2d");
  var hud = document.getElementById("hud");
  var boardEl = document.getElementById("board");
  var deathOverlay = document.getElementById("deathOverlay");
  var deathScoreEl = document.getElementById("deathScore");

  // 반투명 순위판 (0.5초마다 갱신)
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  setInterval(function () {
    if (!latestState || !boardEl || gameWrap.style.display === "none") return;
    var list = latestState.snakes.filter(function (s) { return s.alive; })
      .sort(function (a, b) { return b.mass - a.mass; });
    var medals = ["🥇", "🥈", "🥉"];
    var html = '<div class="bTitle">— 이 방의 지렁이들 —</div>';
    list.slice(0, 8).forEach(function (s, i) {
      var mark = i < 3 ? medals[i] : (i + 1) + ".";
      var nm = (s.isBot ? "🤖" : "") + esc(s.name);
      html += '<div class="row' + (s.id === myId ? " me" : "") + '"><span class="nm">' + mark + " " + nm + '</span><span>' + s.mass + '</span></div>';
    });
    var myRank = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === myId) { myRank = i + 1; break; }
    if (myRank > 8) {
      var me = list[myRank - 1];
      html += '<div class="row me"><span class="nm">' + myRank + '. ' + esc(me.name) + '</span><span>' + me.mass + '</span></div>';
    }
    boardEl.innerHTML = html;
  }, 500);

  if (nameFromUrl) nameBox.value = nameFromUrl;

  // 내 등급 기준 입장료 표시
  (function loadFee(){
    var tk = qs.get("token") || "";
    var nm = nameBox.value.trim();
    if (!nm) { document.getElementById("feeInfo").textContent = "이름이 있어야 입장료를 계산해요"; return; }
    fetch("/api/worm/fee?token=" + encodeURIComponent(tk) + "&name=" + encodeURIComponent(nm))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) return;
        document.getElementById("feeInfo").innerHTML =
          "🎫 <b>내 입장료</b> (시티 Lv." + j.stage + " 기준)<br>" +
          "· 정상 입장: <b>50P + ₭" + j.feePaid.toLocaleString() + "</b> (모든 점수 100%)<br>" +
          "· 콩달러 입장: <b>₭" + j.feeKongz.toLocaleString() + "</b> (킬 점수 10%만)<br>" +
          "· 보유 콩달러: ₭" + j.money.toLocaleString();
      }).catch(function(){ document.getElementById("feeInfo").textContent = "입장료 확인 실패"; });
  })();

  var selectedRoomId = null;
  var socket = null;
  var myId = null;
  var latestState = null;
  var mode = "free", buffs = [], nft = 0;
  var lastAngle = 0, boosting = false;
  var dead = false;

  function refreshRooms() {
    fetch("/rooms").then(function (r) { return r.json(); }).then(function (rooms) {
      roomListEl.innerHTML = "";
      if (!rooms.length) {
        roomListEl.innerHTML = '<div style="color:#888;font-size:13px;">현재 열린 방이 없어요. 자동입장을 눌러 새 방을 만드세요.</div>';
        return;
      }
      rooms.forEach(function (r) {
        var row = document.createElement("div");
        row.className = "roomRow";
        var full = r.count >= r.max;
        row.innerHTML = '<span>' + r.id + ' (' + r.count + '/' + r.max + ')</span>';
        var btn = document.createElement("button");
        btn.textContent = full ? "가득참" : (selectedRoomId === r.id ? "✓ 선택됨" : "선택");
        btn.disabled = full;
        btn.onclick = function () { selectedRoomId = r.id; refreshRooms(); };
        row.appendChild(btn);
        roomListEl.appendChild(row);
      });
    }).catch(function () {});
  }
  refreshRooms();
  setInterval(refreshRooms, 4000);

  document.getElementById("autoBtn").onclick = function () { selectedRoomId = null; enterGame(); };
  document.getElementById("enterBtn").onclick = function () { enterGame(); };
  document.getElementById("leaveBtn").onclick = function () { doLeave(); };
  document.getElementById("backToLobbyBtn").onclick = function () { backToLobby(); };

  function wantedBuffs() {
    var out = [];
    if (document.getElementById("buffMagnet").checked) out.push("magnet");
    if (document.getElementById("buffSize").checked) out.push("size");
    if (document.getElementById("buffShield").checked) out.push("shield");
    return out;
  }

  function enterGame() {
    var name = nameBox.value.trim();
    if (!name) { msgEl.textContent = "이름을 입력해주세요."; return; }
    msgEl.textContent = "입장 중...";

    socket = io();
    socket.on("joined", function (data) {
      myId = data.myId; mode = data.mode; buffs = data.buffs; nft = data.nft;
      lobby.style.display = "none";
      gameWrap.style.display = "block";
      deathOverlay.style.display = "none";
      dead = false;
      resizeCanvas();
      updateHud();
    });
    socket.on("joinError", function (message) {
      msgEl.textContent = message;
      socket.disconnect(); socket = null;
    });
    socket.on("state", function (state) { latestState = state; });
    socket.on("loot", function (d) {
      hud.textContent = "💰 " + d.from + "의 콩달러 ₭" + d.amount.toLocaleString() + " 강탈!";
      hud.style.color = "#ffd54a";
      setTimeout(function () { hud.style.color = ""; }, 2500);
    });
    socket.on("looted", function (d) {
      hud.textContent = "💸 " + d.by + "에게 ₭" + d.amount.toLocaleString() + " 뺏김...";
      hud.style.color = "#ff8080";
      setTimeout(function () { hud.style.color = ""; }, 2500);
    });

    var devKey=localStorage.getItem("pkc_key")||"";
    socket.emit("join", { name: name, buffs: wantedBuffs(), roomId: selectedRoomId, key: devKey, sig: (savedId&&savedId.sig)||qs.get("sig")||"", ph: (savedId&&savedId.ph)||qs.get("ph")||"", ses: (loginId&&loginId.ses)||"" });
  }

  function doLeave() {
    if (socket) { socket.emit("leave"); socket.disconnect(); socket = null; }
    backToLobby();
  }

  function backToLobby() {
    gameWrap.style.display = "none";
    deathOverlay.style.display = "none";
    lobby.style.display = "block";
    latestState = null; myId = null; dead = false;
    refreshRooms();
  }

  function updateHud() {
    var buffLabel = buffs.length ? buffs.join(", ") : "없음";
    var modeLabel = mode === "paid" ? "정상입장" : (mode === "free" ? "무료입장(먹이 점수 없음)" : mode);
    hud.textContent = "모드: " + modeLabel + " | 버프: " + buffLabel + " | 펑키콩즈 " + nft + "개";
  }

  // ===== 입력 =====
  function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  window.addEventListener("resize", resizeCanvas);

  canvas.addEventListener("mousemove", function (e) {
    var cx = canvas.width / 2, cy = canvas.height / 2;
    lastAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
  });
  canvas.addEventListener("mousedown", function () { boosting = true; });
  // 모바일 조작 2종: [터치 방향] 화면 누른 쪽으로 / [조이스틱] 누른 자리에 반투명 스틱
  var ctrlMode = localStorage.getItem("pkc_ctrl") || "touch";
  var radios = document.querySelectorAll('input[name="ctrl"]');
  radios.forEach(function (r) {
    r.checked = (r.value === ctrlMode);
    r.addEventListener("change", function () { ctrlMode = r.value; localStorage.setItem("pkc_ctrl", ctrlMode); });
  });
  var joy = { active: false, ox: 0, oy: 0, cx: 0, cy: 0, R: 58 };
  function steerTouch(t) {
    if (ctrlMode === "joy") {
      joy.cx = t.clientX; joy.cy = t.clientY;
      var dx = joy.cx - joy.ox, dy = joy.cy - joy.oy;
      if (dx * dx + dy * dy > 100) lastAngle = Math.atan2(dy, dx);
    } else {
      var cx = canvas.width / 2, cy = canvas.height / 2;
      lastAngle = Math.atan2(t.clientY - cy, t.clientX - cx);
    }
  }
  canvas.addEventListener("touchstart", function (e) {
    e.preventDefault();
    var t = e.touches[0];
    if (t && ctrlMode === "joy" && !joy.active) { joy.active = true; joy.ox = joy.cx = t.clientX; joy.oy = joy.cy = t.clientY; }
    if (t) steerTouch(t);
    boosting = e.touches.length >= 2;
  }, { passive: false });
  canvas.addEventListener("touchmove", function (e) { e.preventDefault(); if (e.touches[0]) steerTouch(e.touches[0]); boosting = e.touches.length >= 2; }, { passive: false });
  canvas.addEventListener("touchend", function (e) {
    e.preventDefault();
    if (e.touches.length === 0) joy.active = false;
    boosting = e.touches.length >= 2;
  }, { passive: false });
  window.addEventListener("mouseup", function () { boosting = false; });
  window.addEventListener("keydown", function (e) { if (e.code === "Space") boosting = true; });
  window.addEventListener("keyup", function (e) { if (e.code === "Space") boosting = false; });

  setInterval(function () {
    if (socket && !dead) socket.emit("input", { angle: lastAngle, boost: boosting });
  }, 60);

  // ===== 렌더링 =====
  function draw() {
    requestAnimationFrame(draw);
    if (!latestState) return;
    var me = null;
    for (var i = 0; i < latestState.snakes.length; i++) {
      if (latestState.snakes[i].id === myId) { me = latestState.snakes[i]; break; }
    }
    if (me && !me.alive && !dead) {
      dead = true;
      deathScoreEl.textContent = "크기(질량): " + me.mass + " | 잠시 후 포인트가 정산됩니다.";
      deathOverlay.style.display = "flex";
      if (socket) { socket.emit("leave"); }
    }

    var camX = me ? me.x : latestState.worldSize / 2;
    var camY = me ? me.y : latestState.worldSize / 2;
    var w = canvas.width, h = canvas.height;

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, w, h);

    // 격자 배경
    ctx.strokeStyle = "#131c30";
    ctx.lineWidth = 1;
    var grid = 100;
    var offX = -(camX % grid), offY = -(camY % grid);
    for (var gx = offX; gx < w; gx += grid) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
    for (var gy = offY; gy < h; gy += grid) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

    function toScreen(x, y) { return [x - camX + w / 2, y - camY + h / 2]; }

    // 빨간 벽 (닿으면 죽음)
    var w0 = toScreen(0, 0);
    ctx.strokeStyle = "#e5484d";
    ctx.lineWidth = 6;
    ctx.strokeRect(w0[0], w0[1], latestState.worldSize, latestState.worldSize);

    // 먹이
    latestState.food.forEach(function (f) {
      var p = toScreen(f.x, f.y);
      if (p[0] < -20 || p[0] > w + 20 || p[1] < -20 || p[1] > h + 20) return;
      ctx.beginPath();
      ctx.arc(p[0], p[1], f.gold ? 6 : (f.fromKill ? 5 : 3.5), 0, Math.PI * 2);
      ctx.fillStyle = f.gold ? "#ffd54a" : (f.fromKill ? "#c77bff" : "#5fe07a");
      ctx.fill();
    });

    // 특수 아이템 (사라지기 3초 전부터 깜빡임)
    if (latestState.items) {
      latestState.items.forEach(function (it) {
        var p = toScreen(it.x, it.y);
        if (p[0] < -30 || p[0] > w + 30 || p[1] < -30 || p[1] > h + 30) return;
        if (it.ttl < 3000 && Math.floor(Date.now() / 200) % 2 === 0) return; // 깜빡
        ctx.save();
        ctx.shadowColor = it.good ? "#ffd54a" : "#ff5c5c";
        ctx.shadowBlur = 12;
        ctx.font = "22px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(it.glyph, p[0], p[1]);
        ctx.restore();
      });
    }

    // 지렁이
    latestState.snakes.forEach(function (s) {
      if (!s.alive) return;
      var color = s.isBot ? "#7a8aa8" : (s.id === myId ? "#3ad0ff" : "#ff7a59");
      ctx.fillStyle = color;
      s.segments.forEach(function (seg, idx) {
        var p = toScreen(seg.x, seg.y);
        var r = Math.max(3, s.radius * (idx === 0 ? 1 : 0.9));
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fill();
      });
      // 이름표
      var head = toScreen(s.x, s.y);
      ctx.fillStyle = "#fff";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(s.name + (s.shieldLeft > 0 ? " 🛡" : ""), head[0], head[1] - s.radius - 8);
    });

    if (me) {
      var fxTxt = "";
      if (me.fx) {
        if (me.fx.b > 0) fxTxt += " ⚡" + Math.ceil(me.fx.b / 1000) + "s";
        if (me.fx.m > 0) fxTxt += " 🧲" + Math.ceil(me.fx.m / 1000) + "s";
        if (me.fx.s > 0) fxTxt += " 🐌" + Math.ceil(me.fx.s / 1000) + "s";
      }
      hud.textContent = "크기: " + me.mass + " | 모드: " + (mode === "paid" ? "정상" : "무료") +
        " | 버프: " + (buffs.join(",") || "없음") + (fxTxt ? " |" + fxTxt : "");
    }

    // 반투명 조이스틱 오버레이
    if (joy.active && ctrlMode === "joy") {
      var jdx = joy.cx - joy.ox, jdy = joy.cy - joy.oy;
      var jd = Math.sqrt(jdx * jdx + jdy * jdy) || 1;
      var kx = joy.ox + jdx / jd * Math.min(jd, joy.R);
      var ky = joy.oy + jdy / jd * Math.min(jd, joy.R);
      ctx.beginPath(); ctx.arc(joy.ox, joy.oy, joy.R, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(kx, ky, 24, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.30)"; ctx.fill();
    }
  }
  requestAnimationFrame(draw);
})();
