'use client';

/**
 * FilePreview , inline preview for files in the Operator Console Workspace.
 *
 * Track B3 (PRD Section 4.4) + Addition 1 (markdown preview).
 *
 * Supported preview kinds (6 total):
 *   1. image    , img tag, fit-to-pane
 *   2. video    , video tag with controls; HTTP Range is honored server-side
 *   3. audio    , audio tag with controls
 *   4. code     , syntax-highlighted source (via rehype-highlight in markdown
 *                 OR fallback to a pre/code block for plain code files)
 *   5. html     , sandboxed iframe with Preview / Source toggle
 *   6. markdown , react-markdown + remark-gfm + rehype-highlight, with a
 *                 Preview / Source toggle (Addition 1)
 *
 * Binary / pdf / unknown kinds get a download link.
 */

import { useState } from 'react';
import { Download, Eye, FileCode, Loader2, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

export interface FilePreviewProps {
  /** Owning agent slug. Drives the `fileUrl` query string. */
  agent: string;
  /** Path relative to the agent's scratch root. */
  relPath: string;
  /** File classification from the listing. */
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text' | 'code' | 'binary' | 'app';
  /** Lowercase extension, including the dot. */
  ext: string;
  /** When true, this file's content has already been fetched and passed in. */
  initialContent?: string;
  /** Optional name for the download button. Defaults to the file basename. */
  filename?: string;
}

type TextMode = 'preview' | 'source';

function fileUrl(agent: string, relPath: string): string {
  const qs = new URLSearchParams({ agent, path: relPath });
  return `/api/operator/workspace/file?${qs.toString()}`;
}

export default function FilePreview(props: FilePreviewProps) {
  const { agent, relPath, kind, ext, initialContent, filename } = props;
  const src = fileUrl(agent, relPath);
  const downloadName = filename || relPath.split('/').pop() || 'download';

  if (kind === 'image') {
    return (
      <div className="rounded-lg border border-bcc-border bg-bcc-bg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12px] text-bcc-text-muted truncate">{downloadName}</span>
          <DownloadLink href={src} name={downloadName} />
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={downloadName}
          className="max-w-full max-h-[70vh] mx-auto rounded-md object-contain bg-white"
        />
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className="rounded-lg border border-bcc-border bg-bcc-bg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12px] text-bcc-text-muted truncate">{downloadName}</span>
          <DownloadLink href={src} name={downloadName} />
        </div>
        <video
          src={src}
          controls
          preload="metadata"
          className="max-w-full max-h-[70vh] mx-auto rounded-md bg-black"
        />
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="rounded-lg border border-bcc-border bg-bcc-bg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12px] text-bcc-text-muted truncate">{downloadName}</span>
          <DownloadLink href={src} name={downloadName} />
        </div>
        <audio src={src} controls className="w-full" />
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <div className="rounded-lg border border-bcc-border bg-bcc-bg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12px] text-bcc-text-muted truncate">{downloadName}</span>
          <DownloadLink href={src} name={downloadName} />
        </div>
        <iframe
          src={src}
          title={downloadName}
          className="w-full h-[70vh] rounded-md bg-white border border-bcc-border-light"
        />
      </div>
    );
  }

  // Text-like: markdown, code, plain text, html, svg
  return (
    <TextPreview
      agent={agent}
      relPath={relPath}
      kind={kind}
      ext={ext}
      initialContent={initialContent}
      filename={downloadName}
      src={src}
    />
  );
}

interface TextPreviewProps {
  agent: string;
  relPath: string;
  kind: FilePreviewProps['kind'];
  ext: string;
  initialContent?: string;
  filename: string;
  src: string;
}

function TextPreview(props: TextPreviewProps) {
  const { kind, ext, initialContent, filename, src, agent, relPath } = props;
  const isHtml = ext === '.html' || ext === '.htm';
  const isMarkdown = kind === 'markdown' || ext === '.md' || ext === '.markdown';
  const supportsToggle = isHtml || isMarkdown;

  const [content, setContent] = useState<string>(initialContent || '');
  const [loading, setLoading] = useState<boolean>(!initialContent);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<TextMode>(supportsToggle ? 'preview' : 'source');

  if (loading && !content && !error) {
    // Trigger one fetch on first render. We avoid useEffect to keep this
    // component tree minimal; the fetch runs in microtask order.
    fetchContent();
  }

  async function fetchContent() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data.content === 'string') {
        setContent(data.content);
      } else {
        throw new Error('No content in response');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-bcc-border bg-bcc-bg">
      <div className="flex items-center justify-between px-4 py-2 border-b border-bcc-border-light">
        <span className="text-[12px] text-bcc-text-muted truncate">{filename}</span>
        <div className="flex items-center gap-2">
          {supportsToggle && (
            <div className="inline-flex rounded-md border border-bcc-border bg-bcc-white overflow-hidden">
              <button
                type="button"
                onClick={() => setMode('preview')}
                className={`px-2.5 py-1 text-[11px] font-medium inline-flex items-center gap-1 ${
                  mode === 'preview'
                    ? 'bg-bcc-primary-light text-bcc-text'
                    : 'text-bcc-text-secondary hover:bg-bcc-border-light'
                }`}
              >
                <Eye size={12} /> Preview
              </button>
              <button
                type="button"
                onClick={() => setMode('source')}
                className={`px-2.5 py-1 text-[11px] font-medium inline-flex items-center gap-1 border-l border-bcc-border-light ${
                  mode === 'source'
                    ? 'bg-bcc-primary-light text-bcc-text'
                    : 'text-bcc-text-secondary hover:bg-bcc-border-light'
                }`}
              >
                <FileCode size={12} /> Source
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={fetchContent}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-bcc-border bg-bcc-white text-bcc-text-secondary hover:bg-bcc-border-light disabled:opacity-50"
            title="Reload file"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Reload
          </button>
          <DownloadLink href={src} name={filename} />
        </div>
      </div>

      <div className="p-4 min-h-[200px]">
        {error && (
          <div className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            Could not load file: {error}
          </div>
        )}

        {!error && loading && !content && (
          <div className="flex items-center gap-2 text-[12px] text-bcc-text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading...
          </div>
        )}

        {!error && content && isHtml && mode === 'preview' && (
          <iframe
            srcDoc={content}
            title={filename}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="w-full h-[70vh] rounded-md bg-white border border-bcc-border-light"
          />
        )}

        {!error && content && isMarkdown && mode === 'preview' && (
          <div className="prose-markdown max-w-none text-[14px] text-bcc-text leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                /* eslint-disable @typescript-eslint/no-explicit-any */
                h1: (p: any) => <h1 className="text-2xl font-bold mt-4 mb-3" {...p} />,
                h2: (p: any) => <h2 className="text-xl font-bold mt-4 mb-2" {...p} />,
                h3: (p: any) => <h3 className="text-lg font-semibold mt-3 mb-2" {...p} />,
                p: (p: any) => <p className="my-2" {...p} />,
                ul: (p: any) => <ul className="list-disc pl-6 my-2 space-y-1" {...p} />,
                ol: (p: any) => <ol className="list-decimal pl-6 my-2 space-y-1" {...p} />,
                code: (p: any) =>
                  p.inline ? (
                    <code className="px-1 py-0.5 rounded bg-bcc-border-light text-[12.5px]" {...p} />
                  ) : (
                    <code {...p} />
                  ),
                pre: (p: any) => (
                  <pre
                    className="my-3 p-3 rounded-md bg-[#0f172a] text-[#e2e8f0] overflow-x-auto text-[12.5px] leading-relaxed"
                    {...p}
                  />
                ),
                a: (p: any) => (
                  <a className="text-bcc-primary hover:underline" target="_blank" rel="noreferrer" {...p} />
                ),
                table: (p: any) => (
                  <div className="my-3 overflow-x-auto">
                    <table className="min-w-full border border-bcc-border text-[13px]" {...p} />
                  </div>
                ),
                th: (p: any) => (
                  <th className="border border-bcc-border-light bg-bcc-border-light px-2 py-1 text-left font-semibold" {...p} />
                ),
                td: (p: any) => <td className="border border-bcc-border-light px-2 py-1" {...p} />,
                blockquote: (p: any) => (
                  <blockquote className="border-l-4 border-bcc-border pl-3 italic text-bcc-text-secondary my-2" {...p} />
                ),
                /* eslint-enable @typescript-eslint/no-explicit-any */
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}

        {!error && content && (mode === 'source' || (!isHtml && !isMarkdown)) && (
          <pre className="text-[12.5px] leading-relaxed font-mono whitespace-pre-wrap break-words bg-bcc-white border border-bcc-border-light rounded-md p-3 max-h-[70vh] overflow-auto">
            {content}
          </pre>
        )}

        {/* For completeness, surface the agent+path for power users. */}
        <div className="mt-3 text-[10.5px] uppercase tracking-[0.16em] text-bcc-text-muted">
          {agent} / {relPath}
        </div>
      </div>
    </div>
  );
}

function DownloadLink({ href, name }: { href: string; name: string }) {
  return (
    <a
      href={href}
      download={name}
      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-bcc-border bg-bcc-white text-bcc-text-secondary hover:bg-bcc-border-light"
    >
      <Download size={12} /> Download
    </a>
  );
}
