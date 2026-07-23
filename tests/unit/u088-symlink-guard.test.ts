import { describe, it, expect, vi, beforeEach } from 'vitest';
const mockLstat = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
vi.mock('fs', () => ({ default: { lstatSync: (...args: any[]) => mockLstat(...args), existsSync: () => false, mkdirSync: (...args: any[]) => mockMkdir(...args), writeFileSync: (...args: any[]) => mockWriteFile(...args), }, }));
import { SharedFileSymlinkError, isSymlink, writeAgentFile, SHARED_FILE_COLUMNS } from '../../src/lib/agent-files';

describe('SharedFileSymlinkError', () => {
  it('is an Error subclass with column/filename/agentName', () => {
    const e = new SharedFileSymlinkError('test', 'agents_md', 'AGENTS.md');
    expect(e).toBeInstanceOf(Error); expect(e.agentName).toBe('test'); expect(e.column).toBe('agents_md'); expect(e.filename).toBe('AGENTS.md'); expect(e.message).toContain('symbolic link');
  });
});

describe('SHARED_FILE_COLUMNS', () => {
  it('contains agents_md and tools_md', () => { expect(SHARED_FILE_COLUMNS.has('agents_md')).toBe(true); expect(SHARED_FILE_COLUMNS.has('tools_md')).toBe(true); });
  it('does NOT contain soul_md, memory_md, user_md', () => { expect(SHARED_FILE_COLUMNS.has('soul_md')).toBe(false); expect(SHARED_FILE_COLUMNS.has('memory_md')).toBe(false); expect(SHARED_FILE_COLUMNS.has('user_md')).toBe(false); });
});

describe('isSymlink', () => {
  beforeEach(() => mockLstat.mockReset());
  it('returns true when lstat reports symlink', () => { mockLstat.mockReturnValue({ isSymbolicLink: () => true }); expect(isSymlink('/f')).toBe(true); });
  it('returns false when lstat reports regular file', () => { mockLstat.mockReturnValue({ isSymbolicLink: () => false }); expect(isSymlink('/f')).toBe(false); });
  it('returns false when lstat throws', () => { mockLstat.mockImplementation(() => { throw new Error('ENOENT'); }); expect(isSymlink('/x')).toBe(false); });
});

describe('writeAgentFile symlink guard', () => {
  beforeEach(() => { mockLstat.mockReset(); mockWriteFile.mockReset(); mockMkdir.mockReset(); });
  it('rejects write through symlink for agents_md (main behavior)', () => { mockLstat.mockReturnValue({ isSymbolicLink: () => true }); expect(() => writeAgentFile('t', 'agents_md', 'c')).toThrow(SharedFileSymlinkError); expect(mockWriteFile).not.toHaveBeenCalled(); });
  it('rejects write through symlink for tools_md', () => { mockLstat.mockReturnValue({ isSymbolicLink: () => true }); expect(() => writeAgentFile('t', 'tools_md', 'c')).toThrow(SharedFileSymlinkError); expect(mockWriteFile).not.toHaveBeenCalled(); });
  it('allows non-shared column soul_md even on symlink (edge case)', () => { mockLstat.mockReturnValue({ isSymbolicLink: () => true }); expect(() => writeAgentFile('t', 'soul_md', 'c')).not.toThrow(); expect(mockWriteFile).toHaveBeenCalled(); });
  it('allows write on regular file (edge case)', () => { mockLstat.mockReturnValue({ isSymbolicLink: () => false }); expect(() => writeAgentFile('t', 'agents_md', 'c')).not.toThrow(); expect(mockWriteFile).toHaveBeenCalled(); });
  it('mutation proof: guard IS load-bearing', () => { mockLstat.mockReturnValue({ isSymbolicLink: () => true }); expect(() => writeAgentFile('t', 'agents_md', 'c')).toThrow(SharedFileSymlinkError); });
});
