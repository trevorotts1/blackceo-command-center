import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { needsAudienceAnswer } from "../../src/lib/board/audience-chip";
(global as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const { m } = vi.hoisted(() => ({ m: vi.fn() }));
vi.mock("@/lib/store", () => ({ useMissionControl: (sel: any) => { const st = m(); return sel ? sel(st) : st; } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { MissionQueue } from "../../src/components/MissionQueue";
const st = (tasks: any[]) => ({ tasks, isLoading: false, updateTaskStatus: vi.fn(), addEvent: vi.fn(), selectedDepartment: null, setSelectedDepartment: vi.fn(), selectedTaskIds: new Set(), toggleTaskSelection: vi.fn(), setSelectedTaskIds: vi.fn(), clearTaskSelection: vi.fn(), bulkUpdateTaskStatuses: vi.fn() });
const task = (o: any) => ({ id: "t1", title: "Email Trevor", status: "backlog", workspace_id: "w", description: "", created_at: "2026-01-01", ...o });
beforeEach(() => m.mockReturnValue(st([])));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("best guess chip", () => {
  it("shows (best guess) and counts as answered", () => {
    expect(needsAudienceAnswer({ blend_confirm_state: "pending", audience_source: "best_guess" })).toBe(false);
    m.mockReturnValue(st([task({ blend_confirm_state: "pending", audience_source: "best_guess", audience_label: "Coaches" })]));
    render(<MissionQueue departmentFilter={null} />);
    expect(screen.getByTestId("written-for-chip").textContent).toMatch(/Coaches \(best guess\)/);
  });
});

describe("answered audience never asks again", () => {
  it("needsAudienceAnswer: pending + answered source is false", () => {
    for (const s of ["task_named", "owner_default", "operator_confirmed"]) {
      expect(needsAudienceAnswer({ blend_confirm_state: "pending", audience_source: s })).toBe(false);
    }
    expect(needsAudienceAnswer({ blend_confirm_state: "pending", audience_source: null })).toBe(true);
    expect(needsAudienceAnswer({ blend_confirm_state: "confirmed", audience_source: null })).toBe(false);
  });
  it("answered + refresh pending: Written-for chip only, no chip, no banner", () => {
    m.mockReturnValue(st([task({ blend_confirm_state: "pending", audience_source: "task_named", audience_label: "Trevor Otts" })]));
    render(<MissionQueue departmentFilter={null} />);
    expect(screen.getByTestId("written-for-chip")).toBeTruthy();
    expect(screen.queryByText(/Needs your answer/)).toBeNull();
    expect(screen.queryByTestId("audience-ask-banner")).toBeNull();
  });
  it("unanswered pending still shows chip and banner", () => {
    m.mockReturnValue(st([task({ blend_confirm_state: "pending", audience_source: null })]));
    render(<MissionQueue departmentFilter={null} />);
    expect(screen.getByText(/Needs your answer/)).toBeTruthy();
    expect(screen.getByTestId("audience-ask-banner")).toBeTruthy();
  });
  it("operator-blocked and archived cards never reach the owner banner, and the banner never prints raw ask text", () => {
    m.mockReturnValue(st([
      task({ id: "op", title: "Op fault", blend_confirm_state: "pending", blocked_on_human: "operator", ask: "System fix required: dispatch-attempt cap" }),
      task({ id: "ar", title: "Old one", blend_confirm_state: "pending", archived_at: "2026-11-01T00:00:00Z" }),
      task({ id: "ok", title: "Real one", blend_confirm_state: "pending", ask: "SOP authoring failed 401 insufficient_quota" }),
    ]));
    render(<MissionQueue departmentFilter={null} />);
    const banner = screen.getByTestId("audience-ask-banner");
    expect(banner.textContent).toMatch(/1 task waiting for your answer/);
    expect(banner.textContent).toMatch(/Real one/);
    expect(banner.textContent).toMatch(/Who will be reading this\?/);
    expect(banner.textContent).not.toMatch(/Op fault|Old one|System fix|insufficient_quota/);
  });
});
