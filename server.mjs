// Ultimate AI Film Studio — backend ตัวกลางสำหรับเรียก Gemini
// Node.js 20+ ไม่ต้องติดตั้ง dependency เพิ่ม
//
//   GET  /health         -> { ok, model, mock, hasKey }
//   POST /api/generate   -> รับ { prompt, project } ตอบ { text }
//   GET  /               -> เสิร์ฟ index.html (เปิดหน้าเว็บจากพอร์ตเดียวกันได้เลย)
//
// ตั้งค่าด้วย environment variable หรือไฟล์ .env (ดู .env.example)

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- โหลด .env แบบง่าย (ไม่ทับค่าที่ตั้งไว้ใน environment แล้ว) ----------
const envFile = path.join(__dirname, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const MOCK = process.env.MOCK === '1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 12 * 1024 * 1024); // project อาจมีรูป dataUrl
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 60000);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);

// ---------- ตัวช่วย ----------
function corsHeaders(req) {
  const origin = req.headers.origin;
  let allow = '*';
  if (ALLOWED_ORIGIN !== '*') {
    const list = ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
    allow = origin && list.includes(origin) ? origin : list[0] || '';
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function sendJson(req, res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    ...corsHeaders(req),
  });
  res.end(data);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `ข้อมูลที่ส่งมาใหญ่เกินไป (จำกัด ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// rate limit ต่อ IP แบบง่ายในหน่วยความจำ ป้องกันคนอื่นยิงจนโควต้า key หมด
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k);
  return recent.length > RATE_LIMIT_PER_MIN;
}

// ---------- เรียก Gemini ----------
async function callGemini(prompt, jsonMode = false) {
  if (MOCK) {
    return `[MOCK] ได้รับ prompt ยาว ${prompt.length} ตัวอักษร\n\n` + prompt.slice(0, 400);
  }
  if (!API_KEY) {
    throw new HttpError(503, 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY บน server (ใส่ในไฟล์ .env หรือ environment variable)');
  }

  const url = `${API_BASE}/models/${encodeURIComponent(MODEL)}:generateContent`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: jsonMode ? { temperature: 0.65, responseMimeType: 'application/json' } : { temperature: 0.8 },
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new HttpError(504, 'Gemini ตอบช้าเกินกำหนด ลองใหม่อีกครั้ง');
    throw new HttpError(502, 'เชื่อมต่อ Gemini ไม่ได้: ' + e.message);
  }

  const raw = await upstream.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }

  if (!upstream.ok) {
    const detail = data?.error?.message || raw.slice(0, 200);
    // ส่งสถานะที่เข้าใจง่าย ไม่ส่งต่อ 401/403 ตรง ๆ เพราะจะสับสนกับ auth ของ server นี้
    const status = upstream.status === 429 ? 429 : 502;
    throw new HttpError(status, `Gemini ตอบกลับ ${upstream.status}: ${detail}`);
  }

  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) {
    const why = data?.promptFeedback?.blockReason || cand?.finishReason || 'ไม่มีข้อความตอบกลับ';
    throw new HttpError(502, `Gemini ไม่ส่งข้อความกลับมา (${why})`);
  }
  return text;
}

// ---------- เซิร์ฟเวอร์ ----------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(req, res, 200, { ok: true, model: MODEL, mock: MOCK, hasKey: Boolean(API_KEY) });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }


    if (req.method === 'POST' && pathname === '/api/production') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) throw new HttpError(429, `เรียกถี่เกินไป (จำกัด ${RATE_LIMIT_PER_MIN} ครั้งต่อนาที)`);
      const ctype = req.headers['content-type'] || '';
      if (!ctype.includes('application/json')) throw new HttpError(415, 'ต้องส่ง Content-Type: application/json');
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'JSON ไม่ถูกต้อง'); }
      const project = body?.project?.config || body?.project || {};
      const idea = String(project.idea || '').trim();
      if (!idea) throw new HttpError(400, 'กรุณาระบุไอเดียเรื่องก่อนสร้าง Production Package');
      const targetSeconds = Math.max(4, Math.min(3600, Number(project.length) || 60));
      const clipSeconds = Math.max(4, Math.min(10, Number(project.clipLength) || 8));
      const maxShots = Math.min(120, Math.ceil(targetSeconds / 4));
      const prompt = `You are an expert film director, screenwriter, storyboard artist and AI video prompt engineer.
Create a production-ready film package from the project below. Return ONLY valid JSON matching this schema:
{
 "story":{"logline":"...","synopsis":"...","beat1":"...","beat2":"...","beat3":"...","beat4":"..."},
 "continuity":"A concise continuity bible locking character appearance, costume, props, location, screen direction, lighting and color palette.",
 "shots":[{"id":"shot-01","sceneTitle":"Scene name","shotNumber":1,"title":"Specific shot title","shotType":"establishing|wide|medium|close-up|insert|tracking|action|POV|aerial|other","duration":8,"visual":"One concrete visible action with subject, environment, beginning-to-end movement and emotional beat.","camera":"Shot size, lens feel, angle, movement and composition.","lighting":"Motivated light sources, contrast, color palette and atmosphere.","audio":"Ambience, score and specific SFX.","voice":"Narration/dialogue or No dialogue.","transition":"How this shot connects to the next shot.","flowPrompt":"Complete English Google Flow prompt with continuity locks."}]
}
Rules:
- Story must be specific to the supplied idea, not a generic template. Build a coherent beginning, escalation, climax and resolution.
- Create sequential scene groups and multiple purposeful shots where duration allows. Every shot must advance story or reveal meaningful information.
- Total shot durations MUST equal exactly ${targetSeconds} seconds. Use shot durations between 4 and ${clipSeconds} seconds; adjust the final shot to hit the exact target. If the exact total cannot be achieved with these limits, use the nearest valid distribution while preserving the total exactly.
- Maximum ${maxShots} shots. Do not exceed target duration.
- Maintain character, wardrobe, prop, location, geography, screen direction and lighting continuity.
- Every shot must be visually filmable: specify what the camera sees and what changes during the shot. Avoid abstract descriptions.
- Prompt language: English for flowPrompt; story fields may use Thai when project language is Thai.
- Respect genre, style, aspect ratio, voice and sound requirements. Do not invent dialogue if no-dialogue is selected.
- Do not include Markdown fences or commentary. All required fields must be present.
PROJECT CONFIG:
${JSON.stringify(project)}
USER INSTRUCTION:
${String(body.instruction || 'Create the strongest cinematic adaptation of the idea.').slice(0,4000)}`;
      if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(413, 'คำสั่งยาวเกินขีดจำกัด');
      let production;
      if (MOCK) {
        const n = Math.max(1, Math.ceil(targetSeconds / clipSeconds));
        let remaining = targetSeconds;
        const shots = Array.from({length:n}, (_,i) => {
          const duration = Math.min(clipSeconds, remaining - Math.max(0,n-i-1)*4);
          remaining -= duration;
          return {id:`mock-${i+1}`,sceneTitle:`Scene ${Math.floor(i/2)+1}`,shotNumber:i+1,title:`Shot ${i+1}`,shotType:i===0?'establishing':'cinematic',duration,visual:`${idea} — shot progression ${i+1}`,camera:'Cinematic wide-to-medium coverage, controlled dolly',lighting:`${project.style || 'Photorealistic cinema'}, motivated lighting`,audio:project.sound || 'Cinematic score and ambience',voice:project.voiceLang?.includes('No dialogue')?'No dialogue.':'Thai narration',transition:'Motivated cut on action',flowPrompt:''};
        });
        production = {story:{logline:idea,synopsis:`Mock production package for ${project.name || 'Untitled'}: ${idea}`,beat1:'Establish the world and protagonist.',beat2:'Reveal the central obstacle.',beat3:'Confront the decisive challenge.',beat4:'Resolve the conflict with a memorable final image.'},continuity:`CHARACTER LOCK: ${project.character || 'Maintain consistent protagonist'}\\nWORLD LOCK: ${project.setting || 'Maintain consistent setting'}\\nSTYLE LOCK: ${project.style || 'Cinematic realism'}`,shots};
      } else {
        const raw = await callGemini(prompt, true);
        try { production = JSON.parse(raw); }
        catch { throw new HttpError(502, 'Gemini ส่ง JSON ไม่ถูกต้อง กรุณาลองสร้างใหม่'); }
      }
      if (!production || !production.story || !Array.isArray(production.shots) || production.shots.length === 0) {
        throw new HttpError(502, 'AI ส่ง Production Package ไม่ครบ schema');
      }
      production.shots = production.shots.slice(0, maxShots).map((shot, i) => ({
        id: String(shot.id || `shot-${i+1}`), sceneTitle: String(shot.sceneTitle || `Scene ${i+1}`),
        shotNumber: Number(shot.shotNumber) || i+1, title: String(shot.title || `Shot ${i+1}`),
        shotType: String(shot.shotType || 'cinematic'), duration: Math.max(1, Number(shot.duration) || clipSeconds),
        visual: String(shot.visual || ''), camera: String(shot.camera || ''), lighting: String(shot.lighting || ''),
        audio: String(shot.audio || ''), voice: String(shot.voice || ''), transition: String(shot.transition || ''),
        flowPrompt: String(shot.flowPrompt || '')
      }));
      const sum = production.shots.reduce((n, shot) => n + shot.duration, 0);
      if (sum !== targetSeconds) {
        let delta = targetSeconds - sum;
        const last = production.shots[production.shots.length - 1];
        if (last.duration + delta >= 1) last.duration += delta;
        else throw new HttpError(502, `AI สร้างความยาวรวม ${sum}s ไม่ตรงเป้าหมาย ${targetSeconds}s กรุณาลองใหม่`);
      }
      return sendJson(req, res, 200, { production, totalDuration: production.shots.reduce((n, shot) => n + shot.duration, 0), model: MODEL, mock: MOCK });
    }

    if (req.method === 'POST' && pathname === '/api/generate') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) {
        throw new HttpError(429, `เรียกถี่เกินไป (จำกัด ${RATE_LIMIT_PER_MIN} ครั้งต่อนาที) รอสักครู่แล้วลองใหม่`);
      }

      const ctype = req.headers['content-type'] || '';
      if (!ctype.includes('application/json')) throw new HttpError(415, 'ต้องส่ง Content-Type: application/json');

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'JSON ไม่ถูกต้อง'); }

      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) throw new HttpError(400, 'ต้องมี field "prompt" เป็นข้อความ');
      if (prompt.length > MAX_PROMPT_CHARS) {
        throw new HttpError(413, `prompt ยาวเกินไป (${prompt.length} ตัวอักษร จำกัด ${MAX_PROMPT_CHARS})`);
      }

      const text = await callGemini(prompt, false);
      return sendJson(req, res, 200, { text });
    }

    throw new HttpError(404, 'ไม่พบ endpoint นี้');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(req, res, status, { error: status === 500 ? 'เกิดข้อผิดพลาดภายใน server' : e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ultimate AI Film Studio backend: http://${HOST}:${PORT}`);
  console.log(`  หน้าเว็บ:  http://${HOST}:${PORT}/`);
  console.log(`  API:      POST http://${HOST}:${PORT}/api/generate`);
  console.log(`  โมเดล:    ${MODEL}  |  key: ${API_KEY ? 'ตั้งแล้ว' : 'ยังไม่ได้ตั้ง'}${MOCK ? '  |  MOCK mode' : ''}`);
});
