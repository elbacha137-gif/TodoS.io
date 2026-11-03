'use strict';

/* =========================================================================
   Todo Reminder — front end
   Plain browser JS, no build step, no framework.
   ========================================================================= */

const $ = (id) => document.getElementById(id);

const state = {
  todos: [],
  settings: { leadHours: 48, transport: 'web3forms', email: '', smtp: {} },
  meta: {},
};

let activeFilter = 'open';
let editingId = null;
let newPriority = 'normal';
let toastTimer = null;

const DAY = 86400000;
const HOUR = 3600000;

/* ------------------------------- helpers -------------------------------- */

async function api(path, options = {}) {
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);

  const res = await fetch(path, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = '') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast show ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, kind === 'error' ? 6000 : 3800);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: sameYear ? 'short' : 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relLabel(diff) {
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return diff < 0 ? 'just now' : 'any minute';
  if (mins < 60) return diff < 0 ? `${mins} min late` : `in ${mins} min`;

  const hours = Math.round(abs / 3600000);
  if (hours < 24) return diff < 0 ? `${hours} h late` : `in ${hours} h`;

  const days = Math.round(abs / DAY);
  return diff < 0 ? `${days} day${days > 1 ? 's' : ''} late` : `in ${days} day${days > 1 ? 's' : ''}`;
}

/** "2 days", "1 day 12 h", "6 h" — width of the reminder window. */
function formatLead(hours) {
  const total = Math.max(0, Number(hours) || 0);
  const days = Math.floor(total / 24);
  const rest = Math.round((total % 24) * 10) / 10;

  const parts = [];
  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (rest) parts.push(`${rest} h`);

  return parts.join(' ') || '0 h';
}

function dueKind(todo, now) {
  if (!todo.due) return 'none';
  const due = new Date(todo.due).getTime();
  if (Number.isNaN(due)) return 'none';
  if (due < now) return 'overdue';
  if (due - now <= (state.settings.leadHours ?? 48) * HOUR) return 'soon';
  return 'later';
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/* ------------------------------- rendering ------------------------------ */

function sortTodos(list) {
  const rank = { high: 0, normal: 1, low: 2 };
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return new Date(b.completedAt || 0) - new Date(a.completedAt || 0);

    const ad = a.due ? new Date(a.due).getTime() : Infinity;
    const bd = b.due ? new Date(b.due).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
  });
}

function visibleTodos() {
  const now = Date.now();
  return state.todos.filter((todo) => {
    switch (activeFilter) {
      case 'open':
        return !todo.done;
      case 'soon':
        return !todo.done && ['overdue', 'soon'].includes(dueKind(todo, now));
      case 'today':
        return isToday(todo.due) && !todo.done;
      case 'done':
        return todo.done;
      default:
        return true;
    }
  });
}

function icon(paths, size = 17) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function taskNode(todo) {
  const now = Date.now();
  const kind = dueKind(todo, now);
  const li = document.createElement('li');
  li.className = `task${todo.done ? ' is-done' : ''}${kind === 'overdue' ? ' is-overdue' : ''}${
    kind === 'soon' ? ' is-soon' : ''
  }`;
  li.dataset.id = todo.id;

  /* checkbox */
  const check = document.createElement('button');
  check.type = 'button';
  check.className = `check${todo.done ? ' is-checked' : ''}`;
  check.setAttribute('aria-label', todo.done ? 'Mark as not done' : 'Mark as done');
  check.setAttribute('aria-pressed', String(todo.done));
  check.innerHTML = icon('<path d="M5 13l4 4L19 7"/>', 15);

  /* body */
  const body = document.createElement('div');
  body.className = 'task-body';

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = todo.title;
  title.title = 'Click to edit';
  title.addEventListener('click', () => openTaskDialog(todo));
  body.append(title);

  const meta = document.createElement('div');
  meta.className = 'task-meta';

  if (todo.priority === 'high' && !todo.done) {
    meta.append(chip('High', 'chip--high'));
  }

  if (todo.due) {
    if (todo.done) {
      meta.append(chip(fmtDateTime(todo.due)));
    } else if (kind === 'overdue') {
      meta.append(chip(`${relLabel(new Date(todo.due).getTime() - now)} · ${fmtDateTime(todo.due)}`, 'chip--overdue'));
    } else if (kind === 'soon') {
      meta.append(chip(`${relLabel(new Date(todo.due).getTime() - now)} · ${fmtDateTime(todo.due)}`, 'chip--soon'));
    } else {
      meta.append(chip(fmtDateTime(todo.due)));
    }
  }

  if (todo.reminderSentFor && todo.reminderSentFor === todo.due) {
    meta.append(chip('✉︎ reminder sent', 'chip--done'));
  }

  if (meta.children.length) body.append(meta);

  if (todo.notes) {
    const notes = document.createElement('span');
    notes.className = 'task-notes';
    notes.textContent = todo.notes;
    body.append(notes);
  }

  /* actions */
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'icon-btn';
  editBtn.title = 'Edit';
  editBtn.setAttribute('aria-label', 'Edit task');
  editBtn.innerHTML = icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 15);
  editBtn.addEventListener('click', () => openTaskDialog(todo));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'icon-btn delete';
  delBtn.title = 'Delete';
  delBtn.setAttribute('aria-label', 'Delete task');
  delBtn.innerHTML = icon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/>', 15);
  delBtn.addEventListener('click', () => removeTodo(todo, li));

  actions.append(editBtn, delBtn);

  check.addEventListener('click', () => toggleTodo(todo));

  li.append(check, body, actions);
  return li;
}

