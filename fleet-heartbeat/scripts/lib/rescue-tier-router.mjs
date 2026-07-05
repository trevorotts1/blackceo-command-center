// ---------------------------------------------------------------------------
// FIX-RESCUE-05 — rescue tier router (pure logic, zero client data).
//
// PROBLEM (master plan FIX-RESCUE-05, P2): default routing sent the MOST COMMON
// tickets (coach-client-agent / how-to) to the slowest/most expensive model —
// classifyTier defaulted tier:"hard" -> kimi-k2.6:cloud@high — which blew both the
// ~570s agent wall and the 600s queue cap and paged a human (live evidence: a
// ticket abandoned at 602.2s).
//
// FIX: a real MEDIUM tier — coach/how-to -> deepseek-v4-flash:cloud@low with a
// short (~210s) agent wall; per-tier agent walls (~180-240s) for the light-model
// tiers; and a per-job queue cap derived to sit STRICTLY ABOVE the tier's agent
// wall so the agent's OWN graceful timeout fires first instead of the brutal queue
// hard-cap.
//
// This module is the single source of truth for tier routing so it can be unit
// tested WITHOUT importing the receiver (which carries the client return-leg
// allowlist and therefore must never be pulled into a public repo). The receiver
// imports { classifyTier, deriveQueueTimeout, ...TIMEOUTS } from here.
//
// MODEL POLICY (binding 2026-07-01): ALL rescue tiers run on Ollama Cloud only.
// LIGHT + STRUCTURED + MEDIUM -> ollama/deepseek-v4-flash:cloud (cheap/fast).
// HARD -> model:null => agent primary (ollama/kimi-k2.6:cloud) @ high thinking.
// ---------------------------------------------------------------------------

const envInt = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return v > 0 ? v : fallback;
};

// Global agent wall (back-compat default; also the HARD-tier wall unless overridden).
export const AGENT_TIMEOUT = envInt("RESCUE_AGENT_TIMEOUT", 540);

// Per-tier agent walls (seconds). The light-model tiers finish fast, so they get
// short walls and never blow the queue cap. HARD keeps the long wall.
export const AGENT_TIMEOUT_LIGHT = envInt("RESCUE_AGENT_TIMEOUT_LIGHT", 180);
export const AGENT_TIMEOUT_STRUCTURED = envInt("RESCUE_AGENT_TIMEOUT_STRUCTURED", 200);
export const AGENT_TIMEOUT_MEDIUM = envInt("RESCUE_AGENT_TIMEOUT_MEDIUM", 210);
export const AGENT_TIMEOUT_HARD = envInt("RESCUE_AGENT_TIMEOUT_HARD", AGENT_TIMEOUT);

// The flat per-job queue cap fallback (also the floor for long fix-it-ourselves
// jobs, which run a real, possibly long, structured remediation).
export const QUEUE_JOB_TIMEOUT = envInt("RESCUE_QUEUE_JOB_TIMEOUT", 600);
// Seconds the per-job queue cap sits ABOVE the tier's agent wall (agentTimeout+30)
// for non-fix-it-ourselves jobs, so the agent times out first (graceful) instead
// of the queue hard-cap (brutal, pages a human).
export const QUEUE_MARGIN = envInt("RESCUE_QUEUE_MARGIN", 60);

// Seconds added to the agent's own --timeout to form the SIGKILL wall in runAgent.
export const AGENT_WALL_GRACE = 30;

export const LIGHT_MODEL = "ollama/deepseek-v4-flash:cloud";
export const STRUCTURED_MODEL = "ollama/deepseek-v4-flash:cloud";
export const MEDIUM_MODEL = "ollama/deepseek-v4-flash:cloud";
export const HARD_THINKING = "high";
export const LIGHT_THINKING = "low";
export const MEDIUM_THINKING = "low";

// Destructive/credential/security/data-loss guardrail: forces HARD (agent
// primary) regardless of anything else. Checked FIRST. Mirrors the receiver's
// classifyFixMode destructive guard intent.
const DESTRUCTIVE_RE =
  /rm\s+-rf|docker\s+volume\s+rm|git\s+reset\s+--hard|force.push|drop\s+table|truncate|delete\s+(all|database)|wipe|credential|secret|api.?key|token|password|auth\s+fail|unauthorized|403|data.?loss|security/i;

