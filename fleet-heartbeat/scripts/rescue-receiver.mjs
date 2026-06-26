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
import { appendFileSync } from "node:fs";
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

// Where the receiver posts the agent's answer back to (the SAME public n8n
// webhook the poller uses). On action="answer" the Relay Brain posts the reply
// into the Telegram group thread and closes the ticket. This is what makes the
// ASYNC push path self-complete without the poller.
const RELAY_URL =
  process.env.RESCUE_RELAY_URL ||
  "https://main.blackceoautomations.com/webhook/rescue-rangers";

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(LOG, line);
  } catch (_) {
    /* ignore log failures */
  }
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
//                     data-loss keyword. DeepSeek v4 pro at high thinking.
//
// HARD GUARDRAIL (RR4 TIER-3): destructive/credential keywords ALWAYS force
// hard — never downshifted, regardless of other matches.
//
// Furnace-safe: the classifier itself costs zero tokens. The light model runs
// only on provably simple tickets. The expensive path is gated to hard cases.
// ---------------------------------------------------------------------------
const LIGHT_MODEL = "google/gemini-3-flash-preview";
const HARD_THINKING = "high";
const LIGHT_THINKING = "low";

function classifyTier(message) {
  const m = (message || "").toLowerCase();

  // Hard guardrail: any destructive / credential / security / data-loss keyword
  // forces HARD regardless of anything else. Check first.
  const destructiveRe =
    /rm\s+-rf|docker\s+volume\s+rm|git\s+reset\s+--hard|force.push|drop\s+table|truncate|delete\s+(all|database)|wipe|credential|secret|api.?key|token|password|auth\s+fail|unauthorized|403|data.?loss|security/i;
  if (destructiveRe.test(message)) {
    return { tier: "hard", model: null, thinking: HARD_THINKING, reason: "destructive/credential guardrail" };
  }

  // STRUCTURED tier: matches remediate.sh's 4 known auto-fix failure classes.
  const structuredRe =
    /agents\.list|schema\s+validation|AgentsConfigError|InvalidAgentsList|container.*(exited|dead|created)|exited.*container|gateway.port.*(closed|not.listening)|connect\s+ECONNREFUSED.*18789/i;
  if (structuredRe.test(message)) {
    return { tier: "structured", model: LIGHT_MODEL, thinking: LIGHT_THINKING, reason: "matches remediate.sh class" };
  }

  // LIGHT tier: routing tests, synthetic probes, how-to, trivial ops questions.
  const lightRe =
    /\[routing\s+test\]|\[synthetic\]|\btest\s+ticket\b|^ack$/i;
  if (lightRe.test(message)) {
    return { tier: "light", model: LIGHT_MODEL, thinking: LIGHT_THINKING, reason: "routing test / synthetic / trivial" };
  }

  // Default: HARD.
  return { tier: "hard", model: null, thinking: HARD_THINKING, reason: "no simple match; default to deepseek/high" };
}

function runAgent(message, opts = {}) {
  const thinking = opts.thinking || HARD_THINKING;
  const model = opts.model || null;
  return new Promise((resolve) => {
    const args = [
      "agent",
      "--agent",
      AGENT_ID,
      "--message",
      message,
      "--json",
      "--timeout",
      String(AGENT_TIMEOUT),
      "--thinking",
      thinking,
    ];
    if (model) {
      args.push("--model", model);
    }
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(OPENCLAW_BIN, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ reply: "", error: `spawn failed: ${e.message}` });
    }
    // hard wall slightly beyond the agent's own timeout
    const wall = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }, (AGENT_TIMEOUT + 30) * 1000);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", (e) =>
      resolve({ reply: "", error: `child error: ${e.message}` })
    );
    child.on("close", (code) => {
      clearTimeout(wall);
      const reply = extractReply(out);
      resolve({ reply, code, stderrTail: err.slice(-300) });
    });
  });
}

// POST the agent's answer back to the n8n relay (action="answer"). n8n then
// posts it into the Telegram group thread and closes/answers the ticket. Used
// by the ASYNC push path so the flow self-completes without the poller.
function postAnswerBack(ticketId, answer) {
  return new Promise((resolve) => {
    let payload;
    try {
      payload = JSON.stringify({ action: "answer", ticketId, answer });
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

// Background worker for the ASYNC path: run the agent, then post the answer
// back to n8n. Errors are logged; never throws to the (already-responded) HTTP
// request. On empty/error the poller remains the fallback (ticket stays pending
// in n8n because we only post action="answer" on a real reply).
async function runAgentAndReport(message, ticketId, agentOpts = {}) {
  const started = Date.now();
  const { reply, error, code, stderrTail } = await runAgent(message, agentOpts);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (error || !reply) {
    log(
      `ASYNC agent EMPTY/ERROR ticket=${ticketId} elapsed=${elapsed}s code=${code} err=${
        error || ""
      } stderr=${stderrTail || ""} (ticket stays pending; poller fallback will retry)`
    );
    return;
  }
  log(`ASYNC reply ticket=${ticketId} chars=${reply.length} elapsed=${elapsed}s`);
  const back = await postAnswerBack(ticketId, reply);
  if (back.ok) {
    log(`ASYNC answer posted back ticket=${ticketId} relayStatus=${back.status}`);
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

const server = http.createServer((req, res) => {
  // Health check (no secret needed, no agent run). Lets n8n / monitors verify reachability.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    return send(res, 200, { ok: true, service: "rescue-receiver", agent: AGENT_ID });
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
    const message = (parsed.message || "").toString();
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
      log(`202 accepted (async) ticket=${ticketId || "(none)"} tier=${agentOpts.tier} reason=${agentOpts.reason} len=${message.length}`);
      send(res, 202, { ticketId, status: "accepted", mode: "async", tier: agentOpts.tier });
      // fire-and-forget; runAgentAndReport handles/logs all errors internally
      runAgentAndReport(message, ticketId, agentOpts);
      return;
    }

    // SYNCHRONOUS PATH (used by the poller fallback): classify tier, then run + return reply.
    const syncOpts = classifyTier(message);
    log(`200 accepted ticket=${ticketId || "(none)"} tier=${syncOpts.tier} reason=${syncOpts.reason} len=${message.length}`);
    const { reply, error, code, stderrTail } = await runAgent(message, syncOpts);
    if (error || !reply) {
      log(
        `agent EMPTY/ERROR ticket=${ticketId} code=${code} err=${
          error || ""
        } stderr=${stderrTail || ""}`
      );
      return send(res, 502, {
        ticketId,
        reply: "",
        status: "agent_empty",
        detail: error || "agent returned no text",
      });
    }
    log(`reply ticket=${ticketId} chars=${reply.length}`);
    return send(res, 200, { ticketId, reply, status: "ok" });
  });
});

server.on("error", (e) => {
  log(`server error: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (!SECRET) {
    log("FATAL: RESCUE_PUSH_SECRET not set in env; refusing all requests");
  }
  log(`listening on http://${HOST}:${PORT} agent=${AGENT_ID} bin=${OPENCLAW_BIN}`);
});
