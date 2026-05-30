'use client';

/**
 * WorkspaceView , top-level shell for the Operator Console Workspace.
 *
 * Track B3 (PRD Section 4.4) + SCOPE-ADDITION Addition 2 (buckets).
 *
 * Layout:
 *
 *   [ Tab bar: By Agent | By Type ]
 *
 *   By Agent:
 *     - Left pane: agent picker (7 slugs, counts)
 *     - Right pane: file browser + selected file preview
 *
 *   By Type:
 *     - Single pane: 7 bucket cards. Click a card to drill in.
 *
 * The view is fully client-side. It fetches:
 *   GET /api/operator/workspace/list                  (agent directory)
 *   GET /api/operator/workspace/list?agent=<slug>     (per-agent files)
 *   GET /api/operator/workspace/file?agent=&path=     (file content)
 *   GET /api/operator/workspace/buckets[?bucket=&...] (buckets)
 */

import { useEffect, useMemo, useState } from 'react';
import { Folders, LayoutGrid, Loader2 } from 'lucide-react';
import FileBrowser, { type FileBrowserFile } from './FileBrowser';
import FilePreview from './FilePreview';
import BucketsView from './BucketsView';
import OperatorHelpButton from './OperatorHelpButton';

type ViewMode = 'agent' | 'type';

interface AgentSummary {
  agent: string;
  root: string;
  exists: boolean;
  fileCount: number;
}

interface AgentFile extends FileBrowserFile {
  agent: string;
}

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  hermes: 'Hermes',
  gemini: 'Gemini',
  fcc: 'Free Claude Code',
  openclaw: 'OpenClaw',
};

const AGENT_ACCENT: Record<string, string> = {
  claude: '#3B82F6',
  codex: '#8B5CF6',
  antigravity: '#EC4899',
  hermes: '#F59E0B',
  gemini: '#10B981',
  fcc: '#06B6D4',
  openclaw: '#6366F1',
};

export default function WorkspaceView() {
  const [mode, setMode] = useState<ViewMode>('agent');

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console / Workspace
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text">Per-agent scratch and output buckets.</h1>
          </div>
          <OperatorHelpButton card="workspace" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[700px]">
          Anything the operator-level CLIs write lands here. Switch between agent view and the
          7 output buckets that aggregate files across every source.
        </p>
      </header>

      <div className="inline-flex rounded-md border border-bcc-border bg-bcc-white overflow-hidden">
        <button
          type="button"
          onClick={() => setMode('agent')}
          className={`px-3 py-2 text-[12.5px] font-medium inline-flex items-center gap-1.5 ${
            mode === 'agent'
              ? 'bg-bcc-primary-light text-bcc-text'
              : 'text-bcc-text-secondary hover:bg-bcc-border-light'
          }`}
        >
          <Folders size={14} /> By Agent
        </button>
        <button
          type="button"
          onClick={() => setMode('type')}
          className={`px-3 py-2 text-[12.5px] font-medium inline-flex items-center gap-1.5 border-l border-bcc-border-light ${
            mode === 'type'
              ? 'bg-bcc-primary-light text-bcc-text'
              : 'text-bcc-text-secondary hover:bg-bcc-border-light'
          }`}
        >
          <LayoutGrid size={14} /> By Type
        </button>
      </div>

      {mode === 'agent' ? <ByAgentPane /> : <BucketsView />}
    </div>
  );
}

function ByAgentPane() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AgentFile | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAgentsLoading(true);
      setAgentsError(null);
      try {
        const res = await fetch('/api/operator/workspace/list');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          const list = (data.agents || []) as AgentSummary[];
          setAgents(list);
          // Pick the first agent with files, or the first one period.
          const firstWithFiles = list.find((a) => a.fileCount > 0) || list[0];
          if (firstWithFiles) setActiveAgent(firstWithFiles.agent);
        }
      } catch (err) {
        if (!cancelled) setAgentsError(err instanceof Error ? err.message : 'load failed');
      } finally {
        if (!cancelled) setAgentsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeAgent) {
      setFiles([]);
      setSelected(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setFilesLoading(true);
      setFilesError(null);
      try {
        const qs = new URLSearchParams({ agent: activeAgent });
        const res = await fetch(`/api/operator/workspace/list?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          const next: AgentFile[] = (data.files || []).map((f: FileBrowserFile) => ({
            ...f,
            agent: activeAgent,
          }));
          setFiles(next);
          setSelected(next[0] || null);
        }
      } catch (err) {
        if (!cancelled) setFilesError(err instanceof Error ? err.message : 'load failed');
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAgent]);

  const activeSummary = useMemo(
    () => agents.find((a) => a.agent === activeAgent) || null,
    [agents, activeAgent]
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
      <aside className="rounded-lg border border-bcc-border bg-bcc-white p-3">
        <div className="px-2 pb-2 text-[10px] uppercase tracking-[0.2em] text-bcc-text-muted font-semibold">
          Agents
        </div>
        {agentsLoading && (
          <div className="px-2 py-2 text-[12px] text-bcc-text-muted inline-flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Loading...
          </div>
        )}
        {agentsError && (
          <div className="px-2 py-2 text-[12px] text-red-600">{agentsError}</div>
        )}
        <ul className="flex flex-col gap-0.5">
          {agents.map((a) => {
            const active = activeAgent === a.agent;
            const accent = AGENT_ACCENT[a.agent] || '#64748B';
            return (
              <li key={a.agent}>
                <button
                  type="button"
                  onClick={() => setActiveAgent(a.agent)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-left transition-colors ${
                    active
                      ? 'bg-bcc-primary-light text-bcc-text'
                      : 'text-bcc-text-secondary hover:bg-bcc-border-light hover:text-bcc-text'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: accent }}
                    />
                    <span className="text-[13px]">{AGENT_LABELS[a.agent] || a.agent}</span>
                  </span>
                  <span
                    className={`text-[11px] px-1.5 py-0.5 rounded ${
                      a.fileCount
                        ? 'bg-bcc-border-light text-bcc-text-secondary'
                        : 'text-bcc-text-muted'
                    }`}
                  >
                    {a.fileCount}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="space-y-4 min-w-0">
        {activeSummary && (
          <div className="rounded-lg border border-bcc-border bg-bcc-white px-4 py-3">
            <div className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted">
              Scratch root
            </div>
            <div className="mt-1 text-[13px] font-mono text-bcc-text break-all">
              {activeSummary.root}
            </div>
            {!activeSummary.exists && (
              <div className="mt-2 text-[12px] text-bcc-text-secondary">
                Directory does not exist yet. It will be created the first time the agent writes.
              </div>
            )}
          </div>
        )}

        {filesError && (
          <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {filesError}
          </div>
        )}

        {filesLoading && (
          <div className="text-[12px] text-bcc-text-muted inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading files...
          </div>
        )}

        {!filesLoading && (
          <FileBrowser
            files={files}
            selectedRelPath={selected?.relPath || null}
            onSelect={(f) => setSelected({ ...f, agent: activeAgent || '' })}
          />
        )}

        {selected && activeAgent && (
          <FilePreview
            agent={activeAgent}
            relPath={selected.relPath}
            kind={selected.kind}
            ext={selected.ext}
            filename={selected.name}
          />
        )}
      </section>
    </div>
  );
}
