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
async function callGemini(prompt) {
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
        generationConfig: { temperature: 0.8 },
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

      const text = await callGemini(prompt);
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
