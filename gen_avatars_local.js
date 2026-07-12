// 로컬 사전 합성 생성기 — Render의 Gemini 키가 고장난 동안 아바타 합성 이미지를 미리 만들어 커밋
// 사용: node gen_avatars_local.js <kongzId> <stageFrom> <stageTo>
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const GEMINI_KEYS = (process.env.GEMINI_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean);
let keyIdx = 0;
const GEMINI_API_KEY = GEMINI_KEYS[keyIdx % GEMINI_KEYS.length]; // 폴백용 첫 키
const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const outfitsCode = src.match(/const STAGE_OUTFITS = \[[\s\S]*?\];/)[0];
eval(outfitsCode.replace("const STAGE_OUTFITS", "var STAGE_OUTFITS"));

const profile = JSON.parse(fs.readFileSync(process.env.LOCALAPPDATA + "/Temp/claude/profile.json", "utf8"));
const imgMap = profile.imgMap || {};

async function gen(id, stage) {
  const out = path.join(__dirname, "public", "gen", `avatar_${id}_${stage}.png`);
  if (fs.existsSync(out)) { console.log(`skip ${id}_${stage} (있음)`); return true; }
  const orig = imgMap[id] || `https://punkykongz.com/nft/punkykongz/image/${id}.jpg`;
  let imgRes = await fetch(`https://cdn.helius-rpc.com/cdn-cgi/image/width=512/${orig}`);
  if (!imgRes.ok) imgRes = await fetch(orig);
  if (!imgRes.ok) { console.log(`원본 실패 ${id}: ${imgRes.status}`); return false; }
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
  if (fs.existsSync(bgPath)) parts.push({ inline_data: { mime_type: "image/webp", data: fs.readFileSync(bgPath).toString("base64") } });

  const key = GEMINI_KEYS[keyIdx % GEMINI_KEYS.length]; keyIdx++; // 키 순환
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:2" } } }) }
  );
  const json = await res.json();
  const outParts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  for (const p of outParts) {
    if (p.inlineData && p.inlineData.data) {
      fs.writeFileSync(out, Buffer.from(p.inlineData.data, "base64"));
      console.log(`OK ${id} 등급${stage} → ${Math.round(fs.statSync(out).size / 1024)}KB`);
      return true;
    }
  }
  console.log(`실패 ${id}_${stage}:`, JSON.stringify(json).slice(0, 200));
  return false;
}

(async () => {
  const id = parseInt(process.argv[2], 10);
  const from = parseInt(process.argv[3], 10), to = parseInt(process.argv[4], 10);
  for (let st = from; st <= to; st++) {
    try { await gen(id, st); } catch (e) { console.log(`오류 ${id}_${st}:`, e.message); }
    await new Promise((r) => setTimeout(r, 3000)); // 무료 티어 속도 배려
  }
})();
