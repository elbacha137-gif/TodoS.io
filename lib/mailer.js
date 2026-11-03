'use strict';

/**
 * Email sending with three transports:
 *
 *  1. "formsubmit"  – no password, no account. The first email is a one-time
 *                     confirmation from formsubmit.co; click it once and it works.
 *  2. "smtp"        – your own mailbox (Gmail app password, Outlook, ...),
 *                     sent with curl (built into Windows 10/11).
 *  3. "outbox"      – writes a .eml file to data/outbox you can open in any
 *                     mail client and send yourself. Works fully offline.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const store = require('./store');

/* ------------------------------- helpers -------------------------------- */

function wrap76(base64) {
  return base64.replace(/(.{76})/g, '$1\r\n').trimEnd();
}

function encodeHeader(value) {
  const text = String(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function escapeCurl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function slug(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase() || 'reminder';
}

function buildMime({ from, to, subject, text, html }) {
  const boundary = `todo_${crypto.randomBytes(12).toString('hex')}`;
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@todo-reminder.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html, 'utf8').toString('base64')),
    `--${boundary}--`,
    '',
  ];
  return parts.join('\r\n');
}

/* ------------------------------ transports ------------------------------ */

async function sendWithFormSubmit({ to, subject, text, html }) {
  const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(to)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      _subject: subject,
      name: 'Todo Reminder',
      message: text,
      _template: 'box',
    }),
    signal: AbortSignal.timeout(25000),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      transport: 'formsubmit',
      detail: `formsubmit.co answered ${res.status}. ${payload?.message || ''}`.trim(),
    };
  }

  const message = String(payload?.message || '');
  const needsActivation = /activat|confirm/i.test(message);

  return {
    ok: true,
    transport: 'formsubmit',
    detail: needsActivation
      ? 'Check your inbox: formsubmit.co sent a one-time confirmation link. Click it to activate automatic emails.'
      : message || 'Sent through formsubmit.co',
    needsActivation,
  };
}

