'use strict';

/**
 * Publish the app through a free Cloudflare "quick tunnel".
 *
 *   node scripts/public.js
 *
 * It starts the server if it is not already running, opens a tunnel, prints the
 * public https:// address, copies it to the clipboard and points reminder
 * emails at it while the tunnel is up.
 *
 * Quick tunnels get a new random address every run. For a permanent one, use a
 * named Cloudflare tunnel with your own domain (see README).
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4321;
const LOCAL = `http://localhost:${PORT}`;
const CLOUDFLARED = path.join(ROOT, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const URL_FILE = path.join(store.DATA_DIR, 'public-url.txt');

if (!fs.existsSync(CLOUDFLARED)) {
  console.error(`\n  [!] ${CLOUDFLARED} is missing.`);
  console.error('      Download it once from https://github.com/cloudflare/cloudflared/releases');
  console.error('      (cloudflared-windows-amd64.exe) and save it as bin\\cloudflared.exe.\n');
  process.exit(1);
}

let server = null;
let tunnel = null;
let publicUrl = null;
let stopping = false;

async function serverIsUp() {
  try {
    await fetch(`${LOCAL}/api/session`);
    return true;
  } catch {
    return false;
  }
}

function copy(text) {
  if (process.platform !== 'win32') return;
  try {
    const clip = spawn('clip', [], { windowsHide: true });
    clip.stdin.end(text, 'utf8');
  } catch {
    /* clipboard is a nice-to-have */
  }
}

function showUrl(url) {
  if (publicUrl) return;
  publicUrl = url;

  try {
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.writeFileSync(URL_FILE, url, 'utf8');
  } catch {
    /* not fatal */
  }

  // Reminder emails should link to the public address while it is live.
  try {
    store.saveSettings({ appUrl: url });
  } catch {
    /* not fatal */
  }

  copy(url);

  const line = '='.repeat(60);
  console.log(`\n  ${line}`);
  console.log('   PUBLIC LINK (share this, password required):');
  console.log(`\n     ${url}\n`);
  console.log('   Copied to your clipboard.');
  console.log('   Keep this window open. Press Ctrl+C to stop sharing.');
  console.log(`  ${line}\n`);
}

function cleanup() {
  if (stopping) return;
  stopping = true;

  try {
    store.saveSettings({ appUrl: '' });
  } catch {
    /* ignore */
  }

  if (tunnel) tunnel.kill();
  if (server) server.kill();
}

process.on('SIGINT', () => {
  console.log('\n  Closing the public link…');
  cleanup();
  setTimeout(() => process.exit(0), 400);
});

process.on('exit', cleanup);

(async () => {
  if (!(await serverIsUp())) {
    console.log('  Starting the app server…');
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await serverIsUp()) break;
    }
    if (!(await serverIsUp())) {
      console.error(`  [!] The server did not start on ${LOCAL}.`);
      cleanup();
      process.exit(1);
    }
  } else {
    console.log(`  Using the app already running on ${LOCAL}.`);
  }

  console.log('  Opening a Cloudflare tunnel (no account needed)…');

  tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', LOCAL, '--no-autoupdate'], {
    windowsHide: true,
  });

  const scan = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) showUrl(match[0]);
    if (/\b(ERR|FTL)\b/.test(text)) process.stderr.write(text);
  };

  tunnel.stdout.on('data', scan);
  tunnel.stderr.on('data', scan);

  tunnel.on('error', (err) => {
    console.error(`  [!] Could not start cloudflared: ${err.message}`);
    cleanup();
    process.exit(1);
  });

  tunnel.on('close', (code) => {
    if (!stopping) {
      console.error(`  [!] The tunnel closed (code ${code}).`);
      cleanup();
      process.exit(1);
    }
  });
})();
