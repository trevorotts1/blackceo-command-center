#!/usr/bin/env node
// rescue-receiver.mjs
//
// Real-time PUSH half of the Rescue Rangers Relay (transport A: inbound webhook).
//
// Runs ON the operator Mac, bound to loopback 127.0.0.1:8799 ONLY. Cloud n8n
// reaches it in real time through the dedicated Cloudflare tunnel
// "rescue-gw" at https://rescue-gw.zerohumanworkforce.com/rescue.
//
// On POST /rescue with a correct `X-Rescue-Secret` header it runs ONE turn of
// the real rescue-rangers OpenClaw agent (the same command the poller uses:
//   openclaw agent --agent rescue-rangers --message "<text>" --json
// ) and returns {reply, ticketId, status}. Missing/wrong secret -> 401.
//
// This is ADDITIVE. The existing 2-minute poller
// (~/clawd/fleet-heartbeat/scripts/rescue-rangers-poller.sh) is untouched and
// remains the fallback path.
//
// No external deps; Node core only. No em dashes in output.

import http from "node:http";
import httpMod from "node:http";
import httpsMod from "node:https";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = parseInt(process.env.RESCUE_RECEIVER_PORT || "8799", 10);
const SECRET = process.env.RESCUE_PUSH_SECRET || "";
const OPENCLAW_BIN =
  process.env.OPENCLAW_BIN || path.join(os.homedir(), ".local/bin/openclaw");
const AGENT_ID = process.env.RESCUE_AGENT_ID || "rescue-rangers";
const AGENT_TIMEOUT = parseInt(process.env.RESCUE_AGENT_TIMEOUT || "540", 10);
const LOG =
  process.env.RESCUE_RECEIVER_LOG ||
  path.join(os.homedir(), ".openclaw/logs/rescue-receiver.log");
const MAX_BODY = 256 * 1024; // 256 KB cap
// FIX-RESCUE-09: durable per-box return-leg verification store. A `type:"vps"`
// box may only receive the direct SSH/docker-exec return leg AFTER a per-box
// loopback smoke test has passed (recorded here). Until then delivery falls back
// to the Telegram-group post the relay already makes -- never an unverified SSH.
const RETURN_VERIFIED_STORE =
  process.env.RESCUE_RETURN_VERIFIED_STORE ||
  path.join(os.homedir(), ".openclaw/state/return-box-verified.json");

// ---------------------------------------------------------------------------
// ALARM TARGETS
// FIXER_GROUP_CHAT_ID / FIXER_THREAD_ID: the OpenClaw Fixer topic in the
// Rescue Rangers operator group. Watchdog restarts + billing alarms go here.
// TREVOR_CHAT_ID: Trevor's personal DM -- receives operator pages for
// no-reply, billing, and timeout events.
// ---------------------------------------------------------------------------
const FIXER_GROUP_CHAT_ID = parseInt(
  process.env.RESCUE_RANGERS_HELP_CHAT_ID || "-1003865262028",
  10
);
const FIXER_THREAD_ID = parseInt(process.env.RESCUE_FIXER_THREAD_ID || "3", 10);
const TREVOR_CHAT_ID = parseInt(
  process.env.RESCUE_TREVOR_CHAT_ID || "5252140759",
  10
);

// Where the receiver posts the agent's answer back to (the SAME public n8n
// webhook the poller uses). On action="answer" the Relay Brain posts the reply
// into the Telegram group thread and closes the ticket. This is what makes the
// ASYNC push path self-complete without the poller.
const RELAY_URL =
  process.env.RESCUE_RELAY_URL ||
  "https://main.blackceoautomations.com/webhook/rescue-rangers";

// === RR #5: structured fixer wiring =========================================
// For fix-it-ourselves tickets whose failure maps to a KNOWN remediate.sh class,
// run the REAL structured fixer so the answer leads with a concrete fix, not just
// advice. Defaults to DRY-RUN (plan only: zero mutation, zero change-log write,
// zero SSH via REMEDIATE_FORCE_CLASS); set RESCUE_REMEDIATE_LIVE=1 to allow a live
// remediation pass (still only for the known non-destructive classes -- the
// destructive/credential/DNS guard in classifyFixMode never routes a ticket here).
// The structured plan is attached to the answer regardless, so "What we did" is
// real even when live execution is off.
const REMEDIATE_SCRIPT =
  process.env.RESCUE_REMEDIATE_SCRIPT ||
  path.join(os.homedir(), "clawd/fleet-heartbeat/scripts/remediate.sh");
const REMEDIATE_LIVE = process.env.RESCUE_REMEDIATE_LIVE === "1";
const REMEDIATE_TIMEOUT = parseInt(process.env.RESCUE_REMEDIATE_TIMEOUT || "150", 10);

// === RR LONG-FIX HANDLING: PER-CLASS fix budgets (env-overridable) ============
// The receiver WAITS on a structured fix only up to its CLASS budget, then stops
// BLOCKING and escalates. The old single flat REMEDIATE_FIX_TIMEOUT (~240s) falsely
// escalated a legit 20-min container rebuild at ~4 min. Now:
//   FAST  classes (a quick gateway kickstart / port restart) escalate in ~3 min if stuck.
//   LONG  classes (container rebuild / config doctor --fix / reinstall / re-onboard that
//         re-pull or rebuild) get ~22 min before the receiver gives up and pages a human.
//   default/unknown sits in between (~5 min).
// The fix may keep running detached past its budget; the receiver just stops waiting on it.
const FIX_BUDGET_FAST = parseInt(
  process.env.RESCUE_REMEDIATE_FIX_BUDGET_FAST || "180", 10
);   // ~3 min: a stuck quick-fix should page fast
const FIX_BUDGET_LONG = parseInt(
  process.env.RESCUE_REMEDIATE_FIX_BUDGET_LONG || "1320", 10
);  // ~22 min: rebuild / reinstall / re-onboard
const FIX_BUDGET_DEFAULT = parseInt(
  process.env.RESCUE_REMEDIATE_FIX_BUDGET_DEFAULT ||
    process.env.RESCUE_REMEDIATE_FIX_TIMEOUT || process.env.REMEDIATE_FIX_TIMEOUT || "300",
  10
); // ~5 min: unknown / default (back-compat: honors the old flat env names if still set)

// Map each remediate.sh fix class to a budget. Classes mirror remediate.sh and
// remediateClassFromMessage():
//   FAST: gateway-port-closed (docker restart), mac-gateway-down (launchctl kickstart),
//         gateway-restart / gateway-kickstart synonyms.
//   LONG: container-exited (compose up --force-recreate, re-pulls), config-invalid +
//         mac-config-invalid (doctor --fix, may reinstall), reinstall, re-onboard.
const FIX_BUDGET_BY_CLASS = {
  "gateway-port-closed": FIX_BUDGET_FAST,
  "mac-gateway-down":    FIX_BUDGET_FAST,
  "gateway-restart":     FIX_BUDGET_FAST,
  "gateway-kickstart":   FIX_BUDGET_FAST,
  "container-exited":    FIX_BUDGET_LONG,
  "config-invalid":      FIX_BUDGET_LONG,
  "mac-config-invalid":  FIX_BUDGET_LONG,
  "reinstall":           FIX_BUDGET_LONG,
  "re-onboard":          FIX_BUDGET_LONG,
};

function fixBudgetForClass(klass) {
  if (klass && Object.prototype.hasOwnProperty.call(FIX_BUDGET_BY_CLASS, klass)) {
    return FIX_BUDGET_BY_CLASS[klass];
  }
  return FIX_BUDGET_DEFAULT;
}

// PROGRESS HEARTBEAT cadence (env-overridable). A fix that runs longer than the delay
// gets a periodic plain-text "still working on it" post so a long fix is NEVER silent.
const FIX_HEARTBEAT_DELAY = parseInt(
  process.env.RESCUE_REMEDIATE_HEARTBEAT_DELAY || "90", 10
);     // first beat after ~90s of work
const FIX_HEARTBEAT_INTERVAL = parseInt(
  process.env.RESCUE_REMEDIATE_HEARTBEAT_INTERVAL || "180", 10
); // then every ~180s

// === RR #4: serial fixer queue + hard per-job time cap ======================
// Heavy async fixer jobs run through a SMALL SERIAL QUEUE (one at a time) so a
// slow ticket cannot starve CPU / collide with the next agent run. The inbound
// HTTP request is already answered 202 BEFORE enqueue, so n8n is never blocked.
// A hard wall (default 600s) guards the WHOLE job (agent + remediate + post-back):
// if a job exceeds it, the queue moves on to the next ticket and a human is paged,
// so one stuck ticket can never block the rest of the queue forever.
const QUEUE_JOB_TIMEOUT = parseInt(process.env.RESCUE_QUEUE_JOB_TIMEOUT || "600", 10);

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(LOG, line);
  } catch (_) {
    /* ignore log failures */
  }
}

