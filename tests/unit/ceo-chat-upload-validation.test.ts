/**
 * P5-01 — My AI CEO upload validation (the QC break-it probes as a unit test).
 *
 * The spec (e) break-it list requires: a 5GB file gets a clean refusal; an
 * executable gets a type refusal. validateUpload() is the PURE decision both the
 * route and the judge exercise, so we prove it directly here — no live route, no
 * disk.
 *
 * Fail-first: against the pre-P5-01 tree src/lib/ceo-chat/upload.ts does not
 * exist, so this suite cannot even import — it is red until the feature lands.
 */
import { describe, it, expect } from 'vitest';
import {
  validateUpload,
  MAX_UPLOAD_BYTES,
  resolveInboxDir,
  inboxDateSegment,
  extensionOf,
  sanitizeFilename,
} from '@/lib/ceo-chat/upload';

describe('validateUpload — size cap (break-it: a 5GB file)', () => {
  it('refuses a 5GB upload with reason "too-large" (never buffers it)', () => {
    const v = validateUpload({ filename: 'huge.mp4', mimeType: 'video/mp4', size: 5 * 1024 * 1024 * 1024 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('too-large');
  });

  it('accepts a large-but-legal file at exactly the cap', () => {
    const v = validateUpload({ filename: 'ok.mp4', mimeType: 'video/mp4', size: MAX_UPLOAD_BYTES });
    expect(v.ok).toBe(true);
  });

  it('refuses an empty (0-byte) file', () => {
    const v = validateUpload({ filename: 'empty.pdf', mimeType: 'application/pdf', size: 0 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('empty');
  });
});

describe('validateUpload — type allow-list (break-it: an executable)', () => {
  it('refuses a raw .exe', () => {
    const v = validateUpload({ filename: 'malware.exe', mimeType: 'application/x-msdownload', size: 1024 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it('refuses a .sh script', () => {
    const v = validateUpload({ filename: 'evil.sh', mimeType: 'text/x-shellscript', size: 200 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it('refuses an executable renamed .png when the MIME betrays it', () => {
    const v = validateUpload({ filename: 'notreally.png', mimeType: 'application/x-msdownload', size: 4096 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it('refuses a file with no extension', () => {
    const v = validateUpload({ filename: 'README', mimeType: '', size: 100 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('type-not-allowed');
  });

  it.each([
    ['brief.pdf', 'application/pdf'],
    ['spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['notes.md', 'text/markdown'],
    ['photo.png', 'image/png'],
    ['pic.jpg', 'image/jpeg'],
    ['clip.mp4', 'video/mp4'],
    ['clip.mov', 'video/quicktime'],
  ])('accepts an allowed type %s', (filename, mime) => {
    const v = validateUpload({ filename, mimeType: mime, size: 2048 });
    expect(v.ok).toBe(true);
    expect(v.safeName).toBe(filename);
  });

  it('accepts an allowed extension when the picker sends octet-stream / empty MIME', () => {
    expect(validateUpload({ filename: 'doc.pdf', mimeType: 'application/octet-stream', size: 500 }).ok).toBe(true);
    expect(validateUpload({ filename: 'doc.pdf', mimeType: '', size: 500 }).ok).toBe(true);
  });
});

describe('filename sanitization + inbox path (no traversal)', () => {
  it('strips directory + traversal parts from the stored name', () => {
    expect(sanitizeFilename('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('C:\\Windows\\evil.png')).toBe('evil.png');
    expect(sanitizeFilename('  ..config  ')).not.toMatch(/^\./);
  });

  it('a traversal filename is refused when it has no allowed extension', () => {
    const v = validateUpload({ filename: '../../../etc/passwd', mimeType: '', size: 100 });
    expect(v.ok).toBe(false);
  });

  it('resolveInboxDir lands under <root>/inbox/ceo-chat/<YYYY-MM-DD>', () => {
    const dir = resolveInboxDir('/srv/workspace', new Date('2026-07-11T12:00:00Z'));
    expect(dir).toBe('/srv/workspace/inbox/ceo-chat/2026-07-11');
    expect(inboxDateSegment(new Date('2026-07-11T23:59:59Z'))).toBe('2026-07-11');
  });

  it('extensionOf is lower-cased and dotless', () => {
    expect(extensionOf('Report.PDF')).toBe('pdf');
    expect(extensionOf('noext')).toBe('');
  });
});
