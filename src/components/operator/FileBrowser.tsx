'use client';

/**
 * FileBrowser , per-agent file list with selection + size/mtime metadata.
 *
 * Track B3 (PRD Section 4.4).
 *
 * Pure presentation component. Receives a list of files and an `onSelect`
 * callback. Selection state lives in the parent (WorkspaceView), so the
 * preview pane and the browser stay in sync when the user picks a row.
 */

import {
  FileText,
  FileCode,
  Image as ImageIcon,
  Film,
  Music,
  FileArchive,
  type LucideIcon,
} from 'lucide-react';

export interface FileBrowserFile {
  name: string;
  relPath: string;
  bytes: number;
  mtime: number;
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text' | 'code' | 'binary' | 'app';
  ext: string;
}

export interface FileBrowserProps {
  files: FileBrowserFile[];
  selectedRelPath?: string | null;
  onSelect?: (file: FileBrowserFile) => void;
  emptyHint?: string;
}

const KIND_META: Record<FileBrowserFile['kind'], { icon: LucideIcon; color: string; label: string }> = {
  image: { icon: ImageIcon, color: '#8B5CF6', label: 'Image' },
  video: { icon: Film, color: '#EC4899', label: 'Video' },
  audio: { icon: Music, color: '#F59E0B', label: 'Audio' },
  pdf: { icon: FileText, color: '#EF4444', label: 'PDF' },
  markdown: { icon: FileText, color: '#10B981', label: 'Markdown' },
  text: { icon: FileText, color: '#64748B', label: 'Text' },
  code: { icon: FileCode, color: '#3B82F6', label: 'Code' },
  binary: { icon: FileArchive, color: '#94A3B8', label: 'Binary' },
  app: { icon: FileCode, color: '#06B6D4', label: 'App' },
};

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function humanTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export default function FileBrowser({
  files,
  selectedRelPath,
  onSelect,
  emptyHint = 'No files yet. The active agent has not written anything to this scratch root.',
}: FileBrowserProps) {
  if (!files.length) {
    return (
      <div className="rounded-lg border border-dashed border-bcc-border bg-bcc-white p-6 text-center text-[13px] text-bcc-text-muted">
        {emptyHint}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-bcc-border-light rounded-lg border border-bcc-border bg-bcc-white overflow-hidden">
      {files.map((f) => {
        const meta = KIND_META[f.kind] || KIND_META.binary;
        const Icon = meta.icon;
        const active = selectedRelPath === f.relPath;
        return (
          <li key={f.relPath}>
            <button
              type="button"
              onClick={() => onSelect?.(f)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                active ? 'bg-bcc-primary-light' : 'hover:bg-bcc-border-light'
              }`}
            >
              <span
                className="grid place-items-center w-7 h-7 rounded-md shrink-0"
                style={{ background: `${meta.color}1a`, color: meta.color, border: `1px solid ${meta.color}33` }}
              >
                <Icon size={14} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-bcc-text truncate">{f.name}</div>
                <div className="text-[11px] text-bcc-text-muted truncate">{f.relPath}</div>
              </div>
              <div className="hidden sm:flex flex-col items-end shrink-0">
                <span className="text-[11px] uppercase tracking-[0.14em] text-bcc-text-muted">{meta.label}</span>
                <span className="text-[11px] text-bcc-text-secondary">
                  {humanBytes(f.bytes)} - {humanTime(f.mtime)}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