function chip(text, cls = '') {
  const span = document.createElement('span');
  span.className = `chip ${cls}`.trim();
  span.textContent = text;
  return span;
}

function render() {
  const now = Date.now();
  const list = $('task-list');
  const items = sortTodos(visibleTodos());

  list.replaceChildren(...items.map(taskNode));

  /* stats */
  const open = state.todos.filter((t) => !t.done);
  const done = state.todos.filter((t) => t.done);
  const soon = open.filter((t) => dueKind(t, now) === 'soon');
  const overdue = open.filter((t) => dueKind(t, now) === 'overdue');

  $('stat-soon').textContent = soon.length;
  $('stat-overdue').textContent = overdue.length;
  $('stat-open').textContent = open.length;
  $('stat-done').textContent = done.length;

  /* subtitle */
  const todayLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const parts = [todayLine];
  if (open.length) parts.push(`${open.length} open`);
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  $('subtitle').textContent = parts.join(' · ');

  /* empty state */
  const empty = $('empty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    const copy = {
      open: ['All clear 🎉', 'No open tasks. Tap + to add one.'],
      soon: ['Nothing due soon', 'Enjoy the calm — or add a task with a deadline.'],
      today: ['Nothing due today', 'Your day is free.'],
      done: ['No completed tasks yet', 'Tick a task to see it here.'],
      all: ['No tasks yet', 'Tap the + button to add your first task.'],
    }[activeFilter];
    $('empty-title').textContent = copy[0];
    $('empty-text').textContent = copy[1];
  }

  renderStatus();
}

