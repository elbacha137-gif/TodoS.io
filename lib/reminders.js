'use strict';

/**
 * Deadline logic.
 *
 * A task gets exactly ONE reminder per deadline: when `now` enters the
 * "lead window" (2 days by default) the reminder is sent and the task is
 * stamped with `reminderSentFor = due`, so it is never sent twice.
 * Editing the deadline clears that stamp.
 */

const store = require('./store');
const mailer = require('./mailer');
const { primaryIp } = require('./net');

const DAY = 86400000;
const HOUR = 3600000;

async function appUrl(settings) {
  if (settings.appUrl) return settings.appUrl.replace(/\/$/, '');
  return `http://${await primaryIp()}:${process.env.PORT || 4321}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function humanDistance(ms) {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / DAY);
  const hours = Math.floor((abs % DAY) / 3600000);

  let text;
  if (days >= 1) text = `${days} day${days > 1 ? 's' : ''}`;
  else if (hours >= 1) text = `${hours} hour${hours > 1 ? 's' : ''}`;
  else text = 'less than an hour';

  return ms < 0 ? `${text} late` : `in ${text}`;
}

/**
 * Exact countdown used inside the email: "2 days 4 h left" / "5 h 20 min late".
 */
function timeLeftLabel(ms) {
  const late = ms < 0;
  const totalMinutes = Math.round(Math.abs(ms) / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} h`);
  if (!days && minutes) parts.push(`${minutes} min`);

  if (!parts.length) return late ? 'just overdue' : 'less than a minute left';
  return `${parts.join(' ')} ${late ? 'late' : 'left'}`;
}

/** "2 days", "1 day 12 h", "6 h" — how wide the reminder window is. */
function leadLabel(hours) {
  const total = Math.max(0, Number(hours) || 0);
  const days = Math.floor(total / 24);
  const rest = Math.round((total % 24) * 10) / 10;

  const parts = [];
  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (rest) parts.push(`${rest} h`);

  return parts.join(' ') || '0 h';
}

/** Tasks that should be in the next reminder email. */
function collect(todos, settings, now = Date.now()) {
  const leadMs = Math.max(0, Number(settings.leadHours ?? 48)) * HOUR;
  const soon = [];
  const late = [];

  for (const todo of todos) {
    if (todo.done || !todo.due) continue;
    if (todo.reminderSentFor === todo.due) continue;

    const due = new Date(todo.due).getTime();
    if (Number.isNaN(due)) continue;
    if (due > now + leadMs) continue;

    if (due < now) {
      if (settings.sendOverdue === false) continue;
      late.push({ todo, diff: due - now });
    } else {
      soon.push({ todo, diff: due - now });
    }
  }

  const byDue = (a, b) => new Date(a.todo.due) - new Date(b.todo.due);
  soon.sort(byDue);
  late.sort(byDue);
  return { soon, late };
}