// ---------------------------------------------------------------------------
// TELEGRAM DIRECT ALARM: posts directly to api.telegram.org using the Rescue
// Rangers bot token. Used for watchdog, billing, timeout, and no-reply pages.
// Does NOT go through the OpenClaw gateway (avoids a circular dependency when
// the receiver itself is degraded). threadId may be null for a plain DM.
// ---------------------------------------------------------------------------
function postTelegramAlarm(text, chatId, threadId) {
  const token = process.env.RESCUE_RANGERS_BOT_TOKEN || "";
  if (!token) {
    log("postTelegramAlarm: RESCUE_RANGERS_BOT_TOKEN not set; cannot post alarm");
    return Promise.resolve({ ok: false, error: "no bot token" });
  }
  return new Promise((resolve) => {
    const bodyObj = { chat_id: chatId, text };
    if (threadId) bodyObj.message_thread_id = threadId;
    let bodyStr;
    try {
      bodyStr = JSON.stringify(bodyObj);
    } catch (e) {
      return resolve({ ok: false, error: `stringify failed: ${e.message}` });
    }
    const req = httpsMod.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
        timeout: 15000,
      },
      (r) => {
        let b = "";
        r.on("data", (c) => (b += c.toString()));
        r.on("end", () =>
          resolve({
            ok: r.statusCode >= 200 && r.statusCode < 300,
            status: r.statusCode,
            body: b.slice(0, 200),
          })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("telegram alarm timeout")));
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// PROVIDER NAMER: identify WHICH paid model provider the error came from so the
// billing alarm can say "top up <provider>". Only the paid providers the fleet
// uses are named: DeepSeek-direct, Moonshot, OpenRouter. Ollama is LOCAL and has
// no billing, so it is NEVER named here (an Ollama-only error returns the generic
// fallback, never a "top up Ollama" alarm). Returns a display name or null.
// ---------------------------------------------------------------------------
function detectProvider(text) {
  const t = (text || "").toLowerCase();
  // OpenRouter first: its error bodies often also echo an upstream model id
  // (deepseek/..., moonshotai/...) so match the router host before the model.
  if (/openrouter/.test(t)) return "OpenRouter";
  if (/deepseek/.test(t)) return "DeepSeek-direct";
  if (/moonshot|kimi/.test(t)) return "Moonshot";
  return null; // unknown / local (e.g. Ollama) -> caller uses a generic label
}

// ---------------------------------------------------------------------------
// BILLING FAILURE DETECTOR: scans raw stdout+stderr from the openclaw agent for
// credit exhaustion / rate-limit / account-suspended / chain-failure signals.
// Returns { provider, signal, message } or null. The message is the alarm
// headline ("Out of credit on <provider> -- top up"). Zero tokens; runs on the
// captured output after the agent exits.
// ---------------------------------------------------------------------------
function detectBillingFailure(stdout, stderr) {
  const combined = ((stdout || "") + " " + (stderr || "")).slice(0, 4000);
  let signal = null;
  if (/\b402\b|insufficient.?balance|payment.?required/i.test(combined)) {
    signal = "402 Insufficient Balance";
  } else if (/\bsuspend(?:ed|ing)?\b|account.*suspend|billing.*suspend/i.test(combined)) {
    signal = "account suspended";
  } else if (/\b429\b|too\s+many\s+requests|rate.?limit|quota.*exceed|exceeded.*quota/i.test(combined)) {
    signal = "429 rate-limit / quota";
  } else if (/all models failed/i.test(combined)) {
    signal = "all models failed (fallback chain exhausted)";
  }
  if (!signal) return null;
  const provider = detectProvider(combined) || "the model provider";
  return {
    provider,
    signal,
    message: `Out of credit on ${provider} (${signal}) -- top up`,
  };
}

// Timing-safe-ish constant comparison without bringing in crypto subtleties.
function secretOk(provided) {
  if (!SECRET) return false; // never accept if no secret configured
  if (typeof provided !== "string") return false;
  if (provided.length !== SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < SECRET.length; i++) {
    diff |= provided.charCodeAt(i) ^ SECRET.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PLAIN-TEXT FIX (P0 part c): strip markdown from incoming problem text so
// the rescue-rangers agent gets clean plain text and produces clean output.
// Mirrors the makeReadable() function in the n8n Relay Brain, applied here
// on the MAC side so every message path (async push + sync poller) is covered.
// Idempotent: already-plain text is unchanged.
// ---------------------------------------------------------------------------
function stripMarkdown(s) {
  if (!s) return '';
  let t = String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Fenced code blocks: replace the fence markers, keep content on its own line
  t = t.replace(/```[^\n]*\n?/g, '').replace(/```/g, '');
  // Inline code
  t = t.replace(/`([^`]+)`/g, '$1').replace(/`/g, '');
  // **bold** and __bold__
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  // *italic* (single asterisk, not part of **bold**)
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  // ~~ strikethrough ~~
  t = t.replace(/~~([^~]+)~~/g, '$1');
  // ## Headings
  t = t.replace(/^#{1,6}\s+/gm, '');
  // Markdown table rows and separator rows
  t = t.replace(/^\s*\|[^\n]*\|\s*$/gm, '');
  t = t.replace(/^\s*[-|: ]+\s*$/gm, '');
  // Leftover asterisks and pipes
  t = t.replace(/\*\*/g, '').replace(/^\s*\|\s*/gm, '');
  // Normalize bullet markers
  t = t.replace(/^\s*[-*]\s+/gm, '- ');
  // Collapse excessive blank lines
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function extractReply(stdout) {
  const i = stdout.indexOf("{");
  if (i < 0) return "";
  let d;
  try {
    d = JSON.parse(stdout.slice(i));
  } catch (_) {
    return "";
  }
  const dig = (o, ...ks) => {
    for (const k of ks) {
      if (!o || typeof o !== "object") return undefined;
      o = o[k];
    }
    return o;
  };
  const payloadText =
    Array.isArray(dig(d, "result", "payloads")) &&
    dig(d, "result", "payloads")[0]
      ? dig(d, "result", "payloads")[0].text
      : undefined;
  return (
    payloadText ||
    dig(d, "result", "meta", "finalAssistantVisibleText") ||
    dig(d, "result", "run", "meta", "finalAssistantVisibleText") ||
    dig(d, "meta", "finalAssistantVisibleText") ||
    ""
  );
}

// ---------------------------------------------------------------------------
// Difficulty tier classifier — deterministic regex only, zero LLM tokens.
//
// Three tiers:
//   structured ($0) — matches remediate.sh's 4 known auto-fix failure classes
//                     (container-exited, config-invalid, gateway-port-closed,
//                     gateway-auth) AND is NOT a destructive/credential case.
//                     Routes to the light model at low thinking so the repair
//                     runbook can be handed off cheaply.
//   light            — trivial routing tests, how-to, synthetic probes, or any
//                     clearly simple operational question.
//   hard (default)   — anything else, or ANY destructive/credential/security/
//                     data-loss keyword. Uses the rescue-rangers agent primary
//                     (ollama/kimi-k2.6:cloud) at high thinking via model:null.
//
// HARD GUARDRAIL (RR4 TIER-3): destructive/credential keywords ALWAYS force
// hard — never downshifted, regardless of other matches.
//
// Furnace-safe: the classifier itself costs zero tokens. The light model runs
// only on provably simple tickets. The expensive path is gated to hard cases.
//
// MODEL POLICY (binding 2026-07-01): ALL rescue tiers run on Ollama Cloud only.
// No Gemini / Google / any non-Ollama-Cloud provider in the rescue path.
// LIGHT + STRUCTURED -> ollama/deepseek-v4-flash:cloud (cheap/fast, reliable
// JSON). HARD -> model:null => agent primary (ollama/kimi-k2.6:cloud).
// If deepseek-v4-flash proves unreliable for structured JSON, switch
// STRUCTURED_MODEL to "ollama/kimi-k2.6:cloud" (also Ollama Cloud).
// ---------------------------------------------------------------------------
const LIGHT_MODEL = "ollama/deepseek-v4-flash:cloud";
const STRUCTURED_MODEL = "ollama/deepseek-v4-flash:cloud";
// FIX-RESCUE-05: a real MEDIUM tier for the single most common ticket class
// (coach-client-agent / how-to / advisory). Before this, those fell through to
// the HARD default -> ollama/kimi-k2.6:cloud @ high thinking, which routinely
// blew the 570s agent wall AND the 600s queue cap and paged a human (live
// evidence: a coach ticket abandoned at 602.2s). Medium routes them to the
// cheap/fast model at low thinking so they finish in seconds, not minutes.
const MEDIUM_MODEL = "ollama/deepseek-v4-flash:cloud";
const HARD_THINKING = "high";
const MEDIUM_THINKING = "low";
const LIGHT_THINKING = "low";

// FIX-RESCUE-05: per-tier agent-timeout ladder (seconds). runAgent passes this
// as `--timeout` AND uses timeoutSecs+30 as its own SIGKILL wall; the serial
// queue cap is set to timeoutSecs+60 at enqueue time (see enqueueFixJob), so the
// invariant QUEUE_JOB_TIMEOUT > agentWall > agent --timeout holds for EVERY tier
// and the agent's own timeout always fires first. HARD keeps the historical
// global default so genuinely complex incidents still get the long budget.
const LIGHT_TIMEOUT      = parseInt(process.env.RESCUE_LIGHT_TIMEOUT      || "120", 10);
const STRUCTURED_TIMEOUT = parseInt(process.env.RESCUE_STRUCTURED_TIMEOUT || "180", 10);
const MEDIUM_TIMEOUT     = parseInt(process.env.RESCUE_MEDIUM_TIMEOUT     || "240", 10);
const HARD_TIMEOUT       = AGENT_TIMEOUT; // RESCUE_AGENT_TIMEOUT || 540

function classifyTier(message) {
  const m = (message || "").toLowerCase();

  // Hard guardrail: any destructive / credential / security / data-loss keyword
  // forces HARD regardless of anything else. Check first.
  const destructiveRe =
    /rm\s+-rf|docker\s+volume\s+rm|git\s+reset\s+--hard|force.push|drop\s+table|truncate|delete\s+(all|database)|wipe|credential|secret|api.?key|token|password|auth\s+fail|unauthorized|403|data.?loss|security/i;
  if (destructiveRe.test(message)) {
    return { tier: "hard", model: null, thinking: HARD_THINKING, timeoutSecs: HARD_TIMEOUT, reason: "destructive/credential guardrail" };
  }

  // STRUCTURED tier: matches remediate.sh's 4 known auto-fix failure classes.
  const structuredRe =
    /agents\.list|schema\s+validation|AgentsConfigError|InvalidAgentsList|container.*(exited|dead|created)|exited.*container|gateway.port.*(closed|not.listening)|connect\s+ECONNREFUSED.*18789/i;
  if (structuredRe.test(message)) {
    return { tier: "structured", model: STRUCTURED_MODEL, thinking: LIGHT_THINKING, timeoutSecs: STRUCTURED_TIMEOUT, reason: "matches remediate.sh class" };
  }

  // LIGHT tier: routing tests, synthetic probes, trivial ops probes.
  const lightRe =
    /\[routing\s+test\]|\[synthetic\]|\btest\s+ticket\b|^ack$/i;
  if (lightRe.test(message)) {
    return { tier: "light", model: LIGHT_MODEL, thinking: LIGHT_THINKING, timeoutSecs: LIGHT_TIMEOUT, reason: "routing test / synthetic / trivial" };
  }

  // HARD (reserved): only genuinely severe / fleet-scale / ambiguous incidents
  // keep the strong agent-primary model at high thinking. Everything else falls
  // through to MEDIUM below. This narrow escalation is what stops the common
  // coach/how-to ticket from ever reaching the expensive path.
  const hardRe =
    /production\s+down|whole\s+fleet|fleet.?wide|multiple\s+(boxes|clients|agents)|everything.*(down|broken)|nothing\s+works|corrupt|escalat|urgent|sev-?1|p0\b/i;
  if (hardRe.test(m)) {
    return { tier: "hard", model: null, thinking: HARD_THINKING, timeoutSecs: HARD_TIMEOUT, reason: "severe/fleet-scale incident; agent-primary (ollama/kimi-k2.6:cloud)/high" };
  }

  // Default: MEDIUM -- coach-client-agent / how-to / single-box advisory (the
  // common case). Cheap/fast model at low thinking, tight 240s budget.
  return { tier: "medium", model: MEDIUM_MODEL, thinking: MEDIUM_THINKING, timeoutSecs: MEDIUM_TIMEOUT, reason: "coach/how-to/advisory default -> medium (ollama/deepseek-v4-flash:cloud)/low" };
}

// === FIX-MODE classifier (deterministic, zero tokens) -- chooses the ACTION ===
// Modes: deliver-answer | coach-client-agent | fix-it-ourselves | escalate-human
// The destructive/credential guard ALWAYS wins -> escalate-human (mirrors the
// hard-tier guardrail; a human approves anything destructive).
// This runs IN ADDITION to classifyTier (which picks the MODEL). They are independent.
function classifyFixMode(message) {
  const m = (message || "").toString();
  const destructiveRe =
    /rm\s+-rf|docker\s+volume\s+rm|git\s+reset\s+--hard|force.?push|drop\s+table|truncate|delete\s+(all|database)|wipe|credential|secret|api.?key|token|password|rotate|dns|cloudflare\s+(dns|tunnel)/i;
  if (destructiveRe.test(m)) {
    return { mode: "escalate-human", reason: "destructive/credential/DNS guard" };
  }
  // fix-it-ourselves: a known auto-fixable failure class (matches remediate.sh)
  const selfFixRe =
    /agents\.list|schema\s+validation|AgentsConfigError|container.*(exited|dead|created)|gateway.port.*(closed|not.listening)|ECONNREFUSED.*18789|force-recreate|whatsapp.*(crash|loop)/i;
  if (selfFixRe.test(m)) {
    return { mode: "fix-it-ourselves", reason: "known auto-fix class" };
  }
  // deliver-answer: pure how-to / question / no actionable broken-box signal
  const answerRe =
    /how\s+do\s+i|what\s+is|which|why\s+does|\?\s*$|\[routing\s+test\]|\[synthetic\]/i;
  if (answerRe.test(m) && !/error|down|crash|fail|stuck|broken|unreachable/i.test(m)) {
    return { mode: "deliver-answer", reason: "question / how-to, no broken signal" };
  }
  // default: coach the client agent to fix itself
  return { mode: "coach-client-agent", reason: "default; coach client agent" };
}

// Derive status prefix from fix mode (used in postAnswerBack and carried to relay).
function statusPrefixFromMode(mode) {
  switch (mode) {
    case "deliver-answer":   return "answer:";
    case "coach-client-agent": return "do this:";
    case "fix-it-ourselves": return "fixed:";
    case "escalate-human":   return "in progress:";
    default:                 return "answer:";
  }
}

// === CONTRACT: decisionMode + ticket status, mapped from classifyFixMode ======
// Every answer the receiver posts back to n8n carries BOTH of these so the relay
// always knows what was decided and the lifecycle state -- no silent ambiguity.
//   fix-it-ourselves   -> WE_FIXED_IT     (we ran the real fix)
//   coach-client-agent -> TOLD_YOUR_AGENT (we handed the client agent the fix)
//   deliver-answer     -> JUST_AN_ANSWER  (pure how-to / question)
//   escalate-human     -> HUMAN_NEEDED    (destructive/secret/failure -> a human)
function decisionModeFromFixMode(mode) {
  switch (mode) {
    case "fix-it-ourselves":   return "WE_FIXED_IT";
    case "coach-client-agent": return "TOLD_YOUR_AGENT";
    case "deliver-answer":     return "JUST_AN_ANSWER";
    case "escalate-human":     return "HUMAN_NEEDED";
    default:                   return "JUST_AN_ANSWER";
  }
}

// Ticket lifecycle status: OPEN | IN_PROGRESS | RESOLVED.
// We answered/fixed -> RESOLVED. Anything routed to a human (destructive guard,
// billing, timeout, empty reply) -> IN_PROGRESS (a human still has to act).
function statusFromFixMode(mode) {
  return mode === "escalate-human" ? "IN_PROGRESS" : "RESOLVED";
}

// === RR #5: structured fixer (remediate.sh) helpers =========================
// Map a fix-it-ourselves message to one of remediate.sh's known auto-fix classes.
// Returns null when no specific class is recognizable (we then keep agent advice).
function remediateClassFromMessage(message) {
  const m = (message || "").toString().toLowerCase();
  if (/container.*(exited|dead|created)|exited.*container|force-recreate|oomkilled|out of memory/.test(m)) return "container-exited";
  if (/agents\.list|schema\s+validation|agentsconfigerror|invalidagentslist|config.*invalid/.test(m)) return "config-invalid";
  if (/gateway.port.*(closed|not.listening)|econnrefused.*18789|18789.*(closed|not.listening|refused)|port\s*18789/.test(m)) return "gateway-port-closed";
  if (/launchctl|mac.?gateway|gateway.*down.*(mac|launchd)/.test(m)) return "mac-gateway-down";
  return null;
}

// Build the 8 positional args remediate.sh expects from whatever context the
// relay forwarded (parsed.remediate). Missing fields become safe placeholders; in
// DRY-RUN + forced class only CLIENT and CONTAINER affect the plan text.
function remediateArgsFromCtx(ctx, fallbackClient) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  return [
    (c.client || fallbackClient || "unknown").toString(),
    (c.persona || "").toString(),
    (c.ip || "unknown").toString(),
    (c.container || "openclaw-unknown-openclaw-1").toString(),
    (c.version || "unknown").toString(),
    (c.gateway || "unknown").toString(),
    (c.ssh || "unknown").toString(),
    (c.notes || "relay-fix-it-ourselves").toString(),
  ];
}

// Parse the ===REMEDIATE-RESULT=== block remediate.sh emits into a flat object.
function parseRemediateResult(stdout) {
  const start = (stdout || "").indexOf("===REMEDIATE-RESULT===");
  if (start < 0) return null;
  const out = {};
  for (const line of stdout.slice(start).split("\n")) {
    if (line.startsWith("===")) continue;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

// Run the structured fixer for a known class. dryRun=true (default) plans only.
// Resolves { ok, result, raw } -- never throws. SAFETY: dry-run uses the zero-SSH
// REMEDIATE_FORCE_CLASS planner so it can never mutate a box.
function runRemediatePlan(klass, ctx, fallbackClient, dryRun) {
  return new Promise((resolve) => {
    const args = remediateArgsFromCtx(ctx, fallbackClient);
    const env = Object.assign({}, process.env, {
      REMEDIATE_DRY_RUN: dryRun ? "1" : "0",
      REMEDIATE_FORCE_CLASS: klass,
      // Pass the inner wall through so remediate.sh's gateway-recovery waits and long
      // mutating commands (rebuild) honor it instead of the old hardcoded 90s, so a
      // legit long fix is not cut short below its class budget.
      REMEDIATE_TIMEOUT: String(REMEDIATE_TIMEOUT),
    });
    let child;
    try {
      child = spawn("bash", [REMEDIATE_SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: `spawn failed: ${e.message}` });
    }
    const wall = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, (REMEDIATE_TIMEOUT + 10) * 1000);
    let outBuf = "";
    let errBuf = "";
    child.stdout.on("data", (b) => (outBuf += b.toString()));
    child.stderr.on("data", (b) => (errBuf += b.toString()));
    child.on("error", (e) => { clearTimeout(wall); resolve({ ok: false, error: e.message }); });
    child.on("close", () => {
      clearTimeout(wall);
      const result = parseRemediateResult(outBuf);
      resolve({ ok: !!result, result, raw: outBuf.slice(-1200), stderrTail: errBuf.slice(-200) });
    });
  });
}

// Compose a short, plain-text "Structured fix" section from a remediate result.
function formatRemediateSummary(result, dryRun) {
  if (!result) return "";
  const label = dryRun ? "Structured fix (remediate.sh, DRY-RUN plan)" : "Structured fix (remediate.sh)";
  return (
    label + ":\n" +
    "Failure class: " + (result.class || "(unknown)") + "\n" +
    "Action: " + (result.tried || "(none)") + "\n" +
    "Outcome: " + (result.outcome || "(unknown)")
  );
}

function runAgent(message, opts = {}) {
  const thinking = opts.thinking || HARD_THINKING;
  const model = opts.model || null;
  // FIX-RESCUE-05: honor the tier's per-run timeout (falls back to the global
  // default for callers that do not classify). The SIGKILL wall below is set to
  // timeoutSecs+30 so the agent's OWN --timeout fires first.
  const timeoutSecs = opts.timeoutSecs || AGENT_TIMEOUT;
  return new Promise((resolve) => {
    const args = [
      "agent",
      "--agent",
      AGENT_ID,
      "--message",
      message,
      "--json",
      "--timeout",
      String(timeoutSecs),
      "--thinking",
      thinking,
    ];
    if (model) {
      args.push("--model", model);
    }
    let out = "";
    let err = "";
    // (d) HARD TIMEOUT TRACKING: set to true when the wall timer fires so
    // runAgentAndReport can distinguish a timeout from other empty-reply causes
    // and page Trevor with a specific timeout alarm.
    let _timedOut = false;
    let child;
    try {
      child = spawn(OPENCLAW_BIN, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({
        reply: "",
        error: `spawn failed: ${e.message}`,
        timedOut: false,
        stdoutTail: "",
        stderrTail: "",
      });
    }
    // Hard wall slightly beyond the agent's own timeout. Marks _timedOut so
    // the caller can page a human instead of going quiet.
    const wall = setTimeout(() => {
      _timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }, (timeoutSecs + 30) * 1000);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", (e) =>
      resolve({
        reply: "",
        error: `child error: ${e.message}`,
        timedOut: _timedOut,
        stdoutTail: out.slice(-600),
        stderrTail: err.slice(-300),
      })
    );
    child.on("close", (code) => {
      clearTimeout(wall);
      const reply = extractReply(out);
      resolve({
        reply,
        code,
        timedOut: _timedOut,
        stdoutTail: out.slice(-600),
        stderrTail: err.slice(-300),
      });
    });
  });
}

// POST the agent's answer back to the n8n relay (action="answer"). n8n then
// posts it into the Telegram group thread and closes/answers the ticket. Used
// by the ASYNC push path so the flow self-completes without the poller.
// Extra fields (fixMode, statusPrefix, client, agent, returnTo) are additive --
// the relay ignores unknowns if they are not yet wired; they are forward-compatible
// for the return-leg and fix-mode matrix features.
function postAnswerBack(ticketId, answer, extras = {}) {
  return new Promise((resolve) => {
    // CONTRACT: the answer POST ALWAYS carries decisionMode + status (ticket
    // lifecycle). Default them here so no code path can post back without them.
    const merged = { ...extras };
    if (!merged.decisionMode) merged.decisionMode = "JUST_AN_ANSWER";
    if (!merged.status) merged.status = "RESOLVED";
    let payload;
    try {
      payload = JSON.stringify({ action: "answer", ticketId, answer, ...merged });
    } catch (e) {
      return resolve({ ok: false, error: `stringify failed: ${e.message}` });
    }
    let url;
    try {
      url = new URL(RELAY_URL);
    } catch (e) {
      return resolve({ ok: false, error: `bad RELAY_URL: ${e.message}` });
    }
    const mod = url.protocol === "http:" ? httpMod : httpsMod;
    // Include the webhook secret header if set (required when relay enforces auth).
    const outHeaders = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    const RELAY_WEBHOOK_SECRET = process.env.RESCUE_RANGERS_WEBHOOK_SECRET || "";
    if (RELAY_WEBHOOK_SECRET) {
      outHeaders["X-Rescue-Secret"] = RELAY_WEBHOOK_SECRET;
    }
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        method: "POST",
        headers: outHeaders,
        timeout: 30000,
      },
      (r) => {
        let b = "";
        r.on("data", (c) => (b += c.toString()));
        r.on("end", () =>
          resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body: b.slice(0, 300) })
        );
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("relay timeout"));
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// === RR SLOW-FIX HANDLING: in-progress ack + fix-level timeout escalation =====
// A genuinely slow structured fix (e.g. a container rebuild that takes minutes) must
// never be silent until done, and must never hang the handler. Three small helpers:
//   runRemediateWithBudget -- race the fix against its PER-CLASS budget (fixBudgetForClass)
//                             so the receiver STOPS WAITING on an overrunning fix. The fix
//                             may keep running detached; the receiver just stops blocking on
//                             it. While the fix runs it also posts periodic progress
//                             heartbeats so a long fix is never silent.
//   postProgressAck        -- an interim "fixing now" post fired the instant the fix
//                             STARTS, so a slow fix is never silent. It deliberately does
//                             NOT claimTicket, so the final outcome/escalation post (the
//                             one guarded by the _answeredTickets n8n-retry dedup) still
//                             goes through.
//   escalateSlowFix        -- when the fix overruns the budget, escalate to a human and
//                             page the operator, WITHOUT hanging the handler.

// Race runRemediatePlan against this class's budget (fixBudgetForClass). Resolves
// { timedOut:true, budget } if the budget wins (the underlying fix keeps running detached
// and its late result is ignored), else { timedOut:false, rem, budget } with the real
// remediate result. Never throws.
//
// PROGRESS HEARTBEAT: when hb={ticketId,extras} is supplied, a fix that runs past
// FIX_HEARTBEAT_DELAY posts a periodic plain-text "still working on it -- N minutes in"
// update (every FIX_HEARTBEAT_INTERVAL) so a long fix is never silent. These heartbeat
// posts deliberately do NOT claimTicket, so the final outcome/escalation post still goes
// through the _answeredTickets dedup afterwards.
function runRemediateWithBudget(klass, ctx, fallbackClient, dryRun, hb) {
  const budget = fixBudgetForClass(klass);
  return new Promise((resolve) => {
    let settled = false;
    const startedAt = Date.now();
    let hbTimer = null;
    let hbInterval = null;
    if (hb && hb.ticketId) {
      const beat = () => {
        if (settled) return;
        const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
        postAnswerBack(
          hb.ticketId,
          `still working on it - ${mins} ${mins === 1 ? "minute" : "minutes"} in.`,
          {
            ...(hb.extras || {}),
            fixMode: "fix-it-ourselves",
            statusPrefix: "fixing:",
            decisionMode: "WE_ARE_FIXING",
            status: "IN_PROGRESS",
          }
        ).then((r) => {
          log(`FIX-HEARTBEAT ticket=${hb.ticketId} class=${klass} mins=${mins} relayStatus=${r && r.ok ? r.status : (r && (r.error || r.status))}`);
        });
      };
      hbTimer = setTimeout(() => {
        beat();
        hbInterval = setInterval(beat, FIX_HEARTBEAT_INTERVAL * 1000);
      }, FIX_HEARTBEAT_DELAY * 1000);
    }
    const clearHb = () => {
      if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }
      if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearHb();
      resolve({ timedOut: true, budget });
    }, budget * 1000);
    runRemediatePlan(klass, ctx, fallbackClient, dryRun).then(
      (rem) => {
        if (settled) return; // budget already won; ignore the late result
        settled = true;
        clearTimeout(timer);
        clearHb();
        resolve({ timedOut: false, rem, budget });
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearHb();
        resolve({ timedOut: false, rem: { ok: false, error: e && e.message }, budget });
      }
    );
  });
}

// Interim "IN PROGRESS -- diagnosed <class>, fixing now" ack. Posted BEFORE the fix
// starts so a slow fix is never silent. Uses the in-progress decision signal and the
// 'fixing:' status prefix. Deliberately does NOT claimTicket -- the final outcome (or
// escalation) post must still go through the _answeredTickets dedup afterwards.
async function postProgressAck(ticketId, klass, extras) {
  const ack = await postAnswerBack(ticketId, `IN PROGRESS -- diagnosed ${klass}, fixing now.`, {
    ...extras,
    fixMode: "fix-it-ourselves",
    statusPrefix: "fixing:",
    decisionMode: "WE_ARE_FIXING",
    status: "IN_PROGRESS",
  });
  log(`FIX-ACK in-progress ticket=${ticketId} class=${klass} relayStatus=${ack.ok ? ack.status : (ack.error || ack.status)}`);
  return ack;
}

// The structured fix overran ITS class budget: escalate to a human + page the
// operator (the existing operator-alarm path), WITHOUT hanging the handler. The fix
// may still be running detached. claimTicket guards against double-close races.
async function escalateSlowFix(ticketId, klass, extras, budget) {
  const b = Number.isFinite(budget) ? budget : fixBudgetForClass(klass);
  if (!claimTicket(ticketId)) {
    log(`FIX-TIMEOUT ticket=${ticketId} already closed; skipping escalation`);
    return;
  }
  log(`FIX-TIMEOUT ticket=${ticketId} class=${klass} exceeded ${b}s class budget -- escalating to human (fix may still be running in background)`);
  const back = await postAnswerBack(
    ticketId,
    `STILL WORKING after ${b}s -- escalating to a human. (diagnosed ${klass}; the structured fix is taking longer than its ${b}s class budget and may still be running in the background.)`,
    { ...extras, fixMode: "escalate-human", statusPrefix: "in progress:", decisionMode: "HUMAN_NEEDED", status: "IN_PROGRESS" }
  );
  log(`FIX-TIMEOUT escalation posted ticket=${ticketId} relayStatus=${back.ok ? back.status : (back.error || back.status)}`);
  const gr = await postTelegramAlarm(
    `[RR FIX TIMEOUT] structured fix for ticket=${ticketId} (class ${klass}) exceeded its ${b}s class budget -- escalated to a human; fix may still be running in the background.`,
    FIXER_GROUP_CHAT_ID, FIXER_THREAD_ID
  );
  log(`FIX-TIMEOUT alarm Fixer-topic ok=${gr.ok}`);
  const dr = await postTelegramAlarm(
    `[RR FIX TIMEOUT] ticket=${ticketId} fix (class ${klass}) >${b}s budget -- escalated to human; check the box.`,
    TREVOR_CHAT_ID, null
  );
  log(`FIX-TIMEOUT alarm Trevor DM ok=${dr.ok}`);
}

// Background worker for the ASYNC path: run the agent, then post the answer
// back to n8n. Never throws to the (already-responded) HTTP request.
// All failure modes (billing, timeout, empty reply) now page Trevor and close
// the ticket rather than going quiet.
//
// fixMode: result of classifyFixMode() -- threaded through to postAnswerBack.
// returnExtras: {client, agent, returnTo} from the inbound parsed body.
async function runAgentAndReport(message, ticketId, agentOpts = {}, fixMode = null, returnExtras = {}, remediateCtx = null) {
  const started = Date.now();

  // Build additive extras shared by all paths (fast fix + success + all failure paths).
  // CONTRACT: decisionMode + status are ALWAYS present (mapped from classifyFixMode);
  // failure paths below override them to HUMAN_NEEDED / IN_PROGRESS.
  // HOISTED ABOVE the agent turn so the fast structured-fix path can use them too.
  const extras = {};
  const baseMode = fixMode ? fixMode.mode : null;
  if (fixMode) {
    extras.fixMode = fixMode.mode;
    extras.fixModeReason = fixMode.reason;
    extras.statusPrefix = statusPrefixFromMode(fixMode.mode);
  }
  extras.decisionMode = decisionModeFromFixMode(baseMode);
  extras.status = statusFromFixMode(baseMode);
  if (returnExtras.client)   extras.client   = returnExtras.client;
  if (returnExtras.agent)    extras.agent     = returnExtras.agent;
  if (returnExtras.returnTo) extras.returnTo  = returnExtras.returnTo;

  // -------------------------------------------------------------------------
  // RR LATENCY FIX: run the structured fixer BEFORE the slow AI agent turn.
  // A KNOWN auto-fixable ticket (fix-it-ourselves + a recognized remediate class)
  // in LIVE mode with real box context gets the structured fix IMMEDIATELY, so the
  // box comes back in ~10s instead of waiting out the ~195s (ceiling 540s) AI turn.
  // When the fix lands we post the concrete outcome + return-leg and SKIP the heavy
  // agent turn (still delivering a plain-text outcome the relay forwards on the
  // return-leg via extras). SAFETY RAIL: classifyFixMode routes every destructive/
  // credential/DNS ticket to escalate-human, which is NEVER "fix-it-ourselves", so
  // this branch can never run the fixer on a dangerous ticket. DRY-RUN default is
  // unaffected: this path only runs when REMEDIATE_LIVE AND real container+ip context
  // are present; otherwise the (unchanged) slow-path block plans in dry-run as before.
  let _fastRem = null;
  let _fastKlass = null;
  if (
    fixMode && fixMode.mode === "fix-it-ourselves" &&
    REMEDIATE_LIVE && remediateCtx && remediateCtx.container && remediateCtx.ip
  ) {
    _fastKlass = remediateClassFromMessage(message);
    // Skip the live pass if a prior job already closed this ticket (n8n retry) so we
    // never fire a second live remediation on the same ticket.
    if (_fastKlass && !(ticketId && _answeredTickets.has(ticketId))) {
      // (1) IMMEDIATE IN-PROGRESS ACK -- fired the instant the structured fix STARTS so
      // a slow fix is never silent. Does NOT claimTicket, so the final outcome/escalation
      // post still goes through the _answeredTickets dedup below.
      await postProgressAck(ticketId, _fastKlass, extras);
      // (2) PER-CLASS BUDGET + PROGRESS HEARTBEAT -> ESCALATE ONLY ON TRUE OVERRUN:
      // race the LIVE fix against ITS class budget (FAST ~3min, LONG ~22min). While it
      // runs, periodic heartbeats post "still working on it" so a long fix is never
      // silent. If it overruns its class budget, STOP blocking and escalate to a human
      // (the fix may keep running detached) so the handler never hangs. A legitimately
      // slow fix WITHIN its budget keeps running and then posts its real outcome below.
      const fast = await runRemediateWithBudget(_fastKlass, remediateCtx, returnExtras.client, false, { ticketId, extras }); // LIVE
      if (fast.timedOut) {
        await escalateSlowFix(ticketId, _fastKlass, extras, fast.budget);
        return;
      }
      _fastRem = fast.rem;
      // (3) FINAL OUTCOME: fix finished within budget -- post the real outcome as before.
      if (_fastRem && _fastRem.ok && _fastRem.result) {
        if (!claimTicket(ticketId)) {
          log(`FAST-FIX ticket=${ticketId} already closed after fix; skipping post`);
          return;
        }
        const fastElapsed = ((Date.now() - started) / 1000).toFixed(1);
        const answerText =
          formatRemediateSummary(_fastRem.result, false) +
          "\n\nApplied by the structured remediator before the AI pass; the box should be back. Reply if anything still looks off.";
        extras.remediateOutcome = _fastRem.result.outcome;
        extras.remediateClass = _fastKlass;
        log(`FAST-FIX ticket=${ticketId} class=${_fastKlass} outcome=${_fastRem.result.outcome} elapsed=${fastElapsed}s -- posting before AI turn`);
        const back = await postAnswerBack(ticketId, answerText, extras);
        log(`FAST-FIX answer posted back ticket=${ticketId} relayStatus=${back.ok ? back.status : (back.error || back.status)} mode=${extras.fixMode || "?"} statusPrefix=${extras.statusPrefix || "?"}`);
        return;
      }
      // Structured fixer produced no usable result -> fall through to the AI agent for
      // a human-readable answer. The slow-path remediate block reuses _fastRem so we
      // never fire a second live remediation on this ticket.
      log(`FAST-FIX ticket=${ticketId} class=${_fastKlass} no usable result (${(_fastRem && _fastRem.error) || "no result"}); falling through to AI turn`);
    }
  }

  // -------------------------------------------------------------------------
  // SLOW PATH: the full AI agent turn. Runs for every non-fast-fix ticket
  // (coach-client-agent, deliver-answer, escalate-human, dry-run/not-live
  // fix-it-ourselves) AND for a fast-fix ticket whose structured fix produced
  // no usable result.
  // -------------------------------------------------------------------------
  const { reply, error, code, timedOut, stdoutTail, stderrTail } = await runAgent(message, agentOpts);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // -------------------------------------------------------------------------
  // (c) BILLING ALARM: detect credit exhaustion / model suspension FIRST.
  // Posts to the Fixer topic (thread 3) + Trevor's DM, then closes the ticket
  // with "human needed" so it does not sit pending forever.
  // -------------------------------------------------------------------------
  const billing = detectBillingFailure(stdoutTail || "", stderrTail || "");
  if (billing) {
    if (!claimTicket(ticketId)) { log(`BILLING ALARM ticket=${ticketId} already closed; skipping`); return; }
    log(`BILLING ALARM ticket=${ticketId} elapsed=${elapsed}s provider=${billing.provider} signal=${billing.signal}`);
    const alarmText =
      `[BILLING ALARM] ${billing.message}\nProvider: ${billing.provider}\nSignal: ${billing.signal}\nticket=${ticketId} elapsed=${elapsed}s -- top up ${billing.provider} or switch model. Receiver still running; tickets will fail until resolved.`;
    const ar = await postTelegramAlarm(alarmText, FIXER_GROUP_CHAT_ID, FIXER_THREAD_ID);
    log(`BILLING ALARM Fixer-topic ok=${ar.ok} status=${ar.status || ar.error || ""}`);
    const dmText =
      `[RR BILLING ALARM] ${billing.message} | ticket=${ticketId} -- fixer cannot answer until ${billing.provider} is topped up.`;
    const dr = await postTelegramAlarm(dmText, TREVOR_CHAT_ID, null);
    log(`BILLING ALARM Trevor DM ok=${dr.ok}`);
    // Close the ticket so it does not sit pending forever.
    const humanMsg = `IN PROGRESS -- billing failure on ${billing.provider}: ${billing.signal}. ${billing.message}. Human action needed.`;
    await postAnswerBack(ticketId, humanMsg, {
      ...extras,
      fixMode: "escalate-human",
      statusPrefix: "in progress:",
      decisionMode: "HUMAN_NEEDED",
      status: "IN_PROGRESS",
    });
    return;
  }

  // -------------------------------------------------------------------------
  // (d) HARD TIMEOUT PAGE: wall timer fired -- page Trevor + close ticket.
  // The wall is AGENT_TIMEOUT+30 seconds (currently ${AGENT_TIMEOUT + 30}s).
  // -------------------------------------------------------------------------
  if (timedOut) {
    if (!claimTicket(ticketId)) { log(`TIMEOUT ticket=${ticketId} already closed; skipping`); return; }
    const wallSecs = (agentOpts.timeoutSecs || AGENT_TIMEOUT) + 30;
    log(`TIMEOUT ticket=${ticketId} exceeded ${wallSecs}s wall elapsed=${elapsed}s`);
    const toText =
      `[RR TIMEOUT] rescue agent exceeded ${wallSecs}s wall -- ticket=${ticketId} elapsed=${elapsed}s -- human needed`;
    const tr = await postTelegramAlarm(toText, FIXER_GROUP_CHAT_ID, FIXER_THREAD_ID);
    log(`TIMEOUT alarm Fixer-topic ok=${tr.ok}`);
    const toDm =
      `[RR TIMEOUT] ticket=${ticketId} took >${wallSecs}s -- fixer timed out; check the agent.`;
    const tdr = await postTelegramAlarm(toDm, TREVOR_CHAT_ID, null);
    log(`TIMEOUT alarm Trevor DM ok=${tdr.ok}`);
    const humanMsg = `IN PROGRESS -- fixer timed out (exceeded ${wallSecs}s). Human action needed.`;
    await postAnswerBack(ticketId, humanMsg, {
      ...extras,
      fixMode: "escalate-human",
      statusPrefix: "in progress:",
      decisionMode: "HUMAN_NEEDED",
      status: "IN_PROGRESS",
    });
    return;
  }

  // -------------------------------------------------------------------------
  // (b) NO-SILENT-EMPTY: agent returned no text (not billing, not timeout).
  // Posts "IN PROGRESS -- human needed" to close the ticket AND pages Trevor.
  // The old behavior was silent return (ticket stayed pending forever).
  // -------------------------------------------------------------------------
  if (error || !reply) {
    if (!claimTicket(ticketId)) { log(`NO-SILENT-EMPTY ticket=${ticketId} already closed; skipping`); return; }
    log(
      `ASYNC agent EMPTY/ERROR ticket=${ticketId} elapsed=${elapsed}s code=${code} err=${error || ""} stderr=${stderrTail || ""} -- posting human-needed alarm (NO-SILENT-EMPTY)`
    );
    const humanMsg =
      `IN PROGRESS -- fixer could not answer, human needed. (ticket=${ticketId}, exitCode=${code ?? "?"}, error: ${error || "no reply text returned"})`;
    const back = await postAnswerBack(ticketId, humanMsg, {
      ...extras,
      fixMode: "escalate-human",
      statusPrefix: "in progress:",
      decisionMode: "HUMAN_NEEDED",
      status: "IN_PROGRESS",
    });
    log(`NO-SILENT-EMPTY relay post ok=${back.ok} status=${back.status || back.error || ""}`);
    // Page Trevor directly.
    const trevMsg =
      `[RR EMPTY REPLY] ticket=${ticketId} elapsed=${elapsed}s -- fixer returned no text; human needed.`;
    const dr = await postTelegramAlarm(trevMsg, TREVOR_CHAT_ID, null);
    log(`NO-SILENT-EMPTY Trevor DM ok=${dr.ok}`);
    return;
  }

  // -------------------------------------------------------------------------
  // SUCCESS PATH: agent returned a reply -- post it back to n8n.
  // -------------------------------------------------------------------------
  log(`ASYNC reply ticket=${ticketId} chars=${reply.length} elapsed=${elapsed}s mode=${fixMode ? fixMode.mode : "unknown"}`);
  // P0e DEDUP / close-once: prevent posting the same answer twice from this
  // process instance (n8n retry race) AND prevent racing the queue backstop.
  if (!claimTicket(ticketId)) {
    log(`DEDUP skip ticket=${ticketId} -- already closed by this receiver instance`);
    return;
  }

  // RR #5: fix-it-ourselves on a KNOWN failure class -> run the REAL structured
  // fixer (dry-run safe) and LEAD the answer with the concrete fix it planned/ran,
  // so the close post's "What we did" is a real action, not just advice. The
  // destructive/credential/DNS guard in classifyFixMode already routes anything
  // dangerous to escalate-human, so this never fires for those tickets.
  let answerText = reply;
  if (fixMode && fixMode.mode === "fix-it-ourselves") {
    const klass = _fastKlass || remediateClassFromMessage(message);
    if (klass) {
      // Live only when explicitly enabled AND we have real box context; else dry-run plan.
      const dry = !(REMEDIATE_LIVE && remediateCtx && remediateCtx.container && remediateCtx.ip);
      // Reuse the fast-path remediation if this same job already ran it (avoids a second
      // live pass on one ticket); otherwise run it now under the SAME fix-level budget so
      // a slow plan can never hang the post. On budget timeout here we KEEP the agent
      // advice we already have (we have a real answer to deliver -- no escalation needed).
      let rem = _fastRem;
      if (!rem) {
        const budgeted = await runRemediateWithBudget(klass, remediateCtx, returnExtras.client, dry, { ticketId, extras });
        if (budgeted.timedOut) {
          log(`ASYNC remediate TIMEOUT ticket=${ticketId} class=${klass} exceeded ${budgeted.budget}s class budget -- keeping agent advice`);
          rem = { ok: false, error: "fix-level timeout" };
        } else {
          rem = budgeted.rem;
        }
      }
      if (rem.ok && rem.result) {
        answerText = formatRemediateSummary(rem.result, dry) + "\n\n" + reply;
        extras.remediateOutcome = rem.result.outcome;
        extras.remediateClass = klass;
        log(`ASYNC remediate ticket=${ticketId} class=${klass} dry=${dry} reused=${!!_fastRem} outcome=${rem.result.outcome} tried=${(rem.result.tried || "").slice(0, 120)}`);
      } else {
        log(`ASYNC remediate SKIPPED ticket=${ticketId} class=${klass} err=${rem.error || "no result"} (keeping agent advice)`);
      }
    }
  }

  const back = await postAnswerBack(ticketId, answerText, extras);
  if (back.ok) {
    log(`ASYNC answer posted back ticket=${ticketId} relayStatus=${back.status} mode=${extras.fixMode || "?"} statusPrefix=${extras.statusPrefix || "?"}`);
  } else {
    log(
      `ASYNC answer post-back FAILED ticket=${ticketId} err=${
        back.error || back.status
      } body=${back.body || ""} (poller fallback will retry)`
    );
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// RETURN-LEG: allowlisted client boxes for /rescue-return delivery.
//
// TWO entry types:
//
// 1. Mac-tunnel (no "type" field):
//    { sshAlias, agent, shell }
//    sshAlias = Host alias in ~/.ssh/config — the alias carries the CF Access
//    ProxyCommand + service-token so SSH works silently from this Mac.
//    agent    = OpenClaw agent id. Always "main" — persona display names
//               (Keez, Candace, etc.) are NOT valid --agent values.
//    shell    = login shell. zsh everywhere except Barret's MacBook Air (bash).
//    Path proven 2026-06-26.
//
// 2. VPS / Docker-exec (type: "vps"):
//    { type:"vps", sshHost, sshKey, container, agent }
//    sshHost   = "root@IP" or a named SSH alias (contabo-host) that already
//                carries the right IdentityFile in ~/.ssh/config.
//    sshKey    = explicit key path, or null to rely on SSH config.
//                null = use default id_ed25519 for plain root@IP targets;
//                       for named aliases the config handles it automatically.
//    container = full Docker container name (openclaw-hy5t-openclaw-1, etc.).
//    Path: ssh -T [-i key] sshHost
//            "docker exec -u node -e PATH=... CONTAINER sh -c 'decode+run'"
//    ALL VPS entries are wired but UNTESTED (2026-06-26). The SSH and docker
//    exec structure is correct; loopback verification against live containers
//    has NOT been run. Mac-tunnel entries are the proven return path.
//
// VPS box keys follow the pattern "vps-<client>" to distinguish from Mac entries.
// ---------------------------------------------------------------------------
const RETURN_BOX_ALLOWLIST = {
  // ---- Mac-tunnel clients (proven 2026-06-26) ----
  "rescue-teresa-pelham":               { sshAlias: "rescue-teresa-pelham",               agent: "main", shell: "zsh" },
  "rescue-kofi-bryant":                 { sshAlias: "rescue-kofi-bryant",                 agent: "main", shell: "zsh" },
  "rescue-cassandra-henriquez":         { sshAlias: "rescue-cassandra-henriquez",         agent: "main", shell: "zsh" },
  "rescue-karen-vaughn":                { sshAlias: "rescue-karen-vaughn",                agent: "main", shell: "zsh" },
  "rescue-jill-bulluck":                { sshAlias: "rescue-jill-bulluck",                agent: "main", shell: "zsh" },
  "rescue-sheila-reynolds":             { sshAlias: "rescue-sheila-reynolds",             agent: "main", shell: "zsh" },
  "rescue-aurelia-gardner":             { sshAlias: "rescue-aurelia-gardner",             agent: "main", shell: "zsh" },
  "rescue-aurelia-gardner-macbookpro":  { sshAlias: "rescue-aurelia-gardner-macbookpro",  agent: "main", shell: "zsh" },
  "rescue-lyric-hawkins":               { sshAlias: "rescue-lyric-hawkins",               agent: "main", shell: "zsh" },
  "rescue-leanne-dolce":                { sshAlias: "rescue-leanne-dolce",                agent: "main", shell: "zsh" },
  "rescue-sonatta-camara":              { sshAlias: "rescue-sonatta-camara",              agent: "main", shell: "zsh" },
  "rescue-talaya-kelley":               { sshAlias: "rescue-talaya-kelley",               agent: "main", shell: "zsh" },
  "rescue-stephanie-wall":              { sshAlias: "rescue-stephanie-wall",              agent: "main", shell: "zsh" },
  "rescue-jocelyn-mcclure":             { sshAlias: "rescue-jocelyn-mcclure",             agent: "main", shell: "zsh" },
  "rescue-barret-matthews":             { sshAlias: "rescue-barret-matthews",             agent: "main", shell: "bash" },
  "rescue-christy-staples":             { sshAlias: "rescue-christy-staples",             agent: "main", shell: "zsh" },
  "rescue-maria-anderson":              { sshAlias: "rescue-maria-anderson",              agent: "main", shell: "zsh" },
  "rescue-erin-garrett":                { sshAlias: "rescue-erin-garrett",                agent: "main", shell: "zsh" },
  "rescue-star-bobatoon":               { sshAlias: "rescue-star-bobatoon",               agent: "main", shell: "zsh" },
  "rescue-barrett-matthews-mini-2026":  { sshAlias: "rescue-barrett-matthews-mini-2026",  agent: "main", shell: "zsh" },
  // rescue-jennifer-allen is the Mac mini CF tunnel (accounts.md §29, active).
  // The retired item was the Contabo oc-jennifer-allen container only.
  "rescue-jennifer-allen":              { sshAlias: "rescue-jennifer-allen",              agent: "main", shell: "zsh" },

  // ---- VPS / Docker-exec clients (wired; UNTESTED 2026-06-26) ----
  // sshKey null = use default ~/.ssh/id_ed25519 for all plain root@IP targets.
  // contabo-host alias already carries ~/.ssh/contabo_host_ed25519 via SSH config.
  "vps-corey": {
    type: "vps", sshHost: "root@187.77.204.227", sshKey: null,
    container: "openclaw-hy5t-openclaw-1", agent: "main", verified: false,
    _note: "Corey Sams / Candace; Hostinger (Trevor acct); UNTESTED 2026-06-26",
  },
  "vps-maria-anderson": {
    type: "vps", sshHost: "root@187.77.10.144", sshKey: null,
    container: "openclaw-qxqt-openclaw-1", agent: "main", verified: false,
    _note: "Maria Anderson VPS / Sir Jordan; separate from her Mac mini rescue-maria-anderson; UNTESTED 2026-06-26",
  },
  "vps-beverly-sanders": {
    type: "vps", sshHost: "root@72.62.170.43", sshKey: null,
    container: "openclaw-0ht9-openclaw-1", agent: "main", verified: false,
    _note: "Beverly Sanders / Benjamin; Hostinger (Trevor acct); UNTESTED 2026-06-26",
  },
  "vps-evelyn-bethune": {
    type: "vps", sshHost: "root@2.24.85.21", sshKey: null,
    container: "openclaw-c54p-openclaw-1", agent: "main", verified: false,
    _note: "Evelyn Bethune / Temperance; Hostinger (Trevor acct); UNTESTED 2026-06-26",
  },
  "vps-angela-t": {
    type: "vps", sshHost: "root@187.77.9.130", sshKey: null,
    container: "openclaw-prji-openclaw-1", agent: "main", verified: false,
    _note: "Angela Tennison / DoraMilaje; Hostinger (Trevor acct); UNTESTED 2026-06-26",
  },
  "vps-angeleen": {
    type: "vps", sshHost: "root@187.77.223.62", sshKey: null,
    container: "openclaw-lydh-openclaw-1", agent: "main", verified: false,
    _note: "Angeleen / Ava; Hostinger (Trevor acct); UNTESTED 2026-06-26",
  },
  "vps-monique-tucker": {
    type: "vps", sshHost: "root@177.7.42.223", sshKey: null,
    container: "openclaw-jdbv-openclaw-1", agent: "main", verified: false,
    _note: "Monique Tucker / Lia; Hostinger (Trevor acct); UNTESTED 2026-06-26",
  },
  "vps-lyric-hawkins": {
    type: "vps", sshHost: "root@187.127.251.97", sshKey: null,
    container: "openclaw-4pkz-openclaw-1", agent: "main", verified: false,
    _note: "Lyric Hawkins VPS; her own Hostinger acct; UNTESTED 2026-06-26",
  },
  "vps-dr-tola": {
    type: "vps", sshHost: "root@2.25.167.145", sshKey: null,
    container: "openclaw-h7rp-openclaw-1", agent: "main", verified: false,
    _note: "Dr. Tola; her own Hostinger acct; UNTESTED 2026-06-26",
  },
  "vps-beverly-grandison": {
    // Contabo multi-client host. The "contabo-host" SSH alias in ~/.ssh/config
    // already specifies the contabo_host_ed25519 key -- sshKey stays null.
    type: "vps", sshHost: "contabo-host", sshKey: null,
    container: "oc-beverly-grandison", agent: "main", verified: false,
    _note: "Beverly Grandison / Premier Health; Contabo 109.205.179.254; UNTESTED 2026-06-26",
  },
};

// ---------------------------------------------------------------------------
// FIX-RESCUE-09: return-leg verification gate.
//   - Mac-tunnel entries (no `type`) are the PROVEN return path (2026-06-26) and
//     are always considered verified.
//   - `type:"vps"` entries default to verified:false and stay SSH-blocked until a
//     per-box loopback smoke test passes and is recorded in RETURN_VERIFIED_STORE
//     (see recordBoxVerified / the `--smoke-test` CLI below).
// A box is verified when EITHER the allowlist entry has verified:true OR the
// durable store records a passing smoke test for it.
// ---------------------------------------------------------------------------
function loadVerifiedStore() {
  try {
    if (!existsSync(RETURN_VERIFIED_STORE)) return {};
    const raw = readFileSync(RETURN_VERIFIED_STORE, "utf8");
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) {
    return {};
  }
}

function isBoxVerified(box) {
  const entry = RETURN_BOX_ALLOWLIST[box];
  if (!entry) return false;
  // Non-VPS (Mac-tunnel) entries are the proven path -> always verified.
  if (entry.type !== "vps") return true;
  if (entry.verified === true) return true;
  const store = loadVerifiedStore();
  return !!(store[box] && store[box].verified === true);
}

function recordBoxVerified(box, ok, detail) {
  try {
    mkdirSync(path.dirname(RETURN_VERIFIED_STORE), { recursive: true });
    const store = loadVerifiedStore();
    store[box] = { verified: !!ok, ts: new Date().toISOString(), detail: (detail || "").slice(0, 200) };
    writeFileSync(RETURN_VERIFIED_STORE, JSON.stringify(store, null, 2) + "\n");
  } catch (e) {
    log(`SMOKE-TEST record failed box=${box} err=${e && e.message}`);
  }
}

// Pure builder for the return-leg delivery command (no side effects -> unit-testable).
// Returns a descriptor or null if the box is not in the allowlist.
//
// Mac-tunnel path (no type field):
//   Returns { sshAlias, shell, agent, sshArgs, sshRemoteArg }
//   Command: ssh -T <alias> "<shell> -lc 'decode + openclaw agent...'"
//   Fixes: "needs interactive TTY" (ssh -T), "command not found" (explicit PATH),
//          "wrong agent/shell" (per-box agent id + login shell from allowlist).
//
// VPS / Docker-exec path (type: "vps"):
//   Returns { type:"vps", sshHost, container, agent, sshArgs }
//   Command: ssh -T [-i key] root@IP
//              "docker exec -u node -e PATH=... CONTAINER sh -c 'decode + openclaw...'"
//   The b64-encoded message is set as the OCLB64 env var via docker exec -e so
//   no shell quoting of the message content crosses the SSH boundary.
//   UNTESTED on live containers (wired 2026-06-26; verify per-box before relying on it).
//
// In both cases the message is base64-encoded so its content never needs quoting.
function buildDeliverCommand(box, agent, deliverText) {
  const allowed = RETURN_BOX_ALLOWLIST[box];
  if (!allowed) return null;

  const safeAgent =
    ((allowed.agent || agent || "main").replace(/[^a-zA-Z0-9_-]/g, "")) || "main";
  const b64 = Buffer.from(deliverText, "utf8").toString("base64");

  // ---- VPS / Docker-exec path ----
  if (allowed.type === "vps") {
    // PATH inside the container: prefer /data/.npm-global/bin (in-volume install),
    // fall back to /usr/local/bin symlink if present.
    const containerPath = "/data/.npm-global/bin:/usr/local/bin:/usr/bin:/bin";
    // Inner sh -c command runs inside the container.
    // OCLB64 is injected as an env var by docker exec -e so no shell-quoting needed.
    // Double-quotes around $OCLB64 protect spaces if any; base64 chars are safe regardless.
    const innerShCmd = "MSG=$(echo \"$OCLB64\" | base64 -d) && openclaw agent --agent " + safeAgent + " --message \"$MSG\" --json";
    // Outer command sent to the SSH remote shell (the VPS host root shell).
    // Single-quoted sh -c argument: the outer shell passes it literally to sh.
    const dockerCmd = "docker exec -u node -e 'PATH=" + containerPath + "' -e 'OCLB64=" + b64 + "' " + allowed.container + " sh -c '" + innerShCmd + "'";
    // Build SSH args. Explicit key only when sshKey is specified; for aliases
    // (contabo-host) the SSH config carries the IdentityFile automatically.
    const sshKey = allowed.sshKey;
    const sshArgs = sshKey
      ? ["-T", "-i", sshKey, allowed.sshHost, dockerCmd]
      : ["-T", allowed.sshHost, dockerCmd];
    return { type: "vps", sshHost: allowed.sshHost, container: allowed.container, agent: safeAgent, sshArgs };
  }

  // ---- Mac-tunnel path (default) ----
  const sshAlias = allowed.sshAlias;
  const shell = allowed.shell === "bash" ? "bash" : "zsh";
  // Explicit PATH so `openclaw` resolves regardless of login-shell config.
  const pathPrefix =
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH";';
  const innerCmd =
    pathPrefix + " MSG=$(echo " + b64 + " | base64 -d) && openclaw agent --agent " + safeAgent + " --message \"$MSG\" --json";
  // Single SSH argument: "<shell> -lc '<innerCmd>'"; innerCmd contains no single-quotes.
  const sshRemoteArg = shell + " -lc '" + innerCmd + "'";
  // -T disables pseudo-terminal allocation (the remote agent refuses interactive TTY).
  const sshArgs = ["-T", sshAlias, sshRemoteArg];
  return { sshAlias, shell, agent: safeAgent, sshArgs, sshRemoteArg };
}

// Fire-and-forget SSH delivery to a client box agent.
// Responds 202 before spawning; errors are logged, never thrown.
function deliverToClientBox(box, agent, deliverText, ticketId) {
  const cmd = buildDeliverCommand(box, agent, deliverText);
  if (!cmd) {
    log(`RETURN deliverToClientBox REJECTED box=${box} not in allowlist ticket=${ticketId}`);
    return;
  }
  const deliverTarget = cmd.type === "vps"
    ? ("vps host=" + cmd.sshHost + " container=" + cmd.container)
    : ("alias=" + cmd.sshAlias + " shell=" + cmd.shell);
  log("RETURN SSH deliver box=" + box + " " + deliverTarget + " agent=" + cmd.agent + " ticket=" + ticketId + " text_len=" + deliverText.length);
  let child;
  try {
    child = spawn("ssh", cmd.sshArgs, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    log(`RETURN SSH spawn failed box=${box} ticket=${ticketId} err=${e.message}`);
    return;
  }
  const wall = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch (_) {}
    log(`RETURN SSH timeout box=${box} ticket=${ticketId}`);
  }, 600000); // 10 min wall
  let outBuf = "";
  let errBuf = "";
  child.stdout.on("data", (b) => (outBuf += b.toString()));
  child.stderr.on("data", (b) => (errBuf += b.toString()));
  child.on("error", (e) => {
    clearTimeout(wall);
    log(`RETURN SSH child error box=${box} ticket=${ticketId} err=${e.message}`);
  });
  child.on("close", (code) => {
    clearTimeout(wall);
    log(`RETURN SSH done box=${box} ticket=${ticketId} exitCode=${code} stderr=${errBuf.slice(-200)}`);
  });
}

// ---------------------------------------------------------------------------
// DEDUP FIX (P0 part e): in-process Set to prevent the receiver from posting
// the same answer twice within the same process lifetime. Covers the race where
// the same ticket is submitted to the receiver more than once before the first
// run completes (e.g. the n8n retry fires a second push before the first
// async answer posts back). Does NOT cover receiver-vs-poller races, but those
// are mitigated by n8n marking the ticket "answered" after the first post.
// ---------------------------------------------------------------------------
const _answeredTickets = new Set();

// Close-once guard. Returns true if THIS caller wins the right to close/answer
// the ticket (and records it); false if it was already closed by another path
// (success, a failure page, or the queue backstop). Empty ticketId cannot be
// deduped, so it always wins (such jobs are rare loopback/sync probes).
function claimTicket(ticketId) {
  if (!ticketId) return true;
  if (_answeredTickets.has(ticketId)) return false;
  _answeredTickets.add(ticketId);
  return true;
}

// ---------------------------------------------------------------------------
// RR #4: SERIAL FIXER QUEUE. Heavy async jobs run ONE AT A TIME so a slow ticket
// cannot collide with the next agent run. The HTTP request is already answered
// 202 before a job is enqueued, so n8n is never blocked by the queue depth.
// Each job is wrapped in a hard QUEUE_JOB_TIMEOUT wall: if it exceeds the cap the
// queue ADVANCES to the next ticket (so one stuck job cannot block the rest) and
// a human is paged. The stuck job's own terminal paths are no-ops afterward
// because the backstop already claimed the ticket.
// ---------------------------------------------------------------------------
const _jobQueue = [];
let _queueBusy = false;

function enqueueFixJob(jobFn, meta) {
  _jobQueue.push({ jobFn, meta: meta || {} });
  log(`QUEUE enqueue ticket=${(meta && meta.ticketId) || "(none)"} depth=${_jobQueue.length} busy=${_queueBusy}`);
  _drainQueue();
}

async function handleQueueTimeout(meta) {
  const ticketId = (meta && meta.ticketId) || "";
  const extras = (meta && meta.extras) || {};
  // FIX-RESCUE-05: report the ACTUAL per-job cap that fired, not the global.
  const cap = (meta && meta.queueTimeoutSecs) || QUEUE_JOB_TIMEOUT;
  // If the job already closed the ticket on its own, just log; do not double-post.
  if (!claimTicket(ticketId)) {
    log(`QUEUE HARD CAP ticket=${ticketId} fired but ticket already closed; page suppressed`);
    return;
  }
  log(`QUEUE HARD CAP ticket=${ticketId} exceeded ${cap}s -- advancing queue + paging human`);
  const grpText =
    `[RR QUEUE TIMEOUT] fixer job exceeded ${cap}s hard cap -- ticket=${ticketId} -- job abandoned so the queue can move on; human needed.`;
  const gr = await postTelegramAlarm(grpText, FIXER_GROUP_CHAT_ID, FIXER_THREAD_ID);
  log(`QUEUE TIMEOUT alarm Fixer-topic ok=${gr.ok}`);
  const dmText = `[RR QUEUE TIMEOUT] ticket=${ticketId} stuck >${cap}s -- fixer job abandoned; check the agent.`;
  const dr = await postTelegramAlarm(dmText, TREVOR_CHAT_ID, null);
  log(`QUEUE TIMEOUT alarm Trevor DM ok=${dr.ok}`);
  await postAnswerBack(ticketId, `IN PROGRESS -- fixer job exceeded ${cap}s hard cap and was abandoned. Human action needed.`, {
    ...extras,
    fixMode: "escalate-human",
    statusPrefix: "in progress:",
    decisionMode: "HUMAN_NEEDED",
    status: "IN_PROGRESS",
  });
}

async function _drainQueue() {
  if (_queueBusy) return;
  _queueBusy = true;
  try {
    while (_jobQueue.length) {
      const { jobFn, meta } = _jobQueue.shift();
      const started = Date.now();
      // FIX-RESCUE-05: per-job cap (tier wall + slack), falling back to the
      // global default for callers that do not set one.
      const jobCap = meta.queueTimeoutSecs || QUEUE_JOB_TIMEOUT;
      log(`QUEUE start ticket=${meta.ticketId || "(none)"} remaining=${_jobQueue.length} cap=${jobCap}s`);
      let timer;
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => resolve("__QUEUE_TIMEOUT__"), jobCap * 1000);
      });
      let outcome;
      try {
        // Race the job against the hard cap. If the cap wins we move on; the job
        // keeps running detached but its terminal post is suppressed by claimTicket.
        outcome = await Promise.race([
          Promise.resolve().then(() => jobFn()).then(() => "__DONE__", (e) => { log(`QUEUE job error ticket=${meta.ticketId || "(none)"} err=${e && e.message}`); return "__DONE__"; }),
          guard,
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (outcome === "__QUEUE_TIMEOUT__") {
        await handleQueueTimeout(meta);
      }
      log(`QUEUE done ticket=${meta.ticketId || "(none)"} outcome=${outcome} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  } finally {
    _queueBusy = false;
  }
}

const server = http.createServer((req, res) => {
  // Health check (no secret needed, no agent run). Lets n8n / monitors verify reachability.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    return send(res, 200, { ok: true, service: "rescue-receiver", agent: AGENT_ID });
  }

  // -------------------------------------------------------------------------
  // RETURN-LEG: POST /rescue-return
  // Called by n8n "Deliver to Client Agent" node with the rescue answer.
  // Delivers the answer to the originating client's own agent via SSH so
  // HER agent tells HER client through HER own bot. Never touches api.telegram.org
  // or Trevor's chat directly.
  // Body: {deliverTo:{box,agent}, client, ticketId, statusPrefix, deliverText}
  // Header: X-Rescue-Secret (same secret as /rescue)
  // -------------------------------------------------------------------------
  if (req.method === "POST" && req.url.split("?")[0] === "/rescue-return") {
    const provided = req.headers["x-rescue-secret"];
    if (!secretOk(provided)) {
      log(`RETURN 401 rejected from ${req.socket.remoteAddress} (bad/missing secret)`);
      return send(res, 401, { error: "unauthorized" });
    }
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) return send(res, 413, { error: "payload too large" });
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch (_) {
        return send(res, 400, { error: "invalid json" });
      }
      const deliverTo  = parsed.deliverTo || {};
      const box        = (deliverTo.box   || "").toString().trim();
      const agent      = (deliverTo.agent || "main").toString().trim();
      const ticketId   = (parsed.ticketId   || "").toString();
      const statusPfx  = (parsed.statusPrefix || "answer:").toString();
      const deliverText = (parsed.deliverText || "").toString().trim();

      if (!box) {
        return send(res, 400, { error: "missing deliverTo.box" });
      }
      if (!RETURN_BOX_ALLOWLIST[box]) {
        log(`RETURN 403 box not allowlisted box=${box} ticket=${ticketId}`);
        return send(res, 403, { error: "box not allowlisted" });
      }
      if (!deliverText) {
        return send(res, 400, { error: "missing deliverText" });
      }

      // Compose final text: statusPrefix + space + answer (unless already prefixed)
      const finalText = deliverText.startsWith(statusPfx)
        ? deliverText
        : `${statusPfx} ${deliverText}`;

      // FIX-RESCUE-09: gate the direct SSH/docker-exec return leg behind per-box
      // verification. An unverified `type:"vps"` box must NEVER receive a live
      // SSH -- the blast radius (mistarget / commingling) is unacceptable while
      // "UNTESTED". Fall back to the Telegram-group post the relay already made.
      const entry = RETURN_BOX_ALLOWLIST[box];
      if (entry && entry.type === "vps" && !isBoxVerified(box)) {
        log(`RETURN 202 telegram-only box=${box} ticket=${ticketId} reason=vps-unverified (SSH suppressed until smoke test passes)`);
        return send(res, 202, { ok: true, box, agent, ticketId, status: "accepted", delivery: "telegram-only", reason: "vps-unverified" });
      }
      log(`RETURN 202 accepted box=${box} agent=${agent} ticket=${ticketId} statusPrefix=${statusPfx} text_len=${finalText.length} delivery=ssh`);
      send(res, 202, { ok: true, box, agent, ticketId, status: "accepted", delivery: "ssh" });
      // Fire-and-forget: SSH into the client box and run openclaw agent turn.
      deliverToClientBox(box, agent, finalText, ticketId);
    });
    return;
  }

  if (req.method !== "POST" || req.url.split("?")[0] !== "/rescue") {
    return send(res, 404, { error: "not found" });
  }

  // Secret gate FIRST, before reading/processing body.
  const provided = req.headers["x-rescue-secret"];
  if (!secretOk(provided)) {
    log(`401 rejected from ${req.socket.remoteAddress} (bad/missing secret)`);
    return send(res, 401, { error: "unauthorized" });
  }

  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooBig) return send(res, 413, { error: "payload too large" });
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch (_) {
      return send(res, 400, { error: "invalid json" });
    }
    // P0c: strip markdown from incoming problem text before passing to agent.
    const message = stripMarkdown((parsed.message || "").toString());
    const ticketId = (parsed.ticketId || "").toString();
    if (!message.trim()) {
      return send(res, 400, { error: "missing message" });
    }

    // ASYNC PUSH PATH (used by the n8n real-time trigger):
    // Respond 202 IMMEDIATELY so the n8n HTTP call returns fast, then classify
    // the ticket tier (zero tokens) and run the appropriately-sized agent
    // detached. HARD tickets use DeepSeek v4 pro at thinking:high (30-90s).
    // STRUCTURED/LIGHT tickets use the light model at thinking:low (<15s).
    // When it finishes, the receiver posts the answer back to n8n (action="answer")
    // which posts it into the Telegram group thread and closes the ticket.
    if (parsed.async === true || parsed.async === "true") {
      const agentOpts = classifyTier(message);
      // P1 FIX-MODE: classify action mode independently of the model-tier classifier.
      const fixMode = classifyFixMode(message);
      // Carry return-leg routing fields from the inbound body (additive, optional).
      const returnExtras = {
        client:   (parsed.client   || "").toString().slice(0, 80),
        agent:    (parsed.agent    || "").toString().slice(0, 80),
        returnTo: parsed.returnTo || null,
      };
      // RR #5: optional structured-fix context forwarded by the relay (box id etc.).
      const remediateCtx = (parsed.remediate && typeof parsed.remediate === "object") ? parsed.remediate : null;
      log(`202 accepted (async) ticket=${ticketId || "(none)"} tier=${agentOpts.tier} reason=${agentOpts.reason} mode=${fixMode.mode} len=${message.length}`);
      send(res, 202, {
        ticketId,
        status: "accepted",
        mode: "async",
        tier: agentOpts.tier,
        fixMode: fixMode.mode,
        decisionMode: decisionModeFromFixMode(fixMode.mode),
        ticketStatus: "OPEN",
      });
      // Enqueue through the SERIAL QUEUE (one heavy job at a time, hard-capped).
      // The 202 already returned, so n8n is not blocked by queue depth.
      // runAgentAndReport handles/logs all of its own errors internally.
      const queueExtras = {};
      if (returnExtras.client)   queueExtras.client   = returnExtras.client;
      if (returnExtras.agent)    queueExtras.agent    = returnExtras.agent;
      if (returnExtras.returnTo) queueExtras.returnTo = returnExtras.returnTo;
      // FIX-RESCUE-05: this job's queue cap is the tier's agent wall + 30s of
      // slack (= timeoutSecs+60), strictly greater than the agent's own
      // timeoutSecs+30 SIGKILL wall, so the agent times out and posts its own
      // "IN PROGRESS -- human needed" BEFORE the queue backstop ever fires.
      const jobQueueTimeout = (agentOpts.timeoutSecs || AGENT_TIMEOUT) + 60;
      enqueueFixJob(
        () => runAgentAndReport(message, ticketId, agentOpts, fixMode, returnExtras, remediateCtx),
        { ticketId, extras: queueExtras, queueTimeoutSecs: jobQueueTimeout }
      );
      return;
    }

    // SYNCHRONOUS PATH (used by the poller fallback): classify tier, then run + return reply.
    const syncOpts = classifyTier(message);
    // P1 FIX-MODE: classify action mode for the synchronous path too (returned in the response).
    const syncFixMode = classifyFixMode(message);
    log(`200 accepted ticket=${ticketId || "(none)"} tier=${syncOpts.tier} reason=${syncOpts.reason} mode=${syncFixMode.mode} len=${message.length}`);
    const { reply, error, code, stdoutTail, stderrTail } = await runAgent(message, syncOpts);
    if (error || !reply) {
      // Provider-named billing detection on the poller path too (this may be the
      // ONLY live path if the push tunnel is down), so credit exhaustion never
      // goes silent. Page Trevor + the Fixer topic when a billing signal is seen.
      const billing = detectBillingFailure(stdoutTail || "", stderrTail || "");
      if (billing) {
        log(`SYNC BILLING ALARM ticket=${ticketId} provider=${billing.provider} signal=${billing.signal}`);
        postTelegramAlarm(
          `[BILLING ALARM] ${billing.message}\nProvider: ${billing.provider}\nSignal: ${billing.signal}\nticket=${ticketId} (poller path) -- top up ${billing.provider} or switch model.`,
          FIXER_GROUP_CHAT_ID, FIXER_THREAD_ID
        );
        postTelegramAlarm(
          `[RR BILLING ALARM] ${billing.message} | ticket=${ticketId} (poller path) -- fixer cannot answer until ${billing.provider} is topped up.`,
          TREVOR_CHAT_ID, null
        );
      }
      log(
        `agent EMPTY/ERROR ticket=${ticketId} code=${code} err=${
          error || ""
        } stderr=${stderrTail || ""}${billing ? ` billing=${billing.provider}/${billing.signal}` : ""}`
      );
      return send(res, 502, {
        ticketId,
        reply: "",
        status: "agent_empty",
        detail: billing ? billing.message : (error || "agent returned no text"),
        // CONTRACT: even on the failure path the lifecycle is explicit -> human.
        decisionMode: "HUMAN_NEEDED",
        ticketStatus: "IN_PROGRESS",
      });
    }
    log(`reply ticket=${ticketId} chars=${reply.length} mode=${syncFixMode.mode}`);
    return send(res, 200, {
      ticketId,
      reply,
      status: "ok", // receiver request-handling status (distinct from ticketStatus)
      fixMode: syncFixMode.mode,
      statusPrefix: statusPrefixFromMode(syncFixMode.mode),
      // CONTRACT: decision + ticket lifecycle status carried on the sync path too.
      decisionMode: decisionModeFromFixMode(syncFixMode.mode),
      ticketStatus: statusFromFixMode(syncFixMode.mode),
    });
  });
});

server.on("error", (e) => {
  log(`server error: ${e.message}`);
  process.exit(1);
});

// RESCUE_RECEIVER_NO_LISTEN=1 lets a test process import this module to exercise
// the pure helpers (stripMarkdown, buildDeliverCommand, RETURN_BOX_ALLOWLIST)
// WITHOUT binding the port the live launchd service already owns. Production
// runs never set it, so behavior is unchanged.
// ---------------------------------------------------------------------------
// FIX-RESCUE-09: per-box return-leg SMOKE TEST CLI.
//   node rescue-receiver.mjs --smoke-test <box>
// Runs a no-op loopback `openclaw agent --message "ping"` over the EXACT
// allowlist entry (same ssh/docker-exec path the live return leg would use). On
// exit 0 it records the box as verified in RETURN_VERIFIED_STORE, enabling the
// direct SSH return leg for it. On any failure it records verified:false so the
// box stays Telegram-only. Never runs during normal service startup.
// ---------------------------------------------------------------------------
const _smokeIdx = process.argv.indexOf("--smoke-test");
if (_smokeIdx !== -1) {
  const box = (process.argv[_smokeIdx + 1] || "").trim();
  if (!box) {
    console.error("usage: node rescue-receiver.mjs --smoke-test <box>");
    process.exit(2);
  }
  if (!RETURN_BOX_ALLOWLIST[box]) {
    console.error(`smoke-test: box "${box}" is not in RETURN_BOX_ALLOWLIST`);
    process.exit(2);
  }
  const cmd = buildDeliverCommand(box, "main", "ping");
  if (!cmd) {
    console.error(`smoke-test: could not build deliver command for box "${box}"`);
    process.exit(2);
  }
  const target = cmd.type === "vps"
    ? `vps host=${cmd.sshHost} container=${cmd.container}`
    : `alias=${cmd.sshAlias} shell=${cmd.shell}`;
  console.error(`smoke-test: ${box} (${target}) -- running loopback ping over the return leg...`);
  const child = spawn("ssh", cmd.sshArgs, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let errBuf = "";
  child.stderr.on("data", (b) => (errBuf += b.toString()));
  const wall = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 30000);
  child.on("error", (e) => {
    clearTimeout(wall);
    recordBoxVerified(box, false, `spawn error: ${e.message}`);
    console.error(`smoke-test FAIL box=${box} spawn error: ${e.message}`);
    process.exit(1);
  });
  child.on("close", (code) => {
    clearTimeout(wall);
    const ok = code === 0;
    recordBoxVerified(box, ok, ok ? "ping ok" : `exit=${code} stderr=${errBuf.slice(-160)}`);
    console.error(`smoke-test ${ok ? "PASS" : "FAIL"} box=${box} exit=${code}${ok ? "" : " stderr=" + errBuf.slice(-160)}`);
    process.exit(ok ? 0 : 1);
  });
} else {

const NO_LISTEN = process.env.RESCUE_RECEIVER_NO_LISTEN === "1";
if (!NO_LISTEN) {
  server.listen(PORT, HOST, () => {
    if (!SECRET) {
      log("FATAL: RESCUE_PUSH_SECRET not set in env; refusing all requests");
    }
    log(`listening on http://${HOST}:${PORT} agent=${AGENT_ID} bin=${OPENCLAW_BIN}`);
  });
}
} // end else (not --smoke-test)

export {
  stripMarkdown,
  classifyTier,
  isBoxVerified,
  loadVerifiedStore,
  recordBoxVerified,
  classifyFixMode,
  statusPrefixFromMode,
  decisionModeFromFixMode,
  statusFromFixMode,
  detectProvider,
  detectBillingFailure,
  buildDeliverCommand,
  RETURN_BOX_ALLOWLIST,
  remediateClassFromMessage,
  remediateArgsFromCtx,
  parseRemediateResult,
  runRemediatePlan,
  formatRemediateSummary,
};