function renderStatus() {
  const s = state.settings;
  const dot = $('status-dot');
  const text = $('status-text');

  if (!s.email) {
    dot.className = 'dot warn';
    text.textContent = 'No reminder email yet — open ⚙ to add your address';
    return;
  }

  const method =
    s.transport === 'smtp'
      ? 'SMTP'
      : s.transport === 'outbox'
        ? 'saved emails'
        : s.transport === 'web3forms'
          ? 'Web3Forms'
          : 'no-password relay';

  dot.className = 'dot ok';
  const last = s.lastCheck
    ? ` · last check ${new Date(s.lastCheck).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : '';
  text.textContent = `Reminder ${formatLead(s.leadHours)} before each deadline → ${s.email} (${method})${last}`;
}

/* -------------------------------- actions ------------------------------- */

async function refresh(showError = false) {
  try {
    const data = await api('/api/state');
    state.todos = data.todos;
    state.settings = data.settings;
    state.meta = data.meta;
    render();
  } catch (err) {
    if (showError) toast(err.message, 'error');
  }
}

async function toggleTodo(todo) {
  try {
    await api(`/api/todos/${encodeURIComponent(todo.id)}`, {
      method: 'PATCH',
      body: { done: !todo.done },
    });
    await refresh();
    if (!todo.done) toast('Nice — one less thing to do.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeTodo(todo, node) {
  const ok = window.confirm(`Delete “${todo.title}”?`);
  if (!ok) return;
  try {
    node.classList.add('is-leaving');
    await api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: 'DELETE' });
    setTimeout(refresh, 160);
  } catch (err) {
    node.classList.remove('is-leaving');
    toast(err.message, 'error');
  }
}

/* ------------------------------ task dialog ----------------------------- */

function setPriority(value) {
  newPriority = value;
  for (const btn of document.querySelectorAll('#priority-group .seg')) {
    const active = btn.dataset.priority === value;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  }
}

function openTaskDialog(todo = null) {
  editingId = todo ? todo.id : null;
  $('task-dialog-title').textContent = todo ? 'Edit task' : 'New task';
  $('task-title').value = todo ? todo.title : '';
  $('task-due').value = todo ? toLocalInput(todo.due) : '';
  $('task-notes').value = todo ? todo.notes || '' : '';
  $('task-delete').hidden = !todo;
  $('task-save').textContent = todo ? 'Save changes' : 'Save task';
  setPriority(todo ? todo.priority : 'normal');
  $('task-dialog').showModal();
  setTimeout(() => $('task-title').focus(), 60);
}

async function saveTask(event) {
  event.preventDefault();

  const title = $('task-title').value.trim();
  if (!title) {
    toast('Give your task a name first.', 'error');
    $('task-title').focus();
    return;
  }

  const payload = {
    title,
    due: fromLocalInput($('task-due').value),
    notes: $('task-notes').value.trim(),
    priority: newPriority,
  };

  const button = $('task-save');
  button.disabled = true;

  try {
    if (editingId) {
      await api(`/api/todos/${encodeURIComponent(editingId)}`, { method: 'PATCH', body: payload });
    } else {
      await api('/api/todos', { method: 'POST', body: payload });
    }
    $('task-dialog').close();
    await refresh();
    toast(editingId ? 'Task updated.' : 'Task added.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ---------------------------- settings dialog --------------------------- */

function currentTransport() {
  return document.querySelector('#transport-group .transport.is-active')?.dataset.transport || 'web3forms';
}

function setTransport(value) {
  for (const btn of document.querySelectorAll('#transport-group .transport')) {
    const active = btn.dataset.transport === value;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  }
  $('smtp-box').hidden = value !== 'smtp';
  $('w3f-box').hidden = value !== 'web3forms';
}

function syncLeadUnit() {
  const unit = $('set-lead-unit').value;
  const input = $('set-lead');
  input.max = unit === 'days' ? '60' : '1440';
  input.step = '0.5';
}

let leadUnit = 'hours';

function onLeadUnitChange() {
  const input = $('set-lead');
  const next = $('set-lead-unit').value;
  const value = Number(input.value) || 0;
  if (next === 'days' && leadUnit === 'hours') input.value = Math.round((value / 24) * 100) / 100;
  if (next === 'hours' && leadUnit === 'days') input.value = Math.round(value * 24 * 100) / 100;
  leadUnit = next;
  syncLeadUnit();
}

function openSettings() {
  const s = state.settings;
  $('set-email').value = s.email || '';
  const hours = Number(s.leadHours ?? 48);
  const useDays = hours >= 24 && hours % 24 === 0;
  $('set-lead-unit').value = useDays ? 'days' : 'hours';
  $('set-lead').value = useDays ? hours / 24 : hours;
  leadUnit = $('set-lead-unit').value;
  syncLeadUnit();
  $('set-overdue').checked = s.sendOverdue !== false;
  setTransport(s.transport || 'web3forms');

  $('set-w3f-key').value = s.web3formsKey || '';

  $('set-smtp-host').value = s.smtp?.host || '';
  $('set-smtp-port').value = s.smtp?.port || 465;
  $('set-smtp-user').value = s.smtp?.user || '';
  $('set-smtp-pass').value = '';
  $('set-smtp-secure').checked = s.smtp?.secure !== false;

  const note = $('settings-note');
  if (s.transport === 'web3forms' && s.email && !s.web3formsKey) {
    note.hidden = false;
    note.textContent =
      'Almost there: web3forms.com gives you a free access key by email in a few seconds. Paste it above, then press “Send test email”.';
  } else {
    note.hidden = true;
  }

  $('settings-dialog').showModal();
}

function collectSettingsForm() {
  return {
    email: $('set-email').value.trim(),
    web3formsKey: $('set-w3f-key').value.trim(),
    leadHours: (Number($('set-lead').value) || 0) * ($('set-lead-unit').value === 'days' ? 24 : 1),
    sendOverdue: $('set-overdue').checked,
    transport: currentTransport(),
    smtp: {
      host: $('set-smtp-host').value.trim(),
      port: Number($('set-smtp-port').value) || 465,
      secure: $('set-smtp-secure').checked,
      user: $('set-smtp-user').value.trim(),
      pass: $('set-smtp-pass').value,
    },
  };
}

async function saveSettings(event) {
  if (event) event.preventDefault();
  const payload = collectSettingsForm();

  if (!payload.email) {
    toast('Add the email address that should receive reminders.', 'error');
    $('set-email').focus();
    throw new Error('missing email');
  }

  if (payload.transport === 'smtp' && (!payload.smtp.host || !payload.smtp.user)) {
    toast('SMTP needs at least a host and a username.', 'error');
    throw new Error('incomplete smtp');
  }

  if (payload.transport === 'web3forms' && !payload.web3formsKey) {
    toast('Paste your free Web3Forms access key (web3forms.com) — or choose another delivery method.', 'error');
    throw new Error('missing key');
  }

  const data = await api('/api/settings', { method: 'PUT', body: payload });
  state.settings = data.settings;
  state.meta = data.state.meta;
  return payload;
}

async function submitSettings(event) {
  event.preventDefault();
  const button = $('settings-save');
  button.disabled = true;
  try {
    await saveSettings();
    $('settings-dialog').close();
    await refresh();
    toast('Reminder settings saved.', 'success');
  } catch (err) {
    if (!['missing email', 'incomplete smtp', 'missing key'].includes(err.message)) toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function sendTestEmail() {
  const button = $('test-email-btn');
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    await saveSettings();
    const data = await api('/api/test-email', { method: 'POST' });
    state.settings = data.state.settings;
    state.meta = data.state.meta;
    render();
    if (data.result.ok) {
      toast(
        data.result.needsActivation
          ? 'Confirmation email sent — open it and click the link once to activate.'
          : `Test email sent via ${data.result.transport}. Check your inbox.`,
        'success',
      );
    } else {
      toast(`Could not send: ${data.result.detail}`, 'error');
    }
  } catch (err) {
    if (!['missing email', 'incomplete smtp', 'missing key'].includes(err.message)) toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Send test email';
  }
}

/* -------------------------------- wiring -------------------------------- */

function wire() {
  $('add-btn').addEventListener('click', () => openTaskDialog());
  $('settings-btn').addEventListener('click', openSettings);
  $('set-lead-unit').addEventListener('change', onLeadUnitChange);
  $('task-form').addEventListener('submit', saveTask);

  $('task-delete').addEventListener('click', async () => {
    if (!editingId) return;
    const todo = state.todos.find((t) => t.id === editingId);
    if (!todo) return;
    if (!window.confirm(`Delete “${todo.title}”?`)) return;
    try {
      await api(`/api/todos/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
      $('task-dialog').close();
      await refresh();
      toast('Task deleted.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  for (const btn of document.querySelectorAll('#priority-group .seg')) {
    btn.addEventListener('click', () => setPriority(btn.dataset.priority));
  }

  for (const btn of document.querySelectorAll('#transport-group .transport')) {
    btn.addEventListener('click', () => setTransport(btn.dataset.transport));
  }

  $('filters').addEventListener('click', (event) => {
    const btn = event.target.closest('.filter');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    for (const f of document.querySelectorAll('.filter')) {
      const active = f === btn;
      f.classList.toggle('is-active', active);
      f.setAttribute('aria-selected', String(active));
    }
    render();
  });

  for (const closer of document.querySelectorAll('[data-close-dialog]')) {
    closer.addEventListener('click', () => $(closer.dataset.closeDialog).close());
  }

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  $('settings-form').addEventListener('submit', submitSettings);
  $('test-email-btn').addEventListener('click', sendTestEmail);

  $('refresh-btn').addEventListener('click', async () => {
    const btn = $('refresh-btn');
    btn.classList.add('spinning');
    try {
      const data = await api('/api/check-now', { method: 'POST' });
      state.todos = data.state.todos;
      state.settings = data.state.settings;
      state.meta = data.state.meta;
      render();

      const r = data.result;
      if (r.sent) toast(`Reminder sent for ${r.sent} task${r.sent > 1 ? 's' : ''}.`, 'success');
      else if (r.error) toast(`Reminder failed: ${r.error}`, 'error');
      else toast(r.reason || 'Nothing due right now.', '');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 500);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const open = document.querySelector('dialog[open]');
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (!open && !typing) {
        event.preventDefault();
        openTaskDialog();
      }
    }
  });

  // Keep several devices (phone + PC) in sync.
  setInterval(() => {
    if (document.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    refresh();
  }, 60000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

wire();
refresh(true);
