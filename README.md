# ULTIMATE-AI-FILM-STUDIO
AI Story Lab · Cinematic storytelling → storyboard → Google Flow prompts

เครื่องมือเขียนเรื่องสั้นแนวภาพยนตร์ แปลงเป็นฉาก/storyboard แล้วสร้าง prompt พร้อมคัดลอกไปใช้กับ Google Flow
หน้าเว็บ (`index.html`) ทำงานในเบราว์เซอร์ได้เลยโดยไม่ต้องมี API key ส่วน backend (`server.mjs`) เป็นตัวเลือกเสริม
สำหรับให้ Gemini ช่วยเขียน/ปรับปรุงเรื่องแบบสด

## ไฟล์ในโปรเจกต์

| ไฟล์ | หน้าที่ |
| --- | --- |
| `index.html` | หน้าเว็บหน้าเดียว ไม่ต้อง build มี 6 แท็บ: Overview, Story Bible, Scenes / Storyboard, Flow Prompts, Reference Assets, API / Developer |
| `server.mjs` | backend ตัวกลางเรียก Gemini (Node.js 20+ ไม่ต้องติดตั้ง package) |
| `.env.example` | ตัวอย่างค่าตั้ง คัดลอกเป็น `.env` |

## วิธีใช้แบบไม่ต้องมี backend
เปิด `index.html` ในเบราว์เซอร์ ตั้งค่าโปรเจกต์ กด "สร้างโครงเรื่อง + ฉาก" แล้วไปแท็บ Flow Prompts เพื่อคัดลอก prompt

## วิธีรัน backend (ให้ AI เขียนเนื้อหาแบบสด)

1. ต้องมี Node.js 20 ขึ้นไป
2. คัดลอก `.env.example` เป็น `.env` แล้วใส่ `GEMINI_API_KEY` (ขอได้ที่ Google AI Studio)
3. รัน `node server.mjs` (หรือ `npm start`)
4. เปิด `http://127.0.0.1:3000/` จะได้หน้าเว็บจาก server ตัวเดียวกัน
5. ไปแท็บ **API / Developer** ใส่ Backend URL เป็น `http://127.0.0.1:3000/api/generate`
   กด "ทดสอบการเชื่อมต่อ" แล้วกด "เรียก Backend เพื่อสร้าง Story" ผลลัพธ์จะเข้าช่อง Synopsis

อยากลองโดยไม่มี key: `MOCK=1 node server.mjs` (หรือ `npm run dev:mock`) server จะตอบข้อความทดสอบกลับมา

### Endpoint

| Method | Path | รายละเอียด |
| --- | --- | --- |
| `GET` | `/health` | ตอบ `{ ok, model, mock, hasKey }` |
| `POST` | `/api/generate` | รับ `{ "prompt": "...", "project": {...} }` ตอบ `{ "text": "..." }` ถ้า error ตอบ `{ "error": "..." }` |
| `GET` | `/` | เสิร์ฟ `index.html` |

### ค่าตั้ง (environment variable หรือ `.env`)

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
| --- | --- | --- |
| `GEMINI_API_KEY` | – | key ของ Gemini (จำเป็น ยกเว้นโหมด MOCK) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | ชื่อโมเดล เปลี่ยนได้ถ้ามีรุ่นใหม่กว่า |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | ที่อยู่ที่ server ฟัง |
| `ALLOWED_ORIGIN` | `*` | origin ที่อนุญาต (หลายค่าคั่นด้วย comma) |
| `RATE_LIMIT_PER_MIN` | `20` | จำนวนครั้งต่อนาทีต่อ IP |
| `MAX_PROMPT_CHARS` | `60000` | ความยาว prompt สูงสุด |
| `MOCK` | `0` | ตั้งเป็น `1` เพื่อทดสอบโดยไม่เรียก Gemini |

## ความปลอดภัย
- อย่าใส่ API key ใน `index.html` หรือ commit ไฟล์ `.env` (ถูกใส่ใน `.gitignore` แล้ว)
- ถ้าจะเปิด server ให้คนอื่นเข้าถึงผ่านอินเทอร์เน็ต ให้ตั้ง `ALLOWED_ORIGIN` เป็นโดเมนของคุณ และวางหลัง reverse proxy ที่มี HTTPS
  เพราะ server นี้ยังไม่มีระบบล็อกอิน ใครเข้าถึงได้ก็ใช้โควต้า key ของคุณได้ (มี rate limit ต่อ IP กันไว้ระดับหนึ่งเท่านั้น)
- backend นี้เรียก Gemini สำหรับสร้างข้อความ ไม่ได้ควบคุมหน้าเว็บของ Google Flow โดยตรง