function buildEmail(settings, soon, late, url) {
  const total = soon.length + late.length;

  const first = soon[0] || late[0];
  const subject =
    late.length > 0
      ? `⏰ ${late.length} overdue task${late.length > 1 ? 's' : ''}${soon.length ? ` + ${soon.length} due soon` : ''}`
      : `⏰ ${first.todo.title} — ${timeLeftLabel(first.diff)}${total > 1 ? ` (+${total - 1} more)` : ''}`;

  const textLine = ({ todo, diff }) => {
    const lines = [`• ${todo.title}`, `  Due ${fmtDate(todo.due)} — ${timeLeftLabel(diff)}`];
    if (todo.notes) lines.push(`  ${todo.notes.replace(/\n/g, '\n  ')}`);
    return lines.join('\n');
  };

  const text = [
    total === 1 ? 'You have 1 task to do:' : `You have ${total} tasks to do:`,
    '',
    late.length ? `OVERDUE (${late.length})` : null,
    ...late.map(textLine),
    late.length && soon.length ? '' : null,
    soon.length ? `DUE SOON (${soon.length})` : null,
    ...soon.map(textLine),
    '',
    'Open your list:',
    url,
    '',
    '— Todo Reminder · Developed by Walid El Bacha',
  ]
    .filter((v) => v !== null)
    .join('\n');

  const row = ({ todo, diff }) => {
    const isLate = diff < 0;
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #eceef6;vertical-align:top">
          <div style="font-weight:600;color:#1f2333;font-size:15px;line-height:1.35">${escapeHtml(todo.title)}</div>
          ${
            todo.notes
              ? `<div style="color:#4b5563;font-size:13px;line-height:1.45;margin-top:5px;white-space:pre-wrap">${escapeHtml(
                  todo.notes,
                )}</div>`
              : ''
          }
          <div style="color:#6b7280;font-size:12.5px;margin-top:7px">
            Due <strong style="color:#374151;font-weight:600">${escapeHtml(fmtDate(todo.due))}</strong>
          </div>
        </td>
        <td style="padding:14px 0 14px 14px;border-bottom:1px solid #eceef6;text-align:right;vertical-align:top;white-space:nowrap">
          <span style="display:inline-block;padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700;background:${isLate ? '#fdecec' : '#efeaff'};color:${isLate ? '#c02b2b' : '#5b48d8'}">
            ${escapeHtml(timeLeftLabel(diff))}
          </span>
        </td>
      </tr>`;
  };

  const section = (label, items, color) =>
    items.length
      ? `<h3 style="margin:26px 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${color}">${label}</h3>
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map(row).join('')}</table>`
      : '';

  const html = `<!doctype html>
  <html><body style="margin:0;padding:24px 12px;background:#f4f5fb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(28,32,64,.08)">
      <div style="padding:28px 26px 22px;background:linear-gradient(135deg,#6d5efc,#9b6bff)">
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#e7e2ff;font-weight:700">Todo Reminder</div>
        <div style="margin-top:8px;font-size:23px;font-weight:700;color:#fff;line-height:1.3">
          ${total} task${total > 1 ? 's' : ''} to do
        </div>
        <div style="margin-top:6px;color:#ded8ff;font-size:14px">
          ${late.length ? `${late.length} overdue · ` : ''}${soon.length} due within ${leadLabel(settings.leadHours)}
        </div>
      </div>
      <div style="padding:8px 26px 26px">
        ${section(`Overdue (${late.length})`, late, '#c02b2b')}
        ${section(`Due soon (${soon.length})`, soon, '#5b48d8')}
        <a href="${escapeHtml(url)}" style="display:block;margin-top:28px;padding:14px 18px;border-radius:12px;background:#6d5efc;color:#fff;text-decoration:none;text-align:center;font-weight:600;font-size:15px">
          Open my todo list
        </a>
        <p style="margin:18px 0 0;color:#9aa0b4;font-size:12px;text-align:center">
          You get one reminder per deadline. Change a deadline to re-arm it.<br />
          Developed by Walid El Bacha
        </p>
      </div>
    </div>
  </body></html>`;

  return { subject, text, html };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Check deadlines and email if anything is due.
 * @returns {Promise<{checked:number, sent:number, skipped:boolean, reason?:string, error?:string}>}
 */
async function runReminderCheck({ force = false, now = Date.now() } = {}) {
  const users = store.getUsers();
  if (!users.length) {
    return { checked: 0, sent: 0, skipped: true, reason: 'No accounts yet.' };
  }

  let totalChecked = 0;
  let totalSent = 0;
  const summaries = [];

  for (const user of users) {
    const settings = store.getSettings(user.id);
    const todos = store.getTodos(user.id);
    const { soon, late } = collect(todos, settings, now);

    settings.lastCheck = new Date().toISOString();
    store.saveSettings(user.id, settings);

    totalChecked += todos.length;

    if (soon.length + late.length === 0) {
      summaries.push(`${user.email}: nothing due`);
      continue;
    }

    if (!user.email) {
      store.appendLog(user.id, { kind: 'error', ok: false, detail: 'No email address on the account.', tasks: [...soon, ...late].map(({ todo }) => todo.title) });
      summaries.push(`${user.email}: no email`);
      continue;
    }

    // The recipient is the account owner.
    settings.email = user.email;

    const message = buildEmail(settings, soon, late, await appUrl(settings));
    const result = await mailer.send(settings, message);

    if (!result.ok) {
      store.appendLog(user.id, {
        kind: 'reminder',
        ok: false,
        transport: result.transport,
        detail: result.detail,
        tasks: [...soon, ...late].map(({ todo }) => todo.title),
      });
      summaries.push(`${user.email}: ${result.detail}`);
      continue;
    }

    const stamp = new Date().toISOString();
    const ids = new Set([...soon, ...late].map(({ todo }) => todo.id));
    const fresh = store.getTodos(user.id).map((todo) =>
      ids.has(todo.id) ? { ...todo, reminderSentFor: todo.due, reminderSentAt: stamp } : todo,
    );
    store.saveTodos(user.id, fresh);

    store.appendLog(user.id, {
      kind: 'reminder',
      ok: true,
      transport: result.transport,
      detail: result.detail,
      tasks: [...soon, ...late].map(({ todo }) => todo.title),
    });

    totalSent += soon.length + late.length;
    summaries.push(`${user.email}: sent ${soon.length + late.length}`);
  }

  return {
    checked: totalChecked,
    sent: totalSent,
    skipped: totalSent === 0,
    reason: totalSent === 0 ? 'Nothing is due in the reminder window.' : summaries.join(' · '),
  };
}

module.exports = { runReminderCheck, collect, buildEmail, humanDistance, timeLeftLabel, leadLabel, appUrl };
