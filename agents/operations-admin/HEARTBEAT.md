# Operations Admin — HEARTBEAT

Cadence: every 30 minutes (default)
Owner: operations-admin

## Scheduled tasks

The four duties below are assigned in `IDENTITY.md` ("Heartbeat focus: calendar
conflicts next 24h, urgent emails, overdue tasks, pending items"). The heartbeat
is the mechanism that makes them recur — an empty schedule meant they ran only
when somebody asked. Each duty names the source it reads and where it escalates.

Every duty is READ-ONLY against its source. This agent never sends, replies,
cancels or reschedules on its own initiative — it reports and escalates.

### 1. Calendar conflicts in the next 24 hours
- **Source:** Google Calendar via the Google Workspace integration
  (`TOOLS.md` → Integrations → Storage), owner's primary calendar.
- **Window:** now → now + 24h.
- **Detect:** overlapping accepted events; an event inside 2h of start with no
  location and no join link; back-to-back events at different locations.
- **Escalate:** one consolidated message to the owner naming each conflicting
  pair and its start times. Do NOT move, decline or cancel anything.
- **Nothing found:** record "no conflicts in window" in `MEMORY.md`.

### 2. Urgent emails
- **Source:** owner's mailbox via the Google Workspace integration.
- **Window:** unread since the previous heartbeat.
- **Urgent means:** sender is the owner or a client of record; or the subject
  carries a deadline, invoice, legal or outage signal; or the owner is directly
  addressed rather than copied.
- **Escalate:** sender, subject and the single decision required. Never draft or
  send a reply — delivery belongs to the Communications Agent under
  `agents/_shared/CONTENT-DELIVERY-HANDOFF.md`.
- **Nothing found:** record "no urgent mail in window" in `MEMORY.md`.

### 3. Overdue tasks
- **Source:** the Command Center task board for this workspace.
- **Overdue means:** due date in the past and status is not `done`.
- **Escalate:** task id, title, owner and days overdue, oldest first. Anything
  overdue by more than 7 days is flagged separately as stalled.
- **Nothing found:** record "no overdue tasks" in `MEMORY.md`.

### 4. Pending items awaiting the owner
- **Source:** the Command Center task board (blocked / waiting-on-owner states)
  plus any open decision recorded in `MEMORY.md`.
- **Escalate:** the decision, who is blocked by it, and how long it has waited.
- **Nothing found:** record "nothing pending on the owner" in `MEMORY.md`.

### If a source cannot be reached
Report that duty as **NOT RUN**, with the reason, and escalate it. An unreachable
calendar or mailbox is never reported as "no conflicts" or "no urgent mail" — a
check that could not run must never be counted as a clean check.

## On startup
1. Read `AGENTS.md` (shared rules)
2. Read `TOOLS.md` (shared tools)
3. Read `USER.md` (owner profile)
4. Read your own `IDENTITY.md`, `SOUL.md`, latest `MEMORY.md`
5. Check for any assigned persona for the incoming task
6. Begin task with persona governance (if assigned) or default identity
