// Candidate artifact references only; full PRES-049 acceptance remains pending.
// WF21 frozen-package compat refs (presentation-department 0.1.0).
// Versioned API/event contract references to the EXACT artifact digest.
// No behavior change: these constants let CC verify it talks to the frozen
// engine build. Consumer cutover stays gated on W6 installed acceptance
// (STANDALONE-SKILL-REPO.md step 5); until then CC keeps current behavior.

export const PRESENTATION_PACKAGE_VERSION = '0.1.0' as const;
export const PRESENTATION_PACKAGE_WHEEL_SHA256 = '0388e47b48644eea62c57ac18256d0618273ebc51dd3d735c84452dff1b28f2b' as const;
export const PRESENTATION_PACKAGE_SDIST_SHA256 = 'dd481aca8e5f971f79281c5d566a9e29b061ce47e91aa572879fd5f07e70e484' as const;
export const PRESENTATION_PACKAGE_PLUGIN_ZIP_SHA256 = '7283233e8efb02d7bf8c723d9ad147c742e8e5f834f1516826244de99bde31d3' as const;
export const PRESENTATION_MANIFEST_VERSION = 68 as const;
export const PRESENTATION_MANIFEST_PHASES = 62 as const;
export const PRESENTATION_MANIFEST_SHA256 = 'cab872039b2dac96bc78300a2158487ee7093e84d55a71069285789ca369f5de' as const;

// API contract: CC dispatches engine verbs init/start/status/resume/cancel/
// verify/export via the `presentation` console entrypoint
// (presentation_department.cli:main). Event contract: engine state.json
// schema_version 1 (job_id/run_dir/manifest pin/terminal/phases/gates).
// Exit codes 0-15 per interface-freeze; scanned-zero (10/13/14) is
// UNDETERMINED, never a pass.
export const PRESENTATION_ENGINE_VERBS = [
  'init',
  'doctor',
  'start',
  'status',
  'resume',
  'cancel',
  'verify',
  'export',
] as const;