// STRUCTURED tier: matches remediate.sh's known auto-fix failure classes.
const STRUCTURED_RE =
  /agents\.list|schema\s+validation|AgentsConfigError|InvalidAgentsList|container.*(exited|dead|created)|exited.*container|gateway.port.*(closed|not.listening)|connect\s+ECONNREFUSED.*18789/i;

// LIGHT tier: routing tests, synthetic probes, trivial ops.
const LIGHT_RE = /\[routing\s+test\]|\[synthetic\]|\btest\s+ticket\b|^ack$/i;

// ---------------------------------------------------------------------------
// classifyTier — deterministic regex only, zero LLM tokens.
// Returns { tier, model, thinking, agentTimeout, reason }.
//   hard       -> destructive/credential guardrail. model:null (agent primary), high.
//   structured -> remediate.sh class. deepseek-v4-flash, low.
//   light      -> routing test / synthetic / trivial. deepseek-v4-flash, low.
//   medium     -> DEFAULT: coach-client-agent / how-to (the most common ticket).
//                 deepseek-v4-flash, low. (Was HARD — the FIX-RESCUE-05 bug.)
// ---------------------------------------------------------------------------
export function classifyTier(message) {
  const text = (message || "").toString();

  if (DESTRUCTIVE_RE.test(text)) {
    return { tier: "hard", model: null, thinking: HARD_THINKING, agentTimeout: AGENT_TIMEOUT_HARD, reason: "destructive/credential guardrail" };
  }
  if (STRUCTURED_RE.test(text)) {
    return { tier: "structured", model: STRUCTURED_MODEL, thinking: LIGHT_THINKING, agentTimeout: AGENT_TIMEOUT_STRUCTURED, reason: "matches remediate.sh class" };
  }
  if (LIGHT_RE.test(text)) {
    return { tier: "light", model: LIGHT_MODEL, thinking: LIGHT_THINKING, agentTimeout: AGENT_TIMEOUT_LIGHT, reason: "routing test / synthetic / trivial" };
  }
  // Default: MEDIUM — coach/how-to. FIX-RESCUE-05: was HARD (kimi@high) which blew
  // the agent + queue walls and paged a human on the common case.
  return { tier: "medium", model: MEDIUM_MODEL, thinking: MEDIUM_THINKING, agentTimeout: AGENT_TIMEOUT_MEDIUM, reason: "coach/how-to default -> medium (deepseek-v4-flash:cloud@low)" };
}

// The tier's SIGKILL agent wall = agentTimeout + AGENT_WALL_GRACE.
export function agentWallFor(agentOpts) {
  const t = parseInt(agentOpts && agentOpts.agentTimeout, 10);
  const base = t > 0 ? t : AGENT_TIMEOUT;
  return base + AGENT_WALL_GRACE;
}

// ---------------------------------------------------------------------------
// deriveQueueTimeout — the per-job serial-queue hard cap.
// INVARIANT (FIX-RESCUE-05): queue cap > agent wall, so the agent's own timeout
// fires first. For fix-it-ourselves jobs (which run a real, possibly long
// structured remediation) the flat QUEUE_JOB_TIMEOUT floor is preserved so a legit
// long fix is not abandoned early.
// ---------------------------------------------------------------------------
export function deriveQueueTimeout(agentOpts, fixMode, opts = {}) {
  const margin = parseInt(opts.queueMargin, 10) > 0 ? parseInt(opts.queueMargin, 10) : QUEUE_MARGIN;
  const floor = parseInt(opts.queueJobTimeout, 10) > 0 ? parseInt(opts.queueJobTimeout, 10) : QUEUE_JOB_TIMEOUT;
  const wall = agentWallFor(agentOpts);
  const mode = fixMode && fixMode.mode ? fixMode.mode : fixMode;
  if (mode === "fix-it-ourselves") {
    return Math.max(floor, wall + margin);
  }
  return wall + margin;
}
