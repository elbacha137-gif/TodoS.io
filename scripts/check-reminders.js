#!/usr/bin/env node
'use strict';

/**
 * Run one deadline check. Used by Windows Task Scheduler (every 15 minutes)
 * as well as manually:
 *
 *     node scripts/check-reminders.js
 */

const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store');
const { runReminderCheck } = require('../lib/reminders');

const stamp = () => new Date().toISOString();

function appendRunLog(line) {
  try {
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(store.DATA_DIR, 'scheduler.log'), `[${stamp()}] ${line}\n`, 'utf8');
  } catch {
    /* logging must never break the check */
  }
}

(async () => {
  try {
    const result = await runReminderCheck();
    const summary = result.sent
      ? `sent ${result.sent} task(s) via ${result.reason || 'email'}`
      : `nothing sent - ${result.reason || result.error || 'no tasks due'}`;

    console.log(`[${stamp()}] ${summary}`);
    appendRunLog(summary);
    process.exit(0);
  } catch (err) {
    console.error(`[${stamp()}] check failed: ${err.message}`);
    appendRunLog(`check failed: ${err.stack || err.message}`);
    process.exit(1);
  }
})();
