import { describe, it, expect, vi, beforeEach } from 'vitest';
const ml = vi.fn(); const mm = vi.fn(); const mw = vi.fn();
vi.mock('fs', () => ({ default: { lstatSync: (...a: any[]) => ml(...a), existsSync: () => false, mkdirSync: (...a: any[]) => mm(...a), writeFileSync: (...a: any[]) => mw(...a) } }));
import { SharedFileSymlinkError, writeAgentFile } from '../../src/lib/agent-files';

describe('SharedFileSymlinkError', () => {
  it('is an Error subclass with properties', () => {
    const e = new SharedFileSymlinkError('t', 'agents_md', 'AGENTS.md');
    expect(e).toBeInstanceOf(Error); expect(e.agentName).toBe('t'); expect(e.column).toBe('agents_md'); expect(e.filename).toBe('AGENTS.md'); expect(e.message).toContain('symbolic link');
  });
});

describe('writeAgentFile symlink guard', () => {
  beforeEach(() => { ml.mockReset(); mw.mockReset(); mm.mockReset(); });

  it('rejects agents_md symlink write (main)', () => {
    ml.mockReturnValue({ isSymbolicLink: () => true });
    expect(() => writeAgentFile('t', 'agents_md', 'c')).toThrow(SharedFileSymlinkError);
    expect(mw).not.toHaveBeenCalled();
  });

  it('rejects tools_md symlink write (main)', () => {
    ml.mockReturnValue({ isSymbolicLink: () => true });
    expect(() => writeAgentFile('t', 'tools_md', 'c')).toThrow(SharedFileSymlinkError);
    expect(mw).not.toHaveBeenCalled();
  });

  it('allows non-shared soul_md on symlink (edge)', () => {
    ml.mockReturnValue({ isSymbolicLink: () => true });
    expect(() => writeAgentFile('t', 'soul_md', 'c')).not.toThrow();
    expect(mw).toHaveBeenCalled();
  });

  it('allows regular file write (edge)', () => {
    ml.mockReturnValue({ isSymbolicLink: () => false });
    expect(() => writeAgentFile('t', 'agents_md', 'c')).not.toThrow();
    expect(mw).toHaveBeenCalled();
  });

  it('error names agent/column/filename', () => {
    ml.mockReturnValue({ isSymbolicLink: () => true });
    try { writeAgentFile('my-agent', 'agents_md', 'x'); expect.unreachable('should throw'); } catch (e: any) { expect(e).toBeInstanceOf(SharedFileSymlinkError); expect(e.agentName).toBe('my-agent'); expect(e.column).toBe('agents_md'); expect(e.filename).toBe('AGENTS.md'); }
  });

  it('mutation proof: guard IS load-bearing', () => {
    ml.mockReturnValue({ isSymbolicLink: () => true });
    expect(() => writeAgentFile('t', 'agents_md', 'c')).toThrow(SharedFileSymlinkError);
  });
});
