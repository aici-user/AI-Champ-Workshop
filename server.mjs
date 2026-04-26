/**
 * AI Champ — Backend Server
 * Serves static files + OTP authentication API
 *
 * SMS provider : Fast2SMS (fast2sms.com) — Indian numbers only
 * Email        : Nodemailer via Gmail SMTP (or any SMTP)
 *
 * Start: node server.mjs
 * Requires .env (copy from .env.example and fill in your keys)
 */

import http    from 'http';
import https   from 'https';
import fs      from 'fs';
import path    from 'path';
import crypto  from 'crypto';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env manually (no dotenv dependency needed) ──────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || '3000', 10);

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ── In-memory stores (survive restarts by using a file if you want persistence)
// otpStore: key = "phone:XXXXXXXXXX" or "email:user@example.com"
//           val = { otp, expiresAt, attempts, lastSentAt }
const otpStore  = new Map();

// sessionStore: key = sessionId (random hex)
//               val = { identifier, type: 'phone'|'email', loginAt }
const sessionStore = new Map();

const OTP_EXPIRY_MS   = 10 * 60 * 1000;  // 10 minutes
const OTP_COOLDOWN_MS = 60 * 1000;        // 60 seconds between resends
const MAX_ATTEMPTS    = 5;                 // wrong guesses before lockout

// ── OTP helpers ───────────────────────────────────────────────────────────────
function genOTP() {
  // Cryptographically random 6-digit OTP
  return String(crypto.randomInt(100000, 999999));
}

function storeOTP(key, otp) {
  otpStore.set(key, {
    otp,
    expiresAt:  Date.now() + OTP_EXPIRY_MS,
    lastSentAt: Date.now(),
    attempts:   0,
  });
}

function getOTPEntry(key) {
  const entry = otpStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { otpStore.delete(key); return null; }
  return entry;
}

