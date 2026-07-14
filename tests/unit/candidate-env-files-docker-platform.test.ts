/**
 * Unit tests for U48/U60 — Key detection: Docker `/data/.openclaw` env paths
 * + `envCandidates` completion (zai, elevenlabs, fish-audio + connector
 * sweep).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * No network, no DB. Platform is forced via `OPENCLAW_PLATFORM` (highest
 * precedence in `detectPlatform()`), so no `fs.existsSync` stub is needed to
 * select a platform.
 *
 * Covers:
 *   1. `candidateEnvFiles()` on `vps-docker` includes the persistent-volume
 *      paths `/data/.openclaw/.env` and `/data/.openclaw/secrets/.env`.
 *   2. `candidateEnvFiles()` on `mac-mini` does NOT add the Docker paths —
 *      Mac regression: both home-directory files are still scanned.
 *   3. `OPENCLAW_PROJECT_DIR` remains an additional, first-priority optional
 *      candidate on both platforms.
 *   4. End-to-end acceptance (a): on a Docker-platform box with a key present
 *      ONLY in `/data/.openclaw/.env` (OPENCLAW_PROJECT_DIR unset, key absent
 *      from process.env), `resolveProviderApiKey()` reports the provider
 *      configured with `source: 'env_file'`.
 *   5. Z.AI (b): configured when its key is stored under ANY of its new
 *      candidate names, and the candidate list carries every alias.
 *   6. ElevenLabs / Fish Audio now declare an explicit `envCandidates`.
 *   7. Connector-sweep fix: xAI's connector-documented env name
 *      (`X_AI_API_KEY`) is now checked — previously only the
 *      slug-derived `XAI_API_KEY` (the wrong canonical spelling) was.
 */

// C8 — DB isolation (see provider-key-detection.test.ts for the full
// rationale). Must stay the first import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

import { candidateEnvFiles } from '../../src/lib/studio/provider-discovery';
import {
  envCandidatesForProvider,
  resolveProviderApiKey,
} from '../../src/lib/provider-key-detection';
import { zaiProvider } from '../../src/lib/model-providers/zai';
import { elevenlabsProvider } from '../../src/lib/model-providers/elevenlabs';
import { fishAudioProvider } from '../../src/lib/model-providers/fish-audio';
import { xaiProvider } from '../../src/lib/model-providers/xai';

/** Run `fn` with `OPENCLAW_PLATFORM` forced, then restore. */
function withPlatform(platform: 'mac-mini' | 'vps-docker', fn: () => void): void {
  const saved = process.env.OPENCLAW_PLATFORM;
  process.env.OPENCLAW_PLATFORM = platform;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.OPENCLAW_PLATFORM;
    else process.env.OPENCLAW_PLATFORM = saved;
  }
}

