/**
 * Advisor pack resolution for the composed Council engine (CTR-191).
 *
 * The packs are the canonical skill's own `advisors/<seat>/` source packs,
 * read from the installed, packaged Council skill record. They are source
 * packs, never the live Council database and never client state: only
 * `briefing.md` (the seat's approved briefing prose) and `profile.json`
 * (its declared pack version) are read, and neither leaves this module.
 *
 * Resolution order (each step named, no guessing):
 *   1. COUNCIL_ADVISOR_PACK_ROOT — explicit operator override.
 *   2. <council runtime prefix>/install-record.json -> skill_dir, the
 *      record the canonical installer writes beside its release.
 *   3. <openclaw root>/skills/<dir>/manifest.json carrying
 *      "skill": "council-of-wise-elders" (packaged skill tree).
 *
 * Integrity: the root must carry manifest.json, SKILL.md and advisors/;
 * the manifest's skill name must be this skill and no seat may be missing.
 * A missing or inconsistent pack root is a TYPED refusal
 * (COUNCIL_PACKS_NOT_READY) raised BEFORE any budget reservation, so a
 * session without packs is never paid for and never reported as qualified.
 *
 * Symlinks are resolved: a root reached through a symlink is judged by its
 * physical directory, and a root that resolves inside CC's own tree is
 * refused (the packs are an install surface, not application source).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CouncilError } from './errors';
import type { SeatId } from '../contracts';

export const ADVISOR_PACK_ROOT_ENV = 'COUNCIL_ADVISOR_PACK_ROOT';
export const COUNCIL_SKILL_NAME = 'council-of-wise-elders';
export const PACKS_NOT_READY = 'COUNCIL_PACKS_NOT_READY';

export interface SeatPack {
  pack_version: string;
  briefing_text: string;
  /** SHA-256 of the exact briefing bytes supplied to the seat. */
  briefing_sha256: string;
}

function packsNotReady(message: string, detail: Record<string, unknown>): CouncilError {
  return new CouncilError(PACKS_NOT_READY, message, {
    retryable: false,
    exitCode: 3,
    action: `Install the ${COUNCIL_SKILL_NAME} skill (or set ${ADVISOR_PACK_ROOT_ENV}) and retry.`,
    ...detail,
  });
}

function openclawRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_ROOT;
  if (explicit && explicit.trim().length > 0) return resolve(explicit);
  return join(env.HOME ?? homedir(), '.openclaw');
}

function runtimePrefix(env: NodeJS.ProcessEnv): string {
  const explicit = env.COUNCIL_RUNTIME_PREFIX;
  if (explicit && explicit.trim().length > 0) return resolve(explicit);
  return join(openclawRoot(env), 'council-runtime');
}

/** A packaged skill folder: SKILL.md beside advisors/ and manifest.json. */
function isSkillFolder(dir: string): boolean {
  return (
    existsSync(join(dir, 'SKILL.md')) &&
    existsSync(join(dir, 'advisors')) &&
    existsSync(join(dir, 'manifest.json'))
  );
}

function manifestSkillName(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      skill?: unknown;
    };
    return typeof manifest.skill === 'string' ? manifest.skill : null;
  } catch {
    return null;
  }
}

function recordedSkillDir(dir: string): string | null {
  const recordPath = join(dir, 'install-record.json');
  if (!existsSync(recordPath)) return null;
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { skill_dir?: unknown };
    if (typeof record.skill_dir !== 'string' || record.skill_dir.length === 0) return null;
    const candidate = resolve(record.skill_dir);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the installed advisor pack root, or null when this box has no
 * installed Council skill. Every source it consulted is reported by
 * `describePackSources` for readiness surfaces.
 */
export function resolveAdvisorPackRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[ADVISOR_PACK_ROOT_ENV];
  if (explicit && explicit.trim().length > 0) {
    const dir = resolve(explicit);
    return existsSync(dir) ? dir : null;
  }
  const recorded = recordedSkillDir(runtimePrefix(env));
  if (recorded) return recorded;
  const skillsRoot = join(openclawRoot(env), 'skills');
  if (!existsSync(skillsRoot)) return null;
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsRoot, entry.name);
    if (!isSkillFolder(dir)) continue;
    if (manifestSkillName(dir) === COUNCIL_SKILL_NAME) return dir;
  }
  return null;
}

/** Named sources consulted by the resolver (negative results carry them). */
export function describePackSources(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    `${ADVISOR_PACK_ROOT_ENV} override`,
    join(runtimePrefix(env), 'install-record.json'),
    join(openclawRoot(env), 'skills', '*', 'manifest.json'),
  ];
}

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Refuse a pack root that lives inside the application tree. */
function assertOutsideApplication(root: string): void {
  const here = physicalPath(dirname(new URL(import.meta.url).pathname));
  const appRoot = physicalPath(resolve(here, '../../../../..'));
  const physical = physicalPath(root);
  const rel = relative(appRoot, physical);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw packsNotReady(
      `The advisor pack root ${root} resolves inside the application tree (${appRoot}); Council packs are an install surface, never application source.`,
      { pack_root: root, application_root: appRoot },
    );
  }
}

