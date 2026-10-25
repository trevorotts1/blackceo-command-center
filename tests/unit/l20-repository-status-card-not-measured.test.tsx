/**
 * Finding 3 (2026-10-25) — the repository card must never fabricate a project.
 *
 * Before the fix the card defaulted to `luminous-core-api`, 14 pull requests,
 * 3 issues, build 2904 / success / "2 mins ago", so a prop-less render (as on
 * `/ceo-board/[dept]`) showed a healthy stranger's repo. After the fix it
 * renders "Not measured" until a measured value arrives, and a measured zero
 * is still shown as zero.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RepositoryStatusCard } from '@/components/ceo-board/RepositoryStatusCard';

describe('RepositoryStatusCard — no fabricated defaults', () => {
  it('renders "Not measured" and none of the sample project when rendered prop-less', () => {
    const { container } = render(<RepositoryStatusCard />);
    const text = container.textContent ?? '';

    // Exactly six fields exist and all six must read "Not measured".
    expect(screen.getAllByText('Not measured').length).toBe(6);

    for (const sample of [
      'luminous-core-api',
      'v4.2.1-stable',
      '14',
      '3',
      '2904',
      '4m 32s',
      '2 mins ago',
      'Success',
    ]) {
      expect(text).not.toContain(sample);
    }

    // Belt: a prop-less render contains no digits at all, so no sample number
    // of any kind can leak back in.
    expect(text).not.toMatch(/\d/);
  });

  it('shows a measured zero as zero, never as "Not measured" or a sample', () => {
    const { container } = render(
      <RepositoryStatusCard
        repoName="l20-fixture-repo"
        version="v0.0.0-test"
        pullRequests={0}
        openIssues={0}
        buildNumber={0}
        buildDuration="0s"
        buildTime="just now"
        buildSuccess={false}
      />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('l20-fixture-repo');
    expect(text).toContain('Pull Requests');
    expect(text).not.toContain('Not measured');
    expect(screen.getAllByText('0').length).toBe(2);
    expect(text).toContain('Failed #0');
  });

  it('renders measured values verbatim', () => {
    const { container } = render(
      <RepositoryStatusCard
        repoName="measured/repo"
        version="v9.9.9"
        pullRequests={7}
        openIssues={2}
        buildNumber={42}
        buildDuration="1m 5s"
        buildTime="5 mins ago"
        buildSuccess
      />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('measured/repo');
    expect(text).toContain('v9.9.9');
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(text).toContain('Success #42');
    expect(text).toContain('Completed in 1m 5s');
    expect(text).toContain('5 mins ago');
    expect(text).not.toContain('Not measured');
  });
});

describe('[dept] page — no sample substitution for missing or zero KPIs', () => {
  // Source-contract guard (u56 pattern): the page-level half of finding 3 is
  // "never substitute a number for a zero". ponytail: source scan, not a page
  // render — add a render test when a /ceo-board/[dept] jsdom harness exists.
  const src = readFileSync(
    join(process.cwd(), 'src', 'app', 'ceo-board', '[dept]', 'page.tsx'),
    'utf-8',
  );

  it('carries no sample KPI numbers and no `||` substitution on a measured value', () => {
    for (const sample of ['84.36', '52.83', '4.38']) {
      expect(src).not.toContain(sample);
    }
    // `?.value || x` turns a measured zero into the fallback — forbidden.
    expect(src).not.toMatch(/\?\.\s*value\s*\|\|/);
  });

  it('does not import the sample-carrying KPIStatCardsRow', () => {
    expect(src).not.toContain('KPIStatCardsRow');
  });
});
