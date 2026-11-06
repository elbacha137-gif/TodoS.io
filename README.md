# ✅ TodoS.io

A todo list that works in your browser on **PC and phone**, and emails you
before a deadline — **2 days by default**, configurable in hours or days.

No frameworks, no build step, no npm install — just Node.js and a folder of JSON files.
Every person who uses the site gets their own account, their own task list and their
own reminder settings; the Windows scheduler emails each of them independently.

```
TodoS.io/
├─ start.bat              ← double-click to run
├─ server.js              ← the web server
├─ lib/                   ← storage, email, deadline logic
├─ public/                ← the website (HTML/CSS/JS)
├─ scripts/
│   ├─ check-reminders.js ← run once by the scheduled task
│   ├─ setup-task.ps1     ← install the Windows scheduled task
│   └─ remove-task.ps1    ← uninstall it
└─ data/                  ← your tasks + settings (created automatically)
```

---

## 1. Start the app

Double-click **`start.bat`** (or run `node server.js` in this folder).

Your browser opens on <http://localhost:4321>. Keep the black window open while
you use the list.

**On your phone:** connect the phone to the same Wi-Fi and open the address
printed in the window, e.g. `http://192.168.1.24:4321`. If it doesn't load, allow
Node.js through the Windows firewall (Private networks) when Windows asks.

> Both devices share the same list — add a task on your phone and it appears on
> your PC.

---

## 2. Set up the reminder email

Click the **⚙ gear** in the app, enter your email address, and pick a delivery
method. Then press **Send test email**.

### ⚠️ The honest bit about email

No program — this one or any other — can send an email out of thin air. A mail
has to leave from *some* sending account. You asked to avoid giving a password,
so the default option uses a free relay service that identifies you with an
**access key** instead of a password:

| Option | Password needed | Notes |
| --- | --- | --- |
| **No password** (Web3Forms) | ❌ | Go to <https://web3forms.com>, type your email, and you receive a free access key in seconds. Paste it in Settings. 250 emails/month free. |
| **My own mailbox (SMTP)** | ✅ app password | Emails come straight from your own account (Gmail: *myaccount.google.com → Security → App passwords*). Nothing goes through a third party. |
| **Save emails to a folder** | ❌ | Fully offline: reminder emails are written to `data/outbox/*.eml`. Open one and press send. |

You can switch methods at any time — your tasks are never affected.

> The earlier version used *formsubmit.co*; that service was unreachable when
> tested, so Web3Forms replaced it. Old settings are migrated automatically.

---

## 3. Make it check even when the website is closed

The website checks every 10 minutes **while it is running**. For reminders when
it is closed, install the Windows scheduled task (once):

Right-click **`scripts/setup-task.ps1`** → *Run with PowerShell*, or in a terminal:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-task.ps1
```

This registers a task named **TodoReminder** that runs every 15 minutes, whether
or not the site is open. It starts automatically at login. No administrator
rights are needed — if Windows refuses, run the same command from an
administrator PowerShell.

Test it immediately, look at its status, or remove it:

```powershell
Start-ScheduledTask -TaskName TodoReminder
Get-ScheduledTaskInfo -TaskName TodoReminder
powershell -ExecutionPolicy Bypass -File scripts\remove-task.ps1
```

---

## How reminders work

Each reminder email lists **what you have to do** (title + notes), the exact
deadline, and **how much time is left** ("2 days 4 h left", "5 h 20 min late").

* Each task with a deadline gets **exactly one reminder** when the clock enters
  the lead window (2 days / 48 hours before by default — set any number of hours
  or days in the app settings).
* Change a task's deadline → the reminder re-arms for the new date.
* Mark a task done → no reminder.
* If a send fails, it is **not** marked as sent, so the next check retries it.
* Overdue tasks can be included with the checkbox in settings.

Useful files:

| File | What's inside |
| --- | --- |
| `data/todos.json` | your tasks |
| `data/settings.json` | email + delivery settings (**contains your SMTP password if you use SMTP**) |
| `data/reminders.json` | the last 100 email attempts with results |
| `data/scheduler.log` | output of every scheduled run |
| `data/outbox/` | saved `.eml` emails (only in "save emails" mode) |

Back up the `data` folder and you keep everything.

---

## Share it on the internet

The app runs on your PC. To let someone use it from anywhere:

1. Double-click **`start-public.bat`**. It starts the server (if needed) and opens a
   free Cloudflare tunnel.
2. A public `https://…trycloudflare.com` address is printed and copied to your
   clipboard. Anyone with that link and a password can use the site.
3. Keep both black windows open. Closing them takes the link down; running
   `start-public.bat` again prints a new address.

For a **permanent address** (your own domain), set up a named Cloudflare tunnel and
put the domain in `settings → appUrl` (or let `scripts/public.js` do it).

Every visitor creates their own account; tasks and email settings are kept separate
and the scheduler emails each account on its own.

---

**Nothing arrives.**
1. Open the app and click **↻** — the toast tells you exactly what happened.
2. Check `data/reminders.json` for the error message.
3. Using the *No password* method? Make sure the Web3Forms access key is pasted
   and that "Send reminders to" is the same address you registered the key with.
4. Overdue/soon tasks: a task due in 5 days is *not* inside the reminder window yet.

**The scheduled task doesn't run.**
Open PowerShell and run `Get-ScheduledTaskInfo -TaskName TodoReminder`. Check
`data/scheduler.log` — every run appends a line.

**Port 4321 is busy.** Start with another port: `set PORT=5000 && node server.js`
(or add it to `start.bat`).

**I want it on the internet, not just my Wi-Fi.** Don't port-forward this app:
it has no login. Use a VPN such as Tailscale instead.

**Keep the website always available on your phone.** Press `Win+R`, type
`shell:startup` and put a shortcut to `start.bat` in that folder. The list then
comes up automatically when you log in (a small console window stays open —
closing it stops the site, not the reminders).

---

## Privacy

Everything stays on your PC except the reminder email itself. With the
*No password* method the subject and body (task titles and notes) pass through
Web3Forms; with SMTP they go through your own mail provider. The *Save emails to
a folder* mode shares nothing.