/** Run `fn` with a temporary process.env overlay, then restore. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k] as string;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

// ── 1. vps-docker adds the persistent-volume paths ──────────────────────────

test('candidateEnvFiles() on vps-docker includes /data/.openclaw/.env + secrets/.env', () => {
  withPlatform('vps-docker', () => {
    withEnv({ OPENCLAW_PROJECT_DIR: undefined }, () => {
      const files = candidateEnvFiles();
      assert.ok(files.includes('/data/.openclaw/.env'), 'expected /data/.openclaw/.env');
      assert.ok(
        files.includes('/data/.openclaw/secrets/.env'),
        'expected /data/.openclaw/secrets/.env'
      );
    });
  });
});

// ── 2. mac-mini: no Docker paths, home-dir paths unchanged (regression) ────

test('candidateEnvFiles() on mac-mini does NOT add Docker paths; home files still scanned', () => {
  withPlatform('mac-mini', () => {
    withEnv({ OPENCLAW_PROJECT_DIR: undefined }, () => {
      const files = candidateEnvFiles();
      assert.ok(!files.includes('/data/.openclaw/.env'), 'must not add Docker .env on Mac');
      assert.ok(
        !files.includes('/data/.openclaw/secrets/.env'),
        'must not add Docker secrets/.env on Mac'
      );
      assert.ok(
        files.some((f) => f.endsWith('/.openclaw/.env')),
        'expected the Mac home ~/.openclaw/.env candidate to remain present'
      );
      assert.ok(
        files.some((f) => f.endsWith('/.openclaw/secrets/.env')),
        'expected the Mac home ~/.openclaw/secrets/.env candidate to remain present'
      );
    });
  });
});

// ── 3. OPENCLAW_PROJECT_DIR remains an additional optional candidate ───────

test('OPENCLAW_PROJECT_DIR/.env is still the first candidate on vps-docker', () => {
  withPlatform('vps-docker', () => {
    withEnv({ OPENCLAW_PROJECT_DIR: '/docker/proj' }, () => {
      const files = candidateEnvFiles();
      assert.equal(files[0], '/docker/proj/.env');
      assert.ok(files.includes('/data/.openclaw/.env'));
    });
  });
});

// ── 4. End-to-end acceptance (a): Docker box, key ONLY in /data/.openclaw/.env ─

test('acceptance (a): key present only in /data/.openclaw/.env is detected via env_file on vps-docker', () => {
  withPlatform('vps-docker', () => {
    withEnv({ OPENCLAW_PROJECT_DIR: undefined, ZAI_API_KEY: undefined, ZHIPU_API_KEY: undefined, GLM_API_KEY: undefined, Z_AI_API_KEY: undefined }, () => {
      const origExists = Object.getOwnPropertyDescriptor(fs, 'existsSync');
      const origStat = Object.getOwnPropertyDescriptor(fs, 'statSync');
      const origRead = Object.getOwnPropertyDescriptor(fs, 'readFileSync');

      Object.defineProperty(fs, 'existsSync', {
        value: (p: string) => typeof p === 'string' && p === '/data/.openclaw/.env',
        configurable: true,
        writable: true,
      });
      Object.defineProperty(fs, 'statSync', {
        value: (p: string) => ({ isFile: () => p === '/data/.openclaw/.env' }),
        configurable: true,
        writable: true,
      });
      Object.defineProperty(fs, 'readFileSync', {
        value: (p: string) => {
          if (p === '/data/.openclaw/.env') return 'ZAI_API_KEY=sk-docker-vol-key\n';
          return '{}';
        },
        configurable: true,
        writable: true,
      });

      try {
        const result = resolveProviderApiKey(zaiProvider);
        assert.ok(!('localEndpoint' in result));
        const r = result as { found: boolean; source?: string; envVar?: string };
        assert.equal(r.found, true, 'expected the Docker-volume key to be found');
        assert.equal(r.source, 'env_file', 'expected the environment-file source label');
        assert.equal(r.envVar, 'ZAI_API_KEY');
      } finally {
        if (origExists) Object.defineProperty(fs, 'existsSync', origExists);
        if (origStat) Object.defineProperty(fs, 'statSync', origStat);
        if (origRead) Object.defineProperty(fs, 'readFileSync', origRead);
        delete process.env.ZAI_API_KEY;
      }
    });
  });
});

// ── 5. Z.AI: configured under ANY new candidate name; full candidate list ──

test('Z.AI envCandidates carries every alias (ZAI/ZHIPU/GLM/Z_AI)', () => {
  const candidates = envCandidatesForProvider(zaiProvider);
  for (const name of ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY', 'Z_AI_API_KEY']) {
    assert.ok(candidates.includes(name), `expected ${name} in Z.AI candidates`);
  }
});

test('Z.AI key stored under the alternate ZHIPU_API_KEY name is detected', () => {
  withEnv(
    { ZAI_API_KEY: undefined, ZHIPU_API_KEY: 'zhipu-sk-test', GLM_API_KEY: undefined, Z_AI_API_KEY: undefined },
    () => {
      const result = resolveProviderApiKey(zaiProvider);
      assert.ok(!('localEndpoint' in result));
      const r = result as { found: boolean; envVar?: string; source?: string };
      assert.equal(r.found, true);
      assert.equal(r.envVar, 'ZHIPU_API_KEY');
      assert.equal(r.source, 'process.env');
    }
  );
});

// ── 6. ElevenLabs / Fish Audio now declare explicit envCandidates ──────────

test('ElevenLabs and Fish Audio connectors declare explicit envCandidates', () => {
  assert.deepEqual(elevenlabsProvider.envCandidates, ['ELEVENLABS_API_KEY']);
  assert.deepEqual(fishAudioProvider.envCandidates, ['FISH_AUDIO_API_KEY']);
});

// ── 7. Connector sweep: xAI's documented X_AI_API_KEY is now checked ───────

test('xAI envCandidates includes the connector-documented X_AI_API_KEY (sweep fix)', () => {
  const candidates = envCandidatesForProvider(xaiProvider);
  assert.ok(candidates.includes('X_AI_API_KEY'), 'expected X_AI_API_KEY (connector-documented name)');
  assert.equal(candidates[0], 'X_AI_API_KEY', 'canonical name must be checked first');
});

test('xAI key stored under X_AI_API_KEY (the connector-documented name) is detected', () => {
  // Before the sweep fix, xai.ts had no envCandidates, so detection derived
  // only the slug fallback XAI_API_KEY — the WRONG canonical spelling every
  // other consumer in this repo (TTS route, Research provider, docs) never
  // uses. This proves the real key name the connector itself documents now
  // resolves.
  withEnv({ X_AI_API_KEY: 'xai-sk-test', XAI_API_KEY: undefined }, () => {
    const result = resolveProviderApiKey(xaiProvider);
    assert.ok(!('localEndpoint' in result));
    const r = result as { found: boolean; envVar?: string };
    assert.equal(r.found, true);
    assert.equal(r.envVar, 'X_AI_API_KEY');
  });
});
