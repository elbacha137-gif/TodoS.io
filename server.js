'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./lib/store');
const auth = require('./lib/auth');
const { runReminderCheck } = require('./lib/reminders');
const mailer = require('./lib/mailer');
const { listIps, primaryIp } = require('./lib/net');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 so your phone can reach it on the same Wi-Fi
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------- helpers -------------------------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/* ----------------------------- access control ---------------------------- */

const SESSION_COOKIE = 'todo_session';
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, resetAt }

function sessionToken(req) {
  return auth.parseCookies(req.headers.cookie || '')[SESSION_COOKIE] || '';
}

function clientIp(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function tooManyFailures(ip) {
  const record = loginFailures.get(ip);
  if (!record || record.resetAt < Date.now()) return false;
  return record.count >= MAX_LOGIN_FAILURES;
}

function countFailure(ip) {
  const now = Date.now();
  const record = loginFailures.get(ip);
  if (!record || record.resetAt < now) loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else record.count += 1;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  const https =
    req.socket.encrypted ||
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() === 'https';
  if (https) parts.push('Secure');
  return parts.join('; ');
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);

  // Never escape the public folder.
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function snapshot(userId) {
  const settings = store.publicSettings(userId);
  const todoList = store.getTodos(userId);
  const user = store.findUserById(userId);
  return {
    todos: todoList,
    settings,
    user: user ? { id: user.id, email: user.email } : null,
    meta: {
      now: new Date().toISOString(),
      leadHours: settings.leadHours,
      emailReady: Boolean(settings.email),
      transport: settings.transport,
      remindersReady:
        settings.transport === 'outbox' ||
        (settings.transport === 'web3forms' && Boolean(settings.hasWeb3FormsKey)) ||
        (settings.transport === 'smtp' && Boolean(settings.smtp.user && settings.smtp.hasPassword)),
      log: store.getLog(userId).slice(0, 8),
      dataDir: store.DATA_DIR,
    },
  };
}

/* -------------------------------- routes -------------------------------- */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  /* ---------------------------- sign-in gate ---------------------------- */

  function userIdOf(req) {
    return auth.isValidSession(sessionToken(req));
  }

  if (pathname === '/api/session' && method === 'GET') {
    const userId = userIdOf(req);
    const user = userId ? store.findUserById(userId) : null;
    return json(res, 200, {
      authenticated: Boolean(userId),
      user: user ? { id: user.id, email: user.email } : null,
      needsSetup: store.getUsers().length === 0,
    });
  }

  if (pathname === '/api/register' && method === 'POST') {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) {
      return json(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    }

    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(res, 400, { error: 'Enter a valid email address.' });
    }
    if (password.length < 8) {
      return json(res, 400, { error: 'Use at least 8 characters for the password.' });
    }
    if (store.findUserByEmail(email)) {
      countFailure(ip);
      return json(res, 409, { error: 'An account with that email already exists.' });
    }

    loginFailures.delete(ip);
    const user = store.createUser(email, auth.hashPassword(password));
    const token = auth.createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, token, auth.SESSION_TTL_MS / 1000));
    return json(res, 200, { ok: true, user: { id: user.id, email: user.email }, state: snapshot(user.id) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) {
      return json(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    }

    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    const user = store.findUserByEmail(email);
    if (!user || !auth.verifyPassword(password, user.passwordHash)) {
      countFailure(ip);
      return json(res, 401, { error: 'Wrong email or password.' });
    }

    loginFailures.delete(ip);
    const token = auth.createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, token, auth.SESSION_TTL_MS / 1000));
    return json(res, 200, { ok: true, user: { id: user.id, email: user.email }, state: snapshot(user.id) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    auth.destroySession(sessionToken(req));
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return json(res, 200, { ok: true });
  }

  // Everything below is private.
  const userId = userIdOf(req);
  if (!userId) return json(res, 401, { error: 'Not signed in.' });

  if (pathname === '/api/state' && method === 'GET') {
    return json(res, 200, snapshot(userId));
  }

  if (pathname === '/api/todos' && method === 'POST') {
    const body = await readBody(req);
    if (!body.title || !String(body.title).trim()) {
      return json(res, 400, { error: 'A title is required.' });
    }
    const todo = store.addTodo(userId, body);
    return json(res, 201, { todo, state: snapshot(userId) });
  }

  if (parts[1] === 'todos' && parts[2]) {
    const id = decodeURIComponent(parts[2]);

    if (method === 'PATCH' || method === 'PUT') {
      const body = await readBody(req);
      const todo = store.updateTodo(userId, id, body);
      if (!todo) return json(res, 404, { error: 'Task not found.' });
      return json(res, 200, { todo, state: snapshot(userId) });
    }

    if (method === 'DELETE') {
      const removed = store.deleteTodo(userId, id);
      if (!removed) return json(res, 404, { error: 'Task not found.' });
      return json(res, 200, { ok: true, state: snapshot(userId) });
    }
  }

  if (pathname === '/api/settings' && (method === 'PUT' || method === 'PATCH')) {
    const body = await readBody(req);
    const patch = { ...body };

    if (patch.smtp) {
      const smtp = { ...patch.smtp };
      if (!smtp.pass) delete smtp.pass;
      smtp.port = Number(smtp.port) || 465;
      smtp.secure = Boolean(smtp.secure);
      patch.smtp = smtp;
    }

    const saved = store.saveSettings(userId, patch);
    return json(res, 200, { settings: store.publicSettings(userId), savedHasPassword: Boolean(saved.smtp.pass), state: snapshot(userId) });
  }

  if (pathname === '/api/check-now' && method === 'POST') {
    const result = await runReminderCheck();
    return json(res, 200, { result, state: snapshot(userId) });
  }

  if (pathname === '/api/test-email' && method === 'POST') {
    const settings = store.getSettings(userId);
    const user = store.findUserById(userId);
    if (!user) return json(res, 400, { error: 'Account not found.' });
    settings.email = user.email;
    if (!settings.email) return json(res, 400, { error: 'Add your email address first.' });
    const result = await mailer.sendTest(settings);
    store.appendLog(userId, { kind: 'test', ok: result.ok, transport: result.transport, detail: result.detail, tasks: [] });
    return json(res, 200, { result, state: snapshot(userId) });
  }

  return json(res, 404, { error: `Unknown API route: ${method} ${pathname}` });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('[api]', err);
      json(res, 500, { error: err.message });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  serveStatic(req, res, url.pathname);
});

