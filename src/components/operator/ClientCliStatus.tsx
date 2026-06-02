'use client';

/**
 * ClientCliStatus — per-client agent-CLI panel for the Bridge page (E16).
 *
 * Shows, for the SELECTED client, which agent CLIs are installed and at what
 * VERSION: Claude Code, Codex, Antigravity, Hermes, Gemini, and OpenClaw. The
 * detection (local for the operator's own box, over the Cloudflare Access
 * tunnel for a remote client) runs server-side in the Bridge page and is passed
 * in as `statuses`. Each row offers:
 *
 *   - Install  (when the CLI is missing and a scripted installer exists)
 *   - Update   (when the CLI is installed and a scripted updater exists)
 *
 * Actions POST to `/api/operator/bridge/cli`. If that route is not present yet
 * the component degrades softly: the button shows a clear "action endpoint not
 * available" notice rather than throwing. The displayed status is always
 * accurate because it comes from the server-side probe.
 *
 * No em dashes in user-facing copy.
 */

import { useCallback, useState } from 'react';
import { Loader2, Download, RefreshCw, CheckCircle2, XCircle, HelpCircle } from 'lucide-react';

export interface CliStatus {
  id: string;
  label: string;
  bin: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  remote: boolean;
  error: string | null;
  canInstall: boolean;
  canUpdate: boolean;
}

interface Props {
  clientName: string;
  isRemote: boolean;
  statuses: CliStatus[];
}

interface ActionState {
  running: boolean;
  output: string | null;
  error: string | null;
}

export default function ClientCliStatus({ clientName, isRemote, statuses }: Props) {
  const [actions, setActions] = useState<Record<string, ActionState>>({});

  const runAction = useCallback(
    async (id: string, action: 'install' | 'update') => {
      setActions((s) => ({ ...s, [id]: { running: true, output: null, error: null } }));
      try {
        const res = await fetch('/api/operator/bridge/cli', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, action }),
        });
        if (res.status === 404) {
          setActions((s) => ({
            ...s,
            [id]: {
              running: false,
              output: null,
              error: 'The install/update action endpoint is not available on this build yet.',
            },
          }));
          return;
        }
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          output?: string;
          reason?: string;
        };
        setActions((s) => ({
          ...s,
          [id]: {
            running: false,
            output: data.output ?? null,
            error: data.ok ? null : data.reason || `The ${action} did not complete.`,
          },
        }));
      } catch {
        setActions((s) => ({
          ...s,
          [id]: { running: false, output: null, error: 'Could not reach the action endpoint.' },
        }));
      }
    },
    []
  );

  return (
    <section className="rounded-xl border border-bcc-border bg-bcc-surface p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-section-title text-bcc-text">Agent CLIs on {clientName}</h2>
          <p className="mt-1 text-[13px] text-bcc-text-secondary max-w-[640px]">
            Installed versions of the operator agent CLIs on the selected
            client&apos;s box.{' '}
            {isRemote
              ? 'Detected over the Cloudflare Access tunnel.'
              : 'Detected locally on this box.'}{' '}
            Install a missing CLI or update a stale one. Switch clients in the
            header to manage a different box.
          </p>
        </div>
      </div>

      <ul className="mt-4 divide-y divide-bcc-border">
        {statuses.length === 0 && (
          <li className="py-3 text-[13px] text-bcc-text-muted">
            No CLI status available. The detection could not run for this client.
          </li>
        )}
        {statuses.map((s) => {
          const a = actions[s.id];
          return (
            <li key={s.id} className="py-3 flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {s.error ? (
                    <HelpCircle size={15} className="text-bcc-text-muted shrink-0" />
                  ) : s.installed ? (
                    <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />
                  ) : (
                    <XCircle size={15} className="text-bcc-text-muted shrink-0" />
                  )}
                  <span className="text-body text-bcc-text font-medium">{s.label}</span>
                  <code className="text-[12px] text-bcc-text-muted">({s.bin})</code>
                </div>
                <div className="mt-1 text-[12px] text-bcc-text-secondary font-mono break-all">
                  {s.error
                    ? `status unknown: ${s.error}`
                    : s.installed
                      ? `${s.version ?? 'installed (version unknown)'}${s.path ? ` at ${s.path}` : ''}`
                      : 'not installed'}
                </div>
                {a?.error && <div className="mt-1 text-[12px] text-rose-500">{a.error}</div>}
                {a?.output && (
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-bcc-bg p-2 text-[11px] text-bcc-text-muted whitespace-pre-wrap">
                    {a.output}
                  </pre>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!s.installed && s.canInstall && (
                  <button
                    type="button"
                    onClick={() => runAction(s.id, 'install')}
                    disabled={a?.running}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-bcc-border px-3 py-1.5 text-[13px] text-bcc-text hover:bg-bcc-bg disabled:opacity-50"
                  >
                    {a?.running ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    Install
                  </button>
                )}
                {s.installed && s.canUpdate && (
                  <button
                    type="button"
                    onClick={() => runAction(s.id, 'update')}
                    disabled={a?.running}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-bcc-border px-3 py-1.5 text-[13px] text-bcc-text hover:bg-bcc-bg disabled:opacity-50"
                  >
                    {a?.running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Update
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
