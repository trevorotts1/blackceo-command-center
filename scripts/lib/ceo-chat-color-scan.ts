/**
 * ceo-chat-color-scan.ts (U60 / JM-U63b)
 *
 * PURE scanner used by both the CLI gate (`scripts/lint-ceo-chat-colors.ts`)
 * and its mutation test (`tests/unit/ceo-chat-color-lint.test.ts`). No
 * top-level side effects / process.exit — importing this module never runs
 * anything, so the test can call `findViolations()` directly.
 */
import fs from 'fs';
import path from 'path';

export const TARGET_DIRS = ['src/app/my-ai-ceo', 'src/components/ceo-chat'];
export const BANNED_COLOR_PATTERN = /\b(indigo|purple|fuchsia)-\d{2,3}\b/i;
const EXTENSIONS = new Set(['.ts', '.tsx']);

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

export interface ColorViolation {
  file: string;
  line: number;
  text: string;
}

/** Scan the two target trees for banned indigo/purple/fuchsia utility classes. */
export function findViolations(repoRoot: string): ColorViolation[] {
  const files: string[] = [];
  for (const dir of TARGET_DIRS) walk(path.join(repoRoot, dir), files);

  const violations: ColorViolation[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((lineText, i) => {
      if (BANNED_COLOR_PATTERN.test(lineText)) {
        violations.push({ file: path.relative(repoRoot, file), line: i + 1, text: lineText.trim() });
      }
    });
  }
  return violations;
}
