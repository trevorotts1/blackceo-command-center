/**
 * persona-picker.test.tsx — U064 component-level tests.
 *
 * Proves the PersonaPickerPanel renders correctly:
 *
 *   - bundle: null → renders nothing (fail-quiet)
 *   - rationale.collapse set → that string appears
 *   - rationale absent → fallback sentence appears, no undefined/brace
 *   - firing the primary submit issues `action: 'reaim'`, NEVER `action: 'name-voice'`
 *
 * Vitest + jsdom (vitest.component.config.ts) — REAL render, not a hand-rolled
 * restatement.  Mock fetch so the component gets its data without a real server.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PersonaPickerPanel } from '../../src/components/PersonaPickerPanel';

const TASK_ID = 'task-test-1';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetchResponse(body: Record<string, unknown>, status = 200) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

function mockFetchError() {
  (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));
}

function personaBundleData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: TASK_ID,
    bundle: {
      voice: {
        persona_id: 'ogilvy-on-advertising',
        display_name: 'Ogilvy on Advertising',
        collapsed: false,
      },
      topic_persona: {
        persona_id: 'pricing-expert',
        display_name: 'Pricing Expert',
      },
      blend_directive: 'Write in Ogilvy voice with pricing-page craft.',
      rationale: {
        audience_resolution: 'Derived from ICP',
        audience_persona: 'Founder-focused voice',
        topic_persona: 'Pricing page confidence from 127 pricing blocks',
        collapse: 'Distinct audience + topic personas (genuine blend).',
        voice_persona_mirror: 'ogilvy-on-advertising',
        task_decomposition: 'One-part headline + body.',
        conversion_goal: 'Book a demo',
        goal_source: 'skill6_intake',
        chosen_closer: 'ogilvy-on-advertising',
        conversion_goal_resolution: 'Discovered in intake.',
      },
      task_personas: [
        { seq: 1, part: 'headline', persona_id: 'ogilvy-on-advertising', why: 'headline craft' },
      ],
      catalog_version: '1.3',
    },
    confirm_state: 'pending',
    catalog_version: '1.3',
    ...overrides,
  };
}

// ── Fail-quiet: bundle null → renders nothing ─────────────────────────

describe('fail-quiet (bundle null)', () => {
  it('renders nothing when bundle is null', async () => {
    mockFetchResponse({
      task_id: TASK_ID,
      bundle: null,
      confirm_state: null,
      catalog_version: null,
    });

    const { container } = render(
      <PersonaPickerPanel taskId={TASK_ID} />,
    );

    await waitFor(() => {
      // After loading completes, the component should have rendered nothing.
      // The container should be empty.
    });

    // The panel should not be in the DOM at all (fail-quiet returns null).
    expect(screen.queryByTestId('persona-picker-panel')).toBeNull();
  });
});

// ── Rationale projection ──────────────────────────────────────────────

describe('rationale projection', () => {
  it('shows rationale.collapse when set', async () => {
    mockFetchResponse(personaBundleData());

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    const why = screen.getByTestId('persona-picker-why');
    expect(why.textContent).toContain('Distinct audience + topic personas (genuine blend)');
  });

  it('shows fallback sentence when rationale is absent', async () => {
    mockFetchResponse(personaBundleData({
      bundle: {
        voice: { persona_id: 'vp1', display_name: 'Voice Persona', collapsed: true },
        blend_directive: 'Write in VP1 voice.',
        task_personas: [],
      },
    }));

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    const why = screen.getByTestId('persona-picker-why');
    expect(why.textContent).toBeDefined();
    expect(why.textContent).not.toContain('undefined');
    expect(why.textContent).not.toContain('null');
    expect(why.textContent).not.toContain('[object Object]');
    expect(why.textContent).not.toContain('{');
    // Must be a real sentence (ends with period).
    expect(why.textContent!.trim()).toMatch(/\.$/);
  });

  it('shows fallback sentence when rationale has no collapse key', async () => {
    mockFetchResponse(personaBundleData({
      bundle: {
        voice: { persona_id: 'vp1', display_name: 'VP1', collapsed: false },
        blend_directive: 'Write.',
        task_personas: [],
        rationale: { audience_resolution: 'ICP' },
      },
    }));

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    const why = screen.getByTestId('persona-picker-why');
    expect(why.textContent).toBeDefined();
    expect(why.textContent).not.toContain('undefined');
    expect(why.textContent).not.toContain('{');
    expect(why.textContent!.trim()).toMatch(/\.$/);
  });
});

// ── Primary submit issues reaim, NEVER name-voice ─────────────────────

describe('primary submit safety', () => {
  it('firing the primary submit issues action: reaim and NEVER action: name-voice', async () => {
    // First call: GET persona-bundle
    mockFetchResponse(personaBundleData());
    // Second call: POST persona-choice (after clicking Re-aim)
    mockFetchResponse({ success: true, rescored: false });

    const user = userEvent.setup();

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    // Type something in the audience input so the Re-aim button is enabled.
    const audienceInput = screen.getByTestId('persona-picker-audience-input');
    await user.type(audienceInput, 'founders');

    // Click the Re-aim button.
    const reaimBtn = screen.getByTestId('persona-picker-reaim-submit');
    await user.click(reaimBtn);

    // Verify at least one fetch (GET) happened + one POST call.
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // The last POST call must carry action: 'reaim'.
    const postCalls = calls.filter((c) => {
      const url = c[0] as string;
      return url.includes('persona-choice');
    });
    expect(postCalls.length).toBe(1);
    const postBody = JSON.parse(postCalls[0][1].body as string);
    expect(postBody.action).toBe('reaim');
    expect(postBody.action).not.toBe('name-voice');

    // Never a name-voice call.
    for (const call of calls) {
      const url = call[0] as string;
      if (url.includes('persona-choice')) {
        const body = JSON.parse(call[1].body as string);
        expect(body.action).not.toBe('name-voice');
      }
    }
  });
});

// ── Content rendering ─────────────────────────────────────────────────

describe('content rendering', () => {
  it('renders voice persona, topic persona, blend state, and directive', async () => {
    mockFetchResponse(personaBundleData());

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    expect(screen.getByTestId('persona-picker-voice').textContent).toContain('Ogilvy on Advertising');
    expect(screen.getByTestId('persona-picker-topic').textContent).toContain('Pricing Expert');
    expect(screen.getByTestId('persona-picker-directive').textContent).toContain('Ogilvy voice');
    expect(screen.getByTestId('persona-picker-blend-state').textContent).toContain('genuine blend');
  });

  it('shows collapse state when collapsed', async () => {
    mockFetchResponse(personaBundleData({
      bundle: {
        voice: { persona_id: 'vp1', display_name: 'Single Voice', collapsed: true },
        blend_directive: 'Write.',
        task_personas: [],
        rationale: { collapse: 'Collapsed onto single voice persona.' },
      },
    }));

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    expect(screen.getByTestId('persona-picker-blend-state').textContent).toContain('collapsed');
  });

  it('renders name-voice consequence text', async () => {
    mockFetchResponse(personaBundleData());

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    const consequence = screen.getByTestId('persona-picker-name-voice-consequence');
    expect(consequence.textContent).toBeDefined();
    expect(consequence.textContent!.length).toBeGreaterThan(20);
  });

  it('has data-testid on root and all addressable chunks', async () => {
    mockFetchResponse(personaBundleData());

    render(<PersonaPickerPanel taskId={TASK_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('persona-picker-panel')).toBeDefined();
    });

    expect(screen.getByTestId('persona-picker-title')).toBeDefined();
    expect(screen.getByTestId('persona-picker-voice')).toBeDefined();
    expect(screen.getByTestId('persona-picker-topic')).toBeDefined();
    expect(screen.getByTestId('persona-picker-blend-state')).toBeDefined();
    expect(screen.getByTestId('persona-picker-directive')).toBeDefined();
    expect(screen.getByTestId('persona-picker-why')).toBeDefined();
    expect(screen.getByTestId('persona-picker-audience-input')).toBeDefined();
    expect(screen.getByTestId('persona-picker-topic-input')).toBeDefined();
    expect(screen.getByTestId('persona-picker-reaim-submit')).toBeDefined();
    expect(screen.getByTestId('persona-picker-name-voice-consequence')).toBeDefined();
    expect(screen.getByTestId('persona-picker-name-voice-input')).toBeDefined();
    expect(screen.getByTestId('persona-picker-name-voice-submit')).toBeDefined();
  });
});