/* --------------------------- in-app scheduler --------------------------- */
// Windows Task Scheduler is the primary runner; this is a safety net while
// the server happens to be open.

const CHECK_EVERY = 10 * 60 * 1000;
let checking = false;

async function backgroundCheck(label) {
  if (checking) return;
  checking = true;
  try {
    const result = await runReminderCheck();
    if (result.sent) {
      console.log(`[reminder] ${label}: emailed ${result.sent} task(s) — ${result.reason || ''}`);
    }
  } catch (err) {
    console.error('[reminder]', err.message);
  } finally {
    checking = false;
  }
}

function banner() {
  const ips = listIps();
  const line = '='.repeat(52);
  console.log(`\n  ${line}`);
  console.log('   [OK]  Todo Reminder is running');
  console.log(`  ${line}`);
  console.log(`   This PC : http://localhost:${PORT}`);
  if (ips.length) {
    console.log(`   Phone   : http://${ips[0]}:${PORT}   (same Wi-Fi)`);
    for (const ip of ips.slice(1)) console.log(`             http://${ip}:${PORT}`);
  }
  console.log(`   Data    : ${store.DATA_DIR}`);
  console.log(`  ${line}\n`);
}

server.listen(PORT, HOST, () => {
  banner();
  primaryIp().then((ip) => {
    if (ip && ip !== 'localhost' && !listIps().includes(ip)) {
      console.log(`  [i] Main network address seems to be ${ip}.\n`);
    }
  });
  const users = store.getUsers();
  if (!users.length) {
    console.log('  [!] No accounts yet - open the app to create the first one.\n');
  } else {
    console.log(`  [i] ${users.length} account(s) registered.\n`);
  }
  setTimeout(() => backgroundCheck('startup'), 4000);
  setInterval(() => backgroundCheck('interval'), CHECK_EVERY);
});

process.on('SIGINT', () => {
  console.log('\nGoodbye.');
  process.exit(0);
});
