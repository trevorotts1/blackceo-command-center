'use client';

/**
 * Council settings page (CWE-034, Skill 77): /council/settings
 *
 * Reads the settings contract. The settings service is owned by
 * CWE-050 and is not wired in this build, so the endpoint's typed
 * FEATURE_NOT_READY answer renders as the explicit not-ready state:
 * no settings form is shown that could not really save.
 */

import { useEffect, useMemo, useState } from 'react';
import { council } from '../../../components/council/council-theme';
import '../../../components/council/council-theme.css';
import '../../../components/council/council-room.css';
import { CouncilSettingsPanel } from '../../../components/council/CouncilAdvisors';
import {
  CouncilApiClient,
  CouncilApiClientError,
} from '../../../components/council/council-session-client';

export default function CouncilSettingsPage() {
  const client = useMemo(() => new CouncilApiClient(), []);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_ready' | 'error'>(
    'loading',
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getSettings()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof CouncilApiClientError && error.isFeatureNotReady) {
          setLoadState('not_ready');
          return;
        }
        setLoadState('error');
        setErrorMessage(
          error instanceof Error ? error.message : 'The council settings could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <main className={council.theme}>
      <h1 className={council.heading}>Council settings</h1>
      <CouncilSettingsPanel
        loadState={loadState}
        errorMessage={errorMessage}
        settings={settings}
      />
    </main>
  );
}