interface PackHeader {
  seat_id: string;
  pack_version: string;
}

function readProfileVersion(seatDir: string): string | null {
  const profilePath = join(seatDir, 'profile.json');
  if (!existsSync(profilePath)) return null;
  try {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { version?: unknown };
    return typeof profile.version === 'string' && profile.version.length > 0
      ? profile.version
      : null;
  } catch {
    return null;
  }
}

/** Every seat pack the root actually declares, verified before use. */
function readPackHeaders(root: string): PackHeader[] {
  const advisorsDir = join(root, 'advisors');
  if (!existsSync(advisorsDir) || !statSync(advisorsDir).isDirectory()) {
    throw packsNotReady(`The advisor pack root ${root} carries no advisors/ directory.`, {
      pack_root: root,
    });
  }
  const seats = readdirSync(advisorsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const headers: PackHeader[] = [];
  for (const seatId of seats) {
    const seatDir = join(advisorsDir, seatId);
    if (!existsSync(join(seatDir, 'briefing.md'))) continue;
    const version = readProfileVersion(seatDir);
    if (version === null) {
      throw packsNotReady(
        `Seat pack ${seatId} has no readable profile.json version; an unversioned pack is not a resolvable pack.`,
        { pack_root: root, seat_id: seatId },
      );
    }
    headers.push({ seat_id: seatId, pack_version: version });
  }
  if (headers.length === 0) {
    throw packsNotReady(
      `The advisor pack root ${root} declares no seat pack with a briefing.md.`,
      { pack_root: root },
    );
  }
  return headers;
}

/**
 * Load ONE seat's briefing from the installed canonical pack root.
 *
 * Throws COUNCIL_PACKS_NOT_READY when no root resolves or the seat has no
 * pack; the caller raises this before reserving budget, so an unpacks
 * session never spends. Returns the verified pack version and the exact
 * briefing bytes' digest beside the text.
 */
export function loadAdvisorPack(
  seatId: SeatId,
  env: NodeJS.ProcessEnv = process.env,
): SeatPack {
  const root = resolveAdvisorPackRoot(env);
  if (root === null) {
    throw packsNotReady(
      `No installed ${COUNCIL_SKILL_NAME} skill was found. Consulted: ${describePackSources(env).join(', ')}.`,
      { consulted: describePackSources(env) },
    );
  }
  assertOutsideApplication(root);
  const manifestName = manifestSkillName(root);
  if (manifestName !== COUNCIL_SKILL_NAME) {
    throw packsNotReady(
      `The advisor pack root ${root} is not the canonical skill (manifest skill: ${manifestName ?? 'unreadable'}).`,
      { pack_root: root, manifest_skill: manifestName },
    );
  }
  const headers = readPackHeaders(root);
  const header = headers.find((h) => h.seat_id === seatId);
  if (!header) {
    throw packsNotReady(
      `The installed skill at ${root} has no pack for seat ${seatId}; packs present: ${headers
        .map((h) => h.seat_id)
        .join(', ')}.`,
      { pack_root: root, seat_id: seatId, packs: headers.map((h) => h.seat_id) },
    );
  }
  const briefingPath = join(root, 'advisors', seatId, 'briefing.md');
  const bytes = readFileSync(briefingPath);
  if (bytes.length === 0) {
    throw packsNotReady(`Seat pack ${seatId} briefing.md is empty.`, {
      pack_root: root,
      seat_id: seatId,
    });
  }
  return {
    pack_version: header.pack_version,
    briefing_text: bytes.toString('utf8'),
    briefing_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Readiness view of the pack root: named root, or the sources consulted. */
export function packReadiness(env: NodeJS.ProcessEnv = process.env): {
  ready: boolean;
  root: string | null;
  detail: string;
} {
  try {
    const root = resolveAdvisorPackRoot(env);
    if (root === null) {
      return {
        ready: false,
        root: null,
        detail: `no installed skill; consulted ${describePackSources(env).join(', ')}`,
      };
    }
    assertOutsideApplication(root);
    const headers = readPackHeaders(root);
    return {
      ready: true,
      root,
      detail: `${headers.length} seat packs at ${root}`,
    };
  } catch (error) {
    return {
      ready: false,
      root: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Directory the loader would use, for readiness surfaces and digests. */
export function packRootForDigest(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = resolveAdvisorPackRoot(env);
  return root === null ? null : physicalPath(root);
}

