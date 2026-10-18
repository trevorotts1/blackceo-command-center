'use client';

/**
 * CouncilPageShell (CWE-033, Skill 77)
 *
 * The scoped page frame for every council journey screen: the CWE-031
 * .council-theme wrapper (the token stylesheet is imported here once;
 * CWE-032's CouncilShell imports it too and the cascade is identical),
 * a plain page header, and the Section 7 attribution line that stands
 * wherever advisor content appears. Journey screens render inside it;
 * the room itself stays CWE-032's CouncilShell, embedded as a child.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import './council-theme.css';
import './council-journey.css';
import { council } from './council-theme';

/** The Section 7 label, verbatim pattern, for advisor content. */
export const SECTION_7_LABEL =
  'Each council member is an AI perspective inspired by the published work of the named author. Not the individual and not an endorsement.';

export function CouncilPageShell({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <div className={council.theme} data-testid="council-page-shell">
      <div className="council-journey-wrap">
        <header className="council-journey-head">
          <p className={council.eyebrow}>
            <Link href="/council">Council of Wise Elders</Link>
          </p>
          <h1 className={council.display}>{title}</h1>
          {lede ? <p className={council.lede}>{lede}</p> : null}
        </header>
        <main>{children}</main>
        <footer className="council-journey-foot">
          <p className={council.meta}>{SECTION_7_LABEL}</p>
          <p className={council.meta}><a href="/council/portraits/credits.html">Photograph credits</a></p>
        </footer>
      </div>
    </div>
  );
}
