import type { ApprovalRequest } from '@/lib/approval-requests';

/** Renders the agent-supplied preview as TEXT, links and images only — never as HTML. */
export function ApprovalPreview({ preview }: { preview: ApprovalRequest['preview'] }) {
  const { text, links, images } = preview;
  if (!text && !links?.length && !images?.length) return null;
  return (
    <div className="mt-4 space-y-4" data-testid="approval-preview">
      {text ? (
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 border border-gray-200 p-4 text-sm text-gray-800 font-sans">{text}</pre>
      ) : null}
      {links?.length ? (
        <ul className="space-y-2">
          {links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline font-medium break-all">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {images?.length ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {images.map((src) => (
            <a key={src} href={src} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="Preview" loading="lazy" referrerPolicy="no-referrer" className="w-full rounded-lg border border-gray-200 object-cover" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
