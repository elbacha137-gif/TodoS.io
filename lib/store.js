'use strict';

/**
 * Tiny JSON-file storage. No dependencies, no database, easy to back up.
 *
 * Multi-user: each account has its own folder under data/users/<id>/.
 * The global data/users.json holds the account list (email + password hash).
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.TODO_DATA_DIR || path.join(ROOT, 'data');

const USERS_FILE = path.join(DATA_DIR, 'users.json');

const DEFAULT_SETTINGS = {
  // 'web3forms' = no password (free access key) | 'smtp' = your own mailbox | 'outbox' = save .eml files
  transport: 'web3forms',
  web3formsKey: '',
  theme: 'default',
  // scrypt hash of the account password (kept here for backwards compat; new accounts store it in users.json).
  passwordHash: '',
  // Reminder window, in hours (48 = two days).
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------- users --------------------------------- */

function userDir(userId) {
  return path.join(DATA_DIR, 'users', userId);
}

function userFiles(userId) {
  const dir = userDir(userId);
  return {
    dir,
    todos: path.join(dir, 'todos.json'),
    settings: path.join(dir, 'settings.json'),
    log: path.join(dir, 'reminders.json'),
  };
}

function getUsers() {
  migrateIfNeeded();
  const users = readJson(USERS_FILE, []);
  return Array.isArray(users) ? users : [];
}

function saveUsers(users) {
  ensureDir();
  writeJson(USERS_FILE, Array.isArray(users) ? users : []);
}

function findUserByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  return getUsers().find((u) => String(u.email || '').toLowerCase() === needle) || null;
}

function findUserById(id) {
  return getUsers().find((u) => u.id === id) || null;
}

function createUser(email, passwordHash) {
  const user = {
    id: randomUUID(),
    email: String(email || '').trim().toLowerCase(),
    passwordHash: passwordHash || '',
    createdAt: new Date().toISOString(),
  };
  const users = getUsers();
  users.push(user);
  saveUsers(users);
  fs.mkdirSync(userDir(user.id), { recursive: true });
  // Seed an empty settings file so the first run is predictable.
  writeJson(userFiles(user.id).settings, structuredClone(DEFAULT_SETTINGS));
  writeJson(userFiles(user.id).todos, []);
  writeJson(userFiles(user.id).log, []);
  return user;
}

/* --------------------------- migration (v1 -> v2) ----------------------- */

function migrateIfNeeded() {
  ensureDir();
  if (fs.existsSync(USERS_FILE)) return;

  const oldSettingsPath = path.join(DATA_DIR, 'settings.json');
  if (!fs.existsSync(oldSettingsPath)) {
    saveUsers([]);
    return;
  }

  const settings = readJson(oldSettingsPath, {});
  const email = String(settings.email || '').trim().toLowerCase();
  const passwordHash = settings.passwordHash || '';
  const todos = readJson(path.join(DATA_DIR, 'todos.json'), []);
  const log = readJson(path.join(DATA_DIR, 'reminders.json'), []);

  if (!email) {
    saveUsers([]);
    return;
  }

  const userId = randomUUID();
  const user = { id: userId, email, passwordHash, createdAt: new Date().toISOString() };
  saveUsers([user]);

  const dir = userDir(userId);
  fs.mkdirSync(dir, { recursive: true });

  const { email: _e, passwordHash: _p, ...rest } = settings;
  const nextSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...rest,
    smtp: { ...DEFAULT_SETTINGS.smtp, ...(rest.smtp || {}) },
  };
  // Old versions stored whole days only.
  if (rest.leadHours === undefined && rest.leadDays !== undefined) {
    const days = Number(rest.leadDays);
    nextSettings.leadHours = Number.isFinite(days) ? days * 24 : DEFAULT_SETTINGS.leadHours;
  }
  delete nextSettings.leadDays;
  if (nextSettings.transport === 'formsubmit') nextSettings.transport = 'web3forms';

  writeJson(userFiles(userId).settings, nextSettings);
  writeJson(userFiles(userId).todos, Array.isArray(todos) ? todos : []);
  writeJson(userFiles(userId).log, Array.isArray(log) ? log : []);

  console.log(`[store] migrated single-user data to account ${email} (${userId})`);
}

/* ------------------------------- todos --------------------------------- */

function getTodos(userId) {
  return readJson(userFiles(userId).todos, []);
}

function saveTodos(userId, todos) {
  writeJson(userFiles(userId).todos, Array.isArray(todos) ? todos : []);
}

function addTodo(userId, input) {
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
  const todos = getTodos(userId);
  todos.push(todo);
  saveTodos(userId, todos);
  return todo;
}

function updateTodo(userId, id, patch) {
  const todos = getTodos(userId);
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
  saveTodos(userId, todos);
  return todo;
}

function deleteTodo(userId, id) {
  const todos = getTodos(userId);
  const next = todos.filter((t) => t.id !== id);
  const removed = next.length !== todos.length;
  if (removed) saveTodos(userId, next);
  return removed;
}

/* ------------------------------ settings -------------------------------- */

function getSettings(userId) {
  const saved = readJson(userFiles(userId).settings, {});
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    smtp: { ...DEFAULT_SETTINGS.smtp, ...(saved.smtp || {}) },
  };

  if (settings.transport === 'formsubmit') settings.transport = 'web3forms';

  if (saved.leadHours === undefined) {
    const days = Number(saved.leadDays);
    settings.leadHours = Number.isFinite(days) ? days * 24 : DEFAULT_SETTINGS.leadHours;
  }
  delete settings.leadDays;

  // Attach the account email for convenience (not persisted here).
  const user = findUserById(userId);
  if (user) settings.email = user.email;

  return settings;
}

function saveSettings(userId, patch) {
  const current = getSettings(userId);
  const next = {
    ...current,
    ...patch,
    smtp: { ...current.smtp, ...(patch.smtp || {}) },
  };

  // A blank key means "keep the saved one".
  const incomingKey = String(patch.web3formsKey ?? '').trim();
  next.web3formsKey = incomingKey || current.web3formsKey;

  delete next.leadDays;
  next.leadHours = Math.min(1440, Math.max(0, Number(next.leadHours) || 0));
  next.sendOverdue = next.sendOverdue !== false;
  const ALLOWED_THEMES = new Set(['default', 'theme1', 'theme2', 'theme3']);
  next.theme = ALLOWED_THEMES.has(next.theme) ? next.theme : 'default';

  // Never persist the account email or password hash here.
  delete next.email;
  delete next.passwordHash;

  writeJson(userFiles(userId).settings, next);
  return next;
}

/** Settings safe to send to the browser (no password, no key value). */
function publicSettings(userId) {
  const s = getSettings(userId);
  const user = findUserById(userId);
  return {
    email: user ? user.email : '',
    transport: s.transport,
    hasWeb3FormsKey: Boolean(s.web3formsKey),
    theme: s.theme || 'default',
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

function getLog(userId) {
  const log = readJson(userFiles(userId).log, []);
  return Array.isArray(log) ? log : [];
}

function appendLog(userId, entry) {
  const log = getLog(userId);
  log.unshift({ at: new Date().toISOString(), ...entry });
  writeJson(userFiles(userId).log, log.slice(0, 100));
}

module.exports = {
  DATA_DIR,
  USERS_FILE,
  userDir,
  userFiles,
  getUsers,
  saveUsers,
  findUserByEmail,
  findUserById,
  createUser,
  migrateIfNeeded,
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