// ── SMS via Fast2SMS (Quick SMS route — no website verification needed) ───────
function sendSMS(phone, otp) {
  return new Promise((resolve, reject) => {
    const apiKey = (process.env.FAST2SMS_API_KEY || '').trim();
    if (!apiKey) {
      reject(new Error('FAST2SMS_API_KEY not set in .env'));
      return;
    }

    const body = JSON.stringify({
      route:   'q',
      message: `Your AI Champ OTP is ${otp}. Valid for 10 minutes. Do not share this code with anyone.`,
      numbers: phone,
      flash:   0,
    });

    const options = {
      hostname: 'www.fast2sms.com',
      path:     '/dev/bulkV2',
      method:   'POST',
      headers:  {
        'authorization':  apiKey,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log('[Fast2SMS raw response]', data);
        try {
          const json = JSON.parse(data);
          if (json.return === true) {
            resolve(json);
          } else {
            reject(new Error(json.message || JSON.stringify(json)));
          }
        } catch (e) {
          reject(new Error('Fast2SMS parse error: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Email via Nodemailer ──────────────────────────────────────────────────────
async function sendEmail(email, otp) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) throw new Error('EMAIL_USER / EMAIL_PASS not set in .env');

  // Gmail App Passwords are shown with spaces for readability — strip them
  const cleanPass = pass.replace(/\s/g, '');
  const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user, pass: cleanPass },
  });

  await transporter.sendMail({
    from: `"AI Champ" <${user}>`,
    to:   email,
    subject: 'Your AI Champ Login OTP',
    text: `Your OTP is: ${otp}\n\nThis code expires in 10 minutes.\nDo not share it with anyone.\n\n— AI Champ Team`,
    html: `
<div style="font-family:'Segoe UI',sans-serif;max-width:440px;margin:auto;padding:2rem;border:1px solid #d4ece5;border-radius:16px;background:#f5fdf9;">
  <div style="text-align:center;margin-bottom:1.5rem;">
    <span style="font-family:Montserrat,sans-serif;font-size:1.4rem;font-weight:900;color:#D20E07;">AI Champ</span>
    <span style="font-family:Montserrat,sans-serif;font-size:.7rem;font-weight:700;color:#056b45;display:block;letter-spacing:.12em;text-transform:uppercase;margin-top:2px;">Login Verification</span>
  </div>
  <p style="color:#1a3a32;font-size:.9rem;margin:0 0 1rem;">Your One-Time Password to sign in to AI Champ:</p>
  <div style="font-size:2.8rem;font-weight:900;letter-spacing:.28em;color:#0d2520;text-align:center;padding:1.25rem;background:#fff;border:2px solid rgba(210,14,7,.25);border-radius:12px;margin:0 0 1rem;">${otp}</div>
  <p style="color:#3d6b5e;font-size:.78rem;margin:0;">This OTP expires in <strong>10 minutes</strong>. Never share it with anyone — AI Champ will never ask for it.</p>
</div>`,
  });
}

// ── Session helpers ───────────────────────────────────────────────────────────
function createSession(type, identifier) {
  const id = crypto.randomBytes(32).toString('hex');
  sessionStore.set(id, { type, identifier, loginAt: Date.now() });
  return id;
}

function getSession(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)aicsid=([^;]+)/);
  if (!match) return null;
  return sessionStore.get(match[1]) || null;
}

function setCookieHeader(sessionId) {
  // 30-day session, HttpOnly, SameSite=Strict
  return `aicsid=${sessionId}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Strict`;
}

// ── Request body reader ───────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── JSON response helpers ─────────────────────────────────────────────────────
function jsonOK(res, data, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  res.writeHead(200, headers);
  res.end(JSON.stringify(data));
}

function jsonErr(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// ── CORS (for localhost dev) ──────────────────────────────────────────────────
function addCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Main request handler ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[Server error]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

async function handleRequest(req, res) {
  addCORS(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // ── API: Health check ──────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/health') {
    return jsonOK(res, {
      ok: true,
      sms:   !!process.env.FAST2SMS_API_KEY,
      email: !!(process.env.EMAIL_USER && process.env.EMAIL_PASS),
    });
  }

  // ── Play Store / TWA verification (Digital Asset Links) ───────────────────
  // Replace sha256_cert_fingerprints with your actual keystore SHA-256 after signing.
  // Get it with: keytool -list -v -keystore your-key.jks
  if (req.method === 'GET' && url === '/.well-known/assetlinks.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.aichamp.app',
        sha256_cert_fingerprints: [
          process.env.APP_SHA256_FINGERPRINT ||
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
        ]
      }
    }]));
    return;
  }

  // ── API: Send OTP ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/send-otp') {
    const body = await readBody(req);
    const { type, value } = body; // type: 'phone' | 'email'

    if (type === 'phone') {
      const phone = String(value || '').replace(/\D/g, '').slice(-10);
      if (phone.length !== 10) return jsonErr(res, 400, 'Enter a valid 10-digit mobile number.');

      const key = `phone:${phone}`;
      const existing = otpStore.get(key);
      if (existing && Date.now() - existing.lastSentAt < OTP_COOLDOWN_MS) {
        const wait = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
        return jsonErr(res, 429, `Please wait ${wait}s before requesting another OTP.`);
      }

      const otp = genOTP();
      storeOTP(key, otp);

      try {
        await sendSMS(phone, otp);
        console.log(`[OTP] SMS sent to +91${phone}`);
        return jsonOK(res, { success: true, message: `OTP sent to +91 ${phone}` });
      } catch (err) {
        console.error('[OTP] SMS error:', err.message);
        otpStore.delete(key);
        // Surface the actual Fast2SMS message to the user
        return jsonErr(res, 502, err.message || 'Failed to send SMS. Check your Fast2SMS API key in .env');
      }
    }

    if (type === 'email') {
      const email = String(value || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return jsonErr(res, 400, 'Enter a valid email address.');

      const key = `email:${email}`;
      const existing = otpStore.get(key);
      if (existing && Date.now() - existing.lastSentAt < OTP_COOLDOWN_MS) {
        const wait = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
        return jsonErr(res, 429, `Please wait ${wait}s before requesting another OTP.`);
      }

      const otp = genOTP();
      storeOTP(key, otp);

      try {
        await sendEmail(email, otp);
        console.log(`[OTP] Email sent to ${email}`);
        return jsonOK(res, { success: true, message: `OTP sent to ${email}` });
      } catch (err) {
        console.error('[OTP] Email error:', err.message);
        otpStore.delete(key);
        return jsonErr(res, 502, 'Failed to send email. Check your EMAIL_USER / EMAIL_PASS in .env');
      }
    }

    return jsonErr(res, 400, 'Invalid type. Use "phone" or "email".');
  }

  // ── API: Verify OTP ────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/verify-otp') {
    const body = await readBody(req);
    const { type, value, otp } = body;

    let key, identifier;
    if (type === 'phone') {
      const phone = String(value || '').replace(/\D/g, '').slice(-10);
      if (phone.length !== 10) return jsonErr(res, 400, 'Invalid phone number.');
      key = `phone:${phone}`;
      identifier = `+91 ${phone}`;
    } else if (type === 'email') {
      const email = String(value || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonErr(res, 400, 'Invalid email.');
      key = `email:${email}`;
      identifier = email;
    } else {
      return jsonErr(res, 400, 'Invalid type.');
    }

    const entry = getOTPEntry(key);
    if (!entry) return jsonErr(res, 400, 'OTP expired or not found. Please request a new one.');

    if (entry.attempts >= MAX_ATTEMPTS) {
      otpStore.delete(key);
      return jsonErr(res, 429, 'Too many incorrect attempts. Please request a new OTP.');
    }

    if (String(otp).trim() !== entry.otp) {
      entry.attempts++;
      const left = MAX_ATTEMPTS - entry.attempts;
      return jsonErr(res, 401, left > 0
        ? `Incorrect OTP. ${left} attempt${left === 1 ? '' : 's'} remaining.`
        : 'Too many incorrect attempts. Please request a new OTP.');
    }

    // ✅ OTP correct
    otpStore.delete(key);
    const sessionId = createSession(type, identifier);
    console.log(`[Auth] Logged in: ${identifier}`);

    return jsonOK(res,
      { success: true, user: { type, identifier } },
      { 'Set-Cookie': setCookieHeader(sessionId) }
    );
  }

  // ── API: Get session ───────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/session') {
    const session = getSession(req.headers.cookie);
    if (session) {
      return jsonOK(res, { loggedIn: true, user: { type: session.type, identifier: session.identifier } });
    }
    return jsonOK(res, { loggedIn: false });
  }

  // ── API: Logout ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/logout') {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/(?:^|;\s*)aicsid=([^;]+)/);
    if (match) sessionStore.delete(match[1]);
    res.setHeader('Set-Cookie', 'aicsid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    return jsonOK(res, { success: true });
  }

  // ── Static files ───────────────────────────────────────────────────────────
  let urlPath = url === '/' ? '/index.html' : url;
  const filePath = path.join(__dirname, urlPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 Not Found'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`\n  AI Champ server running at http://localhost:${PORT}`);
  console.log(`  OTP expiry   : 10 minutes`);
  console.log(`  Resend delay : 60 seconds`);
  console.log(`  Max attempts : ${MAX_ATTEMPTS} per OTP\n`);
  if (!process.env.FAST2SMS_API_KEY) console.warn('  ⚠  FAST2SMS_API_KEY not set — SMS OTP will fail');
  if (!process.env.EMAIL_USER)       console.warn('  ⚠  EMAIL_USER not set — Email OTP will fail');
});
