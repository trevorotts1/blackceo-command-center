/**
 * Item 19 (FIX-PLAN) — board visibility, real render proof.
 *
 *   1. ABANDONED renders distinctly on the card: its own pill + panel,
 *      never confused with Blocked (a failure being retried) or Parked
 *      (a wait that can resume), and it carries no resume action.
 *   2. A parked card shows the plain-words park record (label, waiting
 *      on, needed, since) — the Item 10 record's words, rendered.
 *   3. The resume action round-trips: the server's acceptance text and
 *      the server's refusal text are what render, verbatim; the panel
 *      itself never invents a status.
 *   4. The board's Abandoned filter shows ONLY engine-ABANDONED runs
 *      (which sit in the review column under their posted status).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
(global as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const { m } = vi.hoisted(() => ({ m: vi.fn() }));
vi.mock("@/lib/store", () => ({ useMissionControl: (sel: any) => { const st = m(); return sel ? sel(st) : st; } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import {
  PresentationEnginePanel,
  type EngineParkView,
} from "../../src/components/kanban/PresentationEnginePanel";
import { MissionQueue } from "../../src/components/MissionQueue";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PARK: EngineParkView = {
  label: "Waiting for you",
  waiting_on: "client",
  needed: "Connect the GoHighLevel account so the sales page can be installed",
  phase: "P-U-GHL-SALES",
  since: "2026-10-01T10:00:00.000Z",
  park_class: "client_action",
  auto_resume: false,
  attempts_used: null,
  attempts_cap: null,
  source: "park_status",
};

describe("Item 19 — the engine panel on the card face", () => {
  it("ABANDONED renders as its own terminal panel with no resume action", () => {
    render(<PresentationEnginePanel taskId="t1" park={null} terminal="ABANDONED" />);
    const panel = screen.getByTestId("presentation-engine-abandoned");
    expect(panel.textContent).toMatch(/ABANDONED/);
    expect(panel.textContent).toMatch(/not parked/i);
    expect(screen.queryByTestId("presentation-resume-btn")).toBeNull();
    expect(screen.queryByTestId("presentation-park-panel")).toBeNull();
  });

  it("a parked card shows the plain-words record: label, waiting on, needed, since", () => {
    render(<PresentationEnginePanel taskId="t2" park={PARK} terminal="BLOCKED" />);
    expect(screen.getByTestId("presentation-park-label").textContent).toBe("Waiting for you");
    expect(screen.getByTestId("presentation-park-waiting-on").textContent).toMatch(/the client/);
    expect(screen.getByTestId("presentation-park-needed").textContent).toMatch(/GoHighLevel account/);
    expect(screen.getByTestId("presentation-park-phase").textContent).toMatch(/P-U-GHL-SALES/);
    expect(screen.getByTestId("presentation-park-since").textContent).toMatch(/Since/);
    expect(screen.getByTestId("presentation-park-no-auto-resume")).toBeTruthy();
  });

  it("resume success renders the server's own outcome text and asks for a refetch", async () => {
    const onAfterResume = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        resumed: true,
        detail: "The engine consumed the resume; the park is cleared in the engine state.",
      }),
    })));
    render(
      <PresentationEnginePanel taskId="t3" park={PARK} terminal="BLOCKED" onAfterResume={onAfterResume} />,
    );
    fireEvent.click(screen.getByTestId("presentation-resume-btn"));
    const msg = await screen.findByTestId("presentation-resume-message");
    expect(msg.getAttribute("data-kind")).toBe("resumed");
    expect(msg.textContent).toMatch(/park is cleared in the engine state/);
    expect(onAfterResume).toHaveBeenCalled();
  });

  it("resume refusal renders the refusal verbatim, never a success claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        resumed: false,
        code: "launcher_refused",
        error: "launcher: engine already running for this run (pid 9911)",
      }),
    })));
    render(<PresentationEnginePanel taskId="t4" park={PARK} terminal="BLOCKED" />);
    fireEvent.click(screen.getByTestId("presentation-resume-btn"));
    const msg = await screen.findByTestId("presentation-resume-message");
    expect(msg.getAttribute("data-kind")).toBe("refused");
    expect(msg.textContent).toMatch(/engine already running/);
    expect(msg.textContent).not.toMatch(/cleared|resumed the run/i);
  });

  it("nothing renders when the run is neither parked nor abandoned", () => {
    const { container } = render(
      <PresentationEnginePanel taskId="t5" park={null} terminal={null} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ── The board filter ────────────────────────────────────────────────────────

const st = (tasks: any[]) => ({
  tasks,
  isLoading: false,
  updateTaskStatus: vi.fn(),
  addEvent: vi.fn(),
  selectedDepartment: null,
  setSelectedDepartment: vi.fn(),
  selectedTaskIds: new Set(),
  toggleTaskSelection: vi.fn(),
  setSelectedTaskIds: vi.fn(),
  clearTaskSelection: vi.fn(),
  bulkUpdateTaskStatuses: vi.fn(),
  activityPulse: 0,
  lastActivityScope: null,
});

const task = (o: any) => ({
  id: "t1",
  title: "Deck",
  status: "in_progress",
  workspace_id: "w",
  department: "presentations",
  description: "",
  created_at: "2026-01-01",
  ...o,
});

function childrenPayload(id: string, title: string, engineTerminal: string | null) {
  return {
    parent: {
      id,
      title,
      status: "review",
      priority: "medium",
      department: "presentations",
      created_at: "2026-01-01",
      engine_terminal: engineTerminal,
      park_status: null,
    },
    children: [],
    aggregate: { total: 0, done: 0, in_progress: 0, not_started: 0, current_phase: "Intake" },
  };
}

describe("Item 19 — the Abandoned board filter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/presentations/children")) {
        const id = new URL(u, "http://localhost").searchParams.get("parent_id");
        const payload =
          id === "t-abandoned"
            ? childrenPayload(id, "Abandoned Deck", "ABANDONED")
            : childrenPayload(id ?? "t-normal", "Normal Deck", null);
        return { ok: true, status: 200, json: async () => payload };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ job_id: "x", terminal: false, current_phase: "Intake", phases: [] }),
      };
    }));
    m.mockReturnValue(st([
      task({ id: "t-normal", title: "Normal Deck", status: "in_progress", engine_terminal: null }),
      task({ id: "t-abandoned", title: "Abandoned Deck", status: "review", engine_terminal: "ABANDONED" }),
    ]));
  });

  it("the abandoned card carries the ABANDONED pill beside its posted status", async () => {
    render(<MissionQueue departmentFilter={null} />);
    expect(await screen.findByText("Abandoned Deck")).toBeTruthy();
    expect(await screen.findByTestId("engine-abandoned-pill")).toBeTruthy();
    expect(screen.getByText("Normal Deck")).toBeTruthy();
  });

  it("the Abandoned filter shows only the engine-ABANDONED run", async () => {
    render(<MissionQueue departmentFilter={null} />);
    expect(await screen.findByText("Normal Deck")).toBeTruthy();
    expect(await screen.findByText("Abandoned Deck")).toBeTruthy();

    // Scope to the filter bar: the card's own select checkbox also carries
    // the deck title ("Select "Abandoned Deck"") in its accessible name.
    const filterBar = document.querySelector('[data-walkthrough="filters"]') as HTMLElement;
    fireEvent.click(within(filterBar).getByRole("button", { name: /Abandoned/ }));

    await waitFor(() => {
      expect(screen.queryByText("Normal Deck")).toBeNull();
    });
    expect(screen.getByText("Abandoned Deck")).toBeTruthy();
  });
});
