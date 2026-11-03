'use strict';

/**
 * Tiny JSON-file storage. No dependencies, no database, easy to back up.
 * Files live in ./data next to the app (override with TODO_DATA_DIR).
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.TODO_DATA_DIR || path.join(ROOT, 'data');

const FILES = {
  todos: path.join(DATA_DIR, 'todos.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  log: path.join(DATA_DIR, 'reminders.json'),
};

const DEFAULT_SETTINGS = {
  email: '',
  // 'web3forms' = no password (free access key) | 'smtp' = your own mailbox | 'outbox' = save .eml files
  transport: 'web3forms',
  web3formsKey: '',
  // Reminder window, in hours (48 = two days). Hours keep short deadlines useful.
  leadHours: 48,
  sendOverdue: true,
  appUrl: '',
  smtp: {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: '',
  },
  lastCheck: null,
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] could not read ${file}: ${err.message}`);
    }
    return structuredClone(fallback);
  }
}

/** Write atomically so a crash never leaves a half-written file. */
function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------- todos --------------------------------- */

function getTodos() {
  const todos = readJson(FILES.todos, []);
  return Array.isArray(todos) ? todos : [];
}

function saveTodos(todos) {
  writeJson(FILES.todos, todos);
}

function addTodo(input) {
  const now = new Date().toISOString();
  const todo = {
    id: randomUUID(),
    title: String(input.title || '').trim().slice(0, 200),
    notes: String(input.notes || '').slice(0, 2000),
    due: input.due || null,
    priority: ['low', 'normal', 'high'].includes(input.priority) ? input.priority : 'normal',
    done: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    reminderSentFor: null,
    reminderSentAt: null,
  };
  const todos = getTodos();
  todos.push(todo);
  saveTodos(todos);
  return todo;
}

function updateTodo(id, patch) {
  const todos = getTodos();
  const todo = todos.find((t) => t.id === id);
  if (!todo) return null;

  for (const key of ['title', 'notes', 'due', 'priority']) {
    if (patch[key] !== undefined) todo[key] = patch[key];
  }

  if (patch.title !== undefined) todo.title = String(patch.title).trim().slice(0, 200);
  if (patch.notes !== undefined) todo.notes = String(patch.notes).slice(0, 2000);
  if (patch.priority !== undefined && !['low', 'normal', 'high'].includes(patch.priority)) {
    todo.priority = 'normal';
  }

  if (patch.done !== undefined) {
    todo.done = Boolean(patch.done);
    todo.completedAt = todo.done ? new Date().toISOString() : null;
    if (todo.done) {
      todo.reminderSentFor = null;
      todo.reminderSentAt = null;
    }
  }

  // A new deadline deserves a new reminder.
  if (patch.due !== undefined && patch.due !== todo.reminderSentFor) {
    todo.reminderSentFor = null;
    todo.reminderSentAt = null;
  }

  todo.updatedAt = new Date().toISOString();
  saveTodos(todos);
  return todo;
}

function deleteTodo(id) {
  const todos = getTodos();
  const next = todos.filter((t) => t.id !== id);
  const removed = next.length !== todos.length;
  if (removed) saveTodos(next);
  return removed;
}

/* ------------------------------ settings -------------------------------- */

function getSettings() {
  const saved = readJson(FILES.settings, {});
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    smtp: { ...DEFAULT_SETTINGS.smtp, ...(saved.smtp || {}) },
  };

  // The old no-password relay (formsubmit.co) is unreliable; point those
  // settings at Web3Forms instead.
  if (settings.transport === 'formsubmit') settings.transport = 'web3forms';

  // Older versions stored whole days only; the delay is now kept in hours.
  if (saved.leadHours === undefined) {
    const days = Number(saved.leadDays);
    settings.leadHours = Number.isFinite(days) ? days * 24 : DEFAULT_SETTINGS.leadHours;
  }
  delete settings.leadDays;

  return settings;
}

function saveSettings(patch) {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    smtp: { ...current.smtp, ...(patch.smtp || {}) },
  };
  next.web3formsKey = String(next.web3formsKey || '').trim();
  delete next.leadDays;
  next.leadHours = Math.min(1440, Math.max(0, Number(next.leadHours) || 0));
  next.sendOverdue = next.sendOverdue !== false;
  writeJson(FILES.settings, next);
  return next;
}

/** Settings safe to send to the browser (no password). */
function publicSettings() {
  const s = getSettings();
  return {
    email: s.email,
    transport: s.transport,
    web3formsKey: s.web3formsKey,
    leadHours: s.leadHours,
    sendOverdue: s.sendOverdue,
    appUrl: s.appUrl,
    smtp: {
      host: s.smtp.host,
      port: s.smtp.port,
      secure: s.smtp.secure,
      user: s.smtp.user,
      from: s.smtp.from,
      hasPassword: Boolean(s.smtp.pass),
    },
    lastCheck: s.lastCheck,
  };
}

/* ----------------------------- reminder log ----------------------------- */

function getLog() {
  const log = readJson(FILES.log, []);
  return Array.isArray(log) ? log : [];
}

function appendLog(entry) {
  const log = getLog();
  log.unshift({ at: new Date().toISOString(), ...entry });
  writeJson(FILES.log, log.slice(0, 100));
}

module.exports = {
  DATA_DIR,
  FILES,
  getTodos,
  saveTodos,
  addTodo,
  updateTodo,
  deleteTodo,
  getSettings,
  saveSettings,
  publicSettings,
  getLog,
  appendLog,
};
