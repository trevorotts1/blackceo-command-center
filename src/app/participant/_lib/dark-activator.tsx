'use client';

/**
 * Dark-mode activator scoped ONLY to the participant subtree.
 *
 * When this component mounts (only on the participant page), it reads
 * prefers-color-scheme and toggles `document.documentElement.classList`
 * 'dark' accordingly. On unmount (navigating away from participant), it
 * removes the 'dark' class so out-of-scope dashboard pages are never
 * affected.
 *
 * This is the ONLY place in the codebase that writes to `document.documentElement.classList`
 * for dark-mode on behalf of participant pages. The root layout remains
 * untouched.
 */

import { useEffect } from 'react';

export function ParticipantDarkActivator() {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    const sync = () => {
      if (mq.matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };

    sync();
    mq.addEventListener('change', sync);

    return () => {
      mq.removeEventListener('change', sync);
      document.documentElement.classList.remove('dark');
    };
  }, []);

  return null;
}
