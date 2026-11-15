/** Skill 30 policy. The client approval is runtime data, never a bundled voice ID. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import policy from '../../../config/fish-audio-policy.vendored.json';
import { resolveOpenClawRuntimeRoot } from '../openclaw/runtime-root';

export class FishAudioConfigError extends Error {}

function present(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && !/[<>\r\n]/.test(value);
}

export function resolveFishAudioConfig(voiceOverride?: string, env: NodeJS.ProcessEnv = process.env) {
  const apiKey = (env.FISH_AUDIO_API_KEY || '').trim();
  const voiceId = (env.FISH_AUDIO_VOICE_ID || '').trim();
  const companyId = (env.MC_COMPANY_ID || '').trim();
  const model = (env.FISH_AUDIO_MODEL ?? policy.default_model).trim();
  for (const [name, value] of [['FISH_AUDIO_API_KEY', apiKey], ['FISH_AUDIO_VOICE_ID', voiceId], ['MC_COMPANY_ID', companyId]]) {
    if (!present(value)) throw new FishAudioConfigError(`${name} is missing or invalid`);
  }
  if (policy.invalid_company_ids.includes(companyId.toLowerCase())) {
    throw new FishAudioConfigError('MC_COMPANY_ID must identify a provisioned client');
  }
  if (!policy.allowed_models.includes(model)) {
    throw new FishAudioConfigError('FISH_AUDIO_MODEL is not an approved production model');
  }
  const file = env.FISH_AUDIO_VOICE_BINDING_FILE ?? path.join(resolveOpenClawRuntimeRoot(), policy.voice_binding_file);
  if (!path.isAbsolute(file)) throw new FishAudioConfigError('FISH_AUDIO_VOICE_BINDING_FILE must be an absolute path');
  let binding: Record<string, unknown>;
  try {
    binding = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new FishAudioConfigError('Fish Audio voice approval file is missing or invalid');
  }
  if (!binding || Array.isArray(binding) || binding.schema_version !== 1) {
    throw new FishAudioConfigError('Fish Audio voice approval is missing or invalid');
  }
  if (!present(binding.approval_ref)) {
    throw new FishAudioConfigError('Fish Audio voice approval needs an independent approval reference');
  }
  if (binding.company_id !== companyId) {
    throw new FishAudioConfigError('Fish Audio voice approval belongs to a different company');
  }
  if (typeof binding.voice_id_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.voice_id_sha256)) {
    throw new FishAudioConfigError('Fish Audio approved voice fingerprint is invalid');
  }
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  if (fingerprint(voiceId) !== binding.voice_id_sha256) {
    throw new FishAudioConfigError('FISH_AUDIO_VOICE_ID does not match the independently approved client voice');
  }
  if (voiceOverride !== undefined && fingerprint(voiceOverride) !== binding.voice_id_sha256) {
    throw new FishAudioConfigError('Fish Audio voice override does not match the approved client voice');
  }
  return { apiKey, voiceId, model };
}
