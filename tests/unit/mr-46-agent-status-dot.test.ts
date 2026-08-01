/**
 * MR-46 (fix2) — unit test for `getAgentStatusDot`, the agent-status -> dot
 * color mapper rendered inside the Kanban agent pill.
 *
 * Haiku's MR-46 review shipped the fix as CORRECT but flagged two minor
 * defects; this test closes the first ("no unit test for getAgentStatusDot").
 * It locks the exact 5-color mapping against the agents.status CHECK enum
 * (migration 034: standby, working, busy, degraded, offline) and pins the
 * standby-blue fallback for `undefined`/unknown values so a future enum drift
 * or a stale/invalid status can't silently recolor the dot.
 *
 * Vitest-only: importing MissionQueue.tsx pulls in the React tree, so the
 * store + next/navigation mocks mirror mission-queue-board-states.test.tsx.
 * Run directly: npx vitest run tests/unit/mr-46-agent-status-dot.test.ts
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/store", () => ({
  useMissionControl: (sel: (s: unknown) => unknown) => (sel ? sel({}) : {}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { getAgentStatusDot } from "../../src/components/MissionQueue";

describe("MR-46 getAgentStatusDot", () => {
  it("maps each CHECK-enum status to its documented dot color", () => {
    expect(getAgentStatusDot("working")).toBe("bg-emerald-500");
    expect(getAgentStatusDot("busy")).toBe("bg-amber-500");
    expect(getAgentStatusDot("degraded")).toBe("bg-orange-500");
    expect(getAgentStatusDot("offline")).toBe("bg-gray-400");
    expect(getAgentStatusDot("standby")).toBe("bg-blue-400");
  });

  it("falls back to the standby-blue dot for undefined", () => {
    expect(getAgentStatusDot(undefined)).toBe("bg-blue-400");
  });

  it("falls back to the standby-blue dot for an unknown/stale status", () => {
    // 'active' is NOT in the agents.status enum (migration 034) — a stale or
    // mis-typed value must not crash or invent a color; it degrades to standby.
    expect(getAgentStatusDot("active")).toBe("bg-blue-400");
    expect(getAgentStatusDot("")).toBe("bg-blue-400");
  });

  it("returns a distinct color per real status (no two enum values collide)", () => {
    const colors = ["working", "busy", "degraded", "offline", "standby"].map((s) =>
      getAgentStatusDot(s),
    );
    expect(new Set(colors).size).toBe(colors.length);
  });
});