async function sendWithWeb3Forms(settings, message) {
  const key = String(settings.web3formsKey || '').trim();
  if (!key) {
    return {
      ok: false,
      transport: 'web3forms',
      detail: 'No Web3Forms access key yet. Get a free one at web3forms.com and paste it in Settings.',
    };
  }

  const body = JSON.stringify({
    access_key: key,
    subject: message.subject,
    from_name: 'Todo Reminder',
    message: message.text,
    botcheck: false,
  });

  const file = path.join(os.tmpdir(), `todo-web3forms-${Date.now()}.json`);
  fs.writeFileSync(file, body, 'utf8');

  // curl with browser-like headers: Cloudflare (which fronts Web3Forms) rejects
  // plain Node requests with a 403 challenge page.
  const config = [
    'url = "https://api.web3forms.com/submit"',
    'request = "POST"',
    'header = "Content-Type: application/json"',
    'header = "Accept: application/json"',
    'header = "Origin: https://web3forms.com"',
    'header = "Referer: https://web3forms.com/"',
    `header = "User-Agent: ${BROWSER_UA}"`,
    `data-binary = "@${escapeCurl(file.replace(/\\/g, '/'))}"`,
    'write-out = "\\n__STATUS__:%{http_code}"',
    'silent',
    'show-error',
    'max-time = 30',
  ].join('\n');

  const result = await runCurl(config);
  fs.rm(file, { force: true }, () => {});

  if (!result.ok) {
    return { ok: false, transport: 'web3forms', detail: result.detail || 'curl failed' };
  }

  const marker = /\n?__STATUS__:(\d{3})\s*$/;
  const match = result.stdout.match(marker);
  const status = match ? Number(match[1]) : 0;
  const raw = result.stdout.replace(marker, '').trim();

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (status >= 400 || !payload?.success) {
    const blocked = status === 403 && /just a moment|cloudflare/i.test(raw);
    return {
      ok: false,
      transport: 'web3forms',
      detail: blocked
        ? 'Web3Forms blocked the request (Cloudflare). Try again in a minute, or use Gmail SMTP.'
        : payload?.message || `Web3Forms answered HTTP ${status || '?'}`,
    };
  }

  return {
    ok: true,
    transport: 'web3forms',
    detail: payload.message || 'Delivered by Web3Forms',
  };
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function runCurl(configText) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('curl', ['--config', '-'], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: '', detail: `curl could not start: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('error', (err) => {
      resolve({ ok: false, stdout, stderr, detail: `curl is not available: ${err.message}` });
    });

    proc.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        detail: (code === 0 ? stdout : stderr || stdout || `curl exited with code ${code}`).trim(),
      });
    });

    proc.stdin.end(configText);
  });
}

async function sendWithSmtp(settings, message) {
  const cfg = settings.smtp || {};
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return {
      ok: false,
      transport: 'smtp',
      detail: 'SMTP is selected but the host / username / password are incomplete.',
    };
  }

  const from = cfg.from || cfg.user;
  const raw = buildMime({ from, to: settings.email, subject: message.subject, text: message.text, html: message.html });
  const file = path.join(os.tmpdir(), `todo-reminder-${Date.now()}.eml`);
  fs.writeFileSync(file, raw, 'utf8');

  const scheme = cfg.secure ? 'smtps' : 'smtp';
  const config = [
    `url = "${escapeCurl(`${scheme}://${cfg.host}:${cfg.port}`)}"`,
    `user = "${escapeCurl(`${cfg.user}:${cfg.pass}`)}"`,
    `mail-from = "${escapeCurl(from)}"`,
    `mail-rcpt = "${escapeCurl(settings.email)}"`,
    `upload-file = "${escapeCurl(file.replace(/\\/g, '/'))}"`,
    cfg.secure ? '' : 'ssl-reqd',
    'silent',
    'show-error',
    'max-time = 60',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await runCurl(config);
  fs.rm(file, { force: true }, () => {});

  return {
    ok: result.ok,
    transport: 'smtp',
    detail: result.detail || (result.ok ? 'Accepted by the mail server' : 'curl failed'),
  };
}

function writeToOutbox(settings, message) {
  const dir = path.join(store.DATA_DIR, 'outbox');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${stamp}-${slug(message.subject)}.eml`);
  const raw = buildMime({
    from: 'todo-reminder@localhost',
    to: settings.email || 'you@example.com',
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  fs.writeFileSync(file, raw, 'utf8');
  return { ok: true, transport: 'outbox', detail: `Saved to ${file}`, file };
}

/* --------------------------------- API ---------------------------------- */

/**
 * @param {object} settings full settings (contains the SMTP password)
 * @param {{subject:string, text:string, html:string}} message
 */
async function send(settings, message) {
  if (!settings.email) {
    return {
      ok: false,
      transport: settings.transport,
      detail: 'No recipient email address configured.',
    };
  }

  try {
    switch (settings.transport) {
      case 'smtp':
        return await sendWithSmtp(settings, message);
      case 'outbox':
        return writeToOutbox(settings, message);
      case 'formsubmit':
        return await sendWithFormSubmit({ to: settings.email, ...message });
      case 'web3forms':
      default:
        return await sendWithWeb3Forms(settings, message);
    }
  } catch (err) {
    return { ok: false, transport: settings.transport, detail: err.message };
  }
}

function leadLabel(hours) {
  const total = Math.max(0, Number(hours) || 0);
  const days = Math.floor(total / 24);
  const rest = Math.round((total % 24) * 10) / 10;
  const parts = [];
  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (rest) parts.push(`${rest} h`);
  return parts.join(' ') || '0 h';
}

async function sendTest(settings) {
  return send(settings, {
    subject: '✅ Todo reminders are working',
    text: [
      'Your todo app can reach you by email.',
      '',
      `Deadline reminders will arrive ${leadLabel(settings.leadHours)} before each due date.`,
      '',
      '— Todo Reminder',
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.6;color:#1f2333">
        <h2 style="margin:0 0 12px">✅ Todo reminders are working</h2>
        <p>Your todo app can reach you by email.</p>
        <p>Deadline reminders will arrive <strong>${leadLabel(settings.leadHours)}</strong> before each due date.</p>
        <p style="color:#6b7280;font-size:14px">— Todo Reminder</p>
      </div>`,
  });
}

module.exports = { send, sendTest, buildMime };
