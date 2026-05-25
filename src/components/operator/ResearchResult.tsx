'use client';

/**
 * ResearchResult — markdown renderer for a single research result.
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 *
 * The canonical markdown renderer for v4.0 is react-markdown + remark-gfm +
 * rehype-highlight (Addition 1). Those deps are not in package.json yet (they
 * are pending in BUILD-NOTES), so this component renders a small built-in
 * subset that preserves headings, lists, blockquotes, code blocks, emphasis,
 * and links without ever injecting raw HTML. When Addition 1's shared
 * renderer ships, the body of this component switches to a one-line import
 * without touching the call site.
 *
 * Security: this renderer never uses dangerouslySetInnerHTML. Inline
 * formatting (bold, italic, code, links) is tokenized into React nodes, so
 * untrusted markdown from the xAI provider cannot inject HTML.
 */

import { Fragment, ReactNode, useMemo } from 'react';
import { FileText, Calendar, Cpu, Link2 } from 'lucide-react';

export interface ResearchResultData {
  id?: string;
  query: string;
  model: string;
  markdown_result: string;
  created_at: string;
  search_metadata?: Record<string, unknown>;
}

export interface ResearchResultProps {
  result: ResearchResultData | null;
}

interface MetaCitation {
  url: string;
  title?: string;
}

function extractSourceUrls(meta: Record<string, unknown> | undefined): MetaCitation[] {
  if (!meta) return [];
  const raw = meta.source_urls;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => (typeof u === 'string' ? { url: u } : null))
    .filter((c): c is MetaCitation => c !== null);
}

// Inline tokenizer. Handles **bold**, *italic*, `code`, [text](url), and
// bare http(s) urls. Returns React nodes, never raw HTML.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const matches = Array.from(
    text.matchAll(/(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s)]+)/g)
  );
  let cursor = 0;
  let key = 0;
  for (const m of matches) {
    const idx = m.index || 0;
    if (idx > cursor) {
      nodes.push(text.slice(cursor, idx));
    }
    const token = m[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`c-${key++}`} className="rounded bg-bcc-bg px-1 py-0.5 text-[12.5px] font-mono">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={`i-${key++}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const linkParts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkParts) {
        const label = linkParts[1];
        const href = linkParts[2];
        nodes.push(
          <a
            key={`l-${key++}`}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline"
          >
            {label}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('http')) {
      nodes.push(
        <a
          key={`u-${key++}`}
          href={token}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 underline break-all"
        >
          {token}
        </a>
      );
    }
    cursor = idx + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes.length > 0 ? nodes : [text];
}

interface Block {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote' | 'hr' | 'code';
  lines: string[];
  lang?: string;
}

function tokenizeBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimEnd().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lines: codeLines, lang });
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      blocks.push({ type: 'hr', lines: [] });
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push({ type: 'h1', lines: [line.slice(2)] });
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', lines: [line.slice(3)] });
      i++;
      continue;
    }
    if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', lines: [line.slice(4)] });
      i++;
      continue;
    }
    if (/^>\s+/.test(line)) {
      const acc: string[] = [];
      while (i < lines.length && /^>\s+/.test(lines[i])) {
        acc.push(lines[i].replace(/^>\s+/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: acc });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const acc: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trimEnd())) {
        acc.push(lines[i].trimEnd().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', lines: acc });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const acc: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trimEnd())) {
        acc.push(lines[i].trimEnd().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', lines: acc });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const acc: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i].trimEnd();
      if (
        next.trim() === '' ||
        next.startsWith('# ') ||
        next.startsWith('## ') ||
        next.startsWith('### ') ||
        next.startsWith('```') ||
        /^---+\s*$/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^>\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break;
      }
      acc.push(next);
      i++;
    }
    blocks.push({ type: 'p', lines: acc });
  }
  return blocks;
}

