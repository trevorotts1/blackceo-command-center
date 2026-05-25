'use client';

/**
 * NotebookSourceUploader - adds a source to a notebook.
 *
 * Track B5 (PRD Section 4.6). Posts to
 * `/api/operator/notebook/[id]/sources`. Depth 2 supports three source modes:
 *   - url     : remote URL, fetched server-side later
 *   - text    : inline text/markdown content (stored under `path` as a
 *               `text://` pseudo-URI so the table row is self-contained)
 *   - path    : already-uploaded file path on the local disk (used by the
 *               vault uploader at later depths)
 *
 * Returns `onCreated` so the parent NotebookDetail can refresh.
 */

import { useState, FormEvent } from 'react';
import { Plus, Link as LinkIcon, FileText, Folder } from 'lucide-react';

type Mode = 'url' | 'text' | 'path';

interface Props {
  notebookId: string;
  onCreated?: () => void;
}

export default function NotebookSourceUploader({ notebookId, onCreated }: Props) {
  const [mode, setMode] = useState<Mode>('url');
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const v = value.trim();
    if (!v) return;

    setBusy(true);
    setError(null);

    let body: Record<string, unknown>;
    if (mode === 'url') {
      body = {
        source_type: 'url',
        title: title.trim() || v,
        url: v,
      };
    } else if (mode === 'text') {
      body = {
        source_type: 'text',
        title: title.trim() || `Inline note ${new Date().toISOString().slice(0, 10)}`,
        path: `text://${encodeURIComponent(v).slice(0, 4000)}`,
        byte_size: v.length,
      };
    } else {
      body = {
        source_type: 'pdf',
        title: title.trim() || v.split('/').pop() || v,
        path: v,
      };
    }

    try {
      const res = await fetch(`/api/operator/notebook/${notebookId}/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`upload failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      setTitle('');
      setValue('');
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-xl border border-bcc-border bg-bcc-white p-4"
      aria-label="Add source to notebook"
    >
      <div className="flex items-center justify-between">
        <div className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted">
          Add source
        </div>
        <div className="flex items-center gap-1 rounded-md border border-bcc-border bg-bcc-bg p-0.5">
          <ModeButton current={mode} value="url" onClick={setMode} icon={<LinkIcon size={12} />} label="URL" />
          <ModeButton current={mode} value="text" onClick={setMode} icon={<FileText size={12} />} label="Text" />
          <ModeButton current={mode} value="path" onClick={setMode} icon={<Folder size={12} />} label="Path" />
        </div>
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Optional title"
        aria-label="Source title"
        disabled={busy}
        className="w-full bg-transparent outline-none text-[14px] text-bcc-text placeholder:text-bcc-text-muted border-b border-bcc-border focus:border-bcc-text pb-2"
      />

      {mode === 'text' ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste markdown or text..."
          aria-label="Source text"
          disabled={busy}
          rows={5}
          className="w-full resize-y bg-transparent outline-none text-[13px] text-bcc-text placeholder:text-bcc-text-muted border-b border-bcc-border focus:border-bcc-text pb-2"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={mode === 'url' ? 'https://...' : '/path/to/file.pdf'}
          aria-label={mode === 'url' ? 'Source URL' : 'Source file path'}
          disabled={busy}
          className="w-full bg-transparent outline-none text-[14px] text-bcc-text placeholder:text-bcc-text-muted border-b border-bcc-border focus:border-bcc-text pb-2"
        />
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy || value.trim().length === 0}
          className="inline-flex items-center gap-2 rounded-md bg-bcc-text px-3 py-1.5 text-[12px] uppercase tracking-[0.18em] text-bcc-white hover:opacity-90 disabled:opacity-50"
        >
          <Plus size={14} />
          {busy ? 'Adding' : 'Add source'}
        </button>
      </div>
    </form>
  );
}

interface ModeButtonProps {
  current: Mode;
  value: Mode;
  onClick: (m: Mode) => void;
  icon: React.ReactNode;
  label: string;
}

function ModeButton({ current, value, onClick, icon, label }: ModeButtonProps) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] uppercase tracking-[0.16em] ${
        active ? 'bg-bcc-text text-bcc-white' : 'text-bcc-text-muted hover:text-bcc-text'
      }`}
      aria-pressed={active}
    >
      {icon}
      {label}
    </button>
  );
}