function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((block, idx) => {
    switch (block.type) {
      case 'h1':
        return (
          <h1 key={idx} className="mt-6 mb-2 text-page-title text-bcc-text">
            {renderInline(block.lines[0] || '')}
          </h1>
        );
      case 'h2':
        return (
          <h2 key={idx} className="mt-5 mb-2 text-card-title text-bcc-text">
            {renderInline(block.lines[0] || '')}
          </h2>
        );
      case 'h3':
        return (
          <h3 key={idx} className="mt-4 mb-2 text-[15px] font-semibold text-bcc-text">
            {renderInline(block.lines[0] || '')}
          </h3>
        );
      case 'hr':
        return <hr key={idx} className="my-4 border-bcc-border" />;
      case 'quote':
        return (
          <blockquote
            key={idx}
            className="my-3 border-l-2 border-bcc-border pl-3 italic text-bcc-text-secondary"
          >
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {renderInline(line)}
                <br />
              </Fragment>
            ))}
          </blockquote>
        );
      case 'ul':
        return (
          <ul key={idx} className="my-3 list-disc pl-6 space-y-1">
            {block.lines.map((line, j) => (
              <li key={j}>{renderInline(line)}</li>
            ))}
          </ul>
        );
      case 'ol':
        return (
          <ol key={idx} className="my-3 list-decimal pl-6 space-y-1">
            {block.lines.map((line, j) => (
              <li key={j}>{renderInline(line)}</li>
            ))}
          </ol>
        );
      case 'code':
        return (
          <pre
            key={idx}
            className="my-3 overflow-x-auto rounded-lg bg-bcc-bg p-3 text-[12.5px] font-mono text-bcc-text"
            data-lang={block.lang || ''}
          >
            <code>{block.lines.join('\n')}</code>
          </pre>
        );
      case 'p':
      default:
        return (
          <p key={idx} className="my-3 leading-relaxed text-bcc-text">
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {renderInline(line)}
                {j < block.lines.length - 1 ? ' ' : null}
              </Fragment>
            ))}
          </p>
        );
    }
  });
}

export default function ResearchResult({ result }: ResearchResultProps) {
  const blocks = useMemo(() => {
    if (!result) return [] as Block[];
    return tokenizeBlocks(result.markdown_result || '');
  }, [result]);

  if (!result) {
    return (
      <section className="rounded-xl border border-bcc-border bg-bcc-white p-8 text-center text-bcc-text-muted">
        <FileText size={20} className="mx-auto mb-2" />
        <div className="text-[14px]">Run a search to see the result here.</div>
      </section>
    );
  }

  const citations = extractSourceUrls(result.search_metadata);
  const depth =
    typeof result.search_metadata?.depth === 'string' ? (result.search_metadata.depth as string) : null;
  const elapsed =
    typeof result.search_metadata?.elapsed_ms === 'number'
      ? (result.search_metadata.elapsed_ms as number)
      : null;

  return (
    <section className="rounded-xl border border-bcc-border bg-bcc-white p-6 space-y-4">
      <header className="space-y-2">
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Research result
        </div>
        <h1 className="text-page-title text-bcc-text">{result.query}</h1>
        <div className="flex flex-wrap items-center gap-4 text-[12px] text-bcc-text-muted">
          <span className="inline-flex items-center gap-1">
            <Calendar size={12} />
            {new Date(result.created_at).toLocaleString()}
          </span>
          <span className="inline-flex items-center gap-1">
            <Cpu size={12} />
            {result.model}
          </span>
          {depth ? <span className="uppercase tracking-[0.18em]">{depth}</span> : null}
          {elapsed !== null ? <span>{(elapsed / 1000).toFixed(1)}s</span> : null}
          {citations.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Link2 size={12} />
              {citations.length} sources
            </span>
          ) : null}
        </div>
      </header>
      <article className="max-w-none text-[14px] text-bcc-text">{renderBlocks(blocks)}</article>
    </section>
  );
}
