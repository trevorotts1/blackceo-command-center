/**
 * Company Configuration Loader
 *
 * Loads company-config.json and exposes typed access to:
 * - Company name
 * - Industry
 * - KPIs to display
 * - Industry benchmarks
 * - Grading weights
 * - Department list
 * - Connected systems
 */

import fs from 'fs';
import path from 'path';
import type { GradeWeights } from './grade-calculator';
import { DEFAULT_GRADE_WEIGHTS } from './grade-calculator';
import { DEFAULT_INPUT_WEIGHTS, type GradeInputKey } from './grading';

export interface CompanyKpi {
  id: string;
  name: string;
  target: number;
  unit: string;
  icon?: string;
}

export interface ConnectedSystems {
  payment: string;
  crm: string;
  email: string;
  social: string;
}

export interface CompanyDepartment {
  slug: string;
  name: string;
  icon?: string;
}

export interface CompanyConfig {
  companyName: string;
  industry: string;
  commandCenterName: string;
  createdAt: string;
  connectedSystems: ConnectedSystems;
  companyKPIs: CompanyKpi[];
  /** Legacy 4-factor weights — kept for shim; use gradingInputWeights for PRD 2.10 grading */
  gradingWeights: GradeWeights;
  /** PRD 2.10: weights for the four observable DB inputs (throughput/qcPassRate/sopCoverage/kpiAttainment) */
  gradingInputWeights?: Record<GradeInputKey, number>;
  /** PRD 2.10: rolling window in days for grading computations (default 30) */
  gradingWindowDays?: number;
  departments: CompanyDepartment[];
}

/** Cached config to avoid repeated file reads */
let cachedConfig: CompanyConfig | null = null;

/**
 * Load company-config.json from the config/ directory.
 * Falls back to defaults where values are missing.
 */
export function loadCompanyConfig(): CompanyConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = path.join(process.cwd(), 'config', 'company-config.json');

  let raw: Partial<CompanyConfig> = {};

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      raw = JSON.parse(content);
    }
  } catch (err) {
    console.error('Failed to load company-config.json:', err);
  }

  // Merge with defaults — every field has a safe fallback
  const config: CompanyConfig = {
    companyName: raw.companyName || process.env.COMPANY_NAME || 'Command Center',
    industry: raw.industry || 'general',
    commandCenterName: raw.commandCenterName || 'Command Center',
    createdAt: raw.createdAt || new Date().toISOString(),
    connectedSystems: {
      payment: raw.connectedSystems?.payment || 'none',
      crm: raw.connectedSystems?.crm || 'none',
      email: raw.connectedSystems?.email || 'none',
      social: raw.connectedSystems?.social || 'none',
    },
    companyKPIs: Array.isArray(raw.companyKPIs) && raw.companyKPIs.length > 0
      ? raw.companyKPIs
      : [],
    gradingWeights: {
      kpiAchievement: raw.gradingWeights?.kpiAchievement ?? DEFAULT_GRADE_WEIGHTS.kpiAchievement,
      agentPerformance: raw.gradingWeights?.agentPerformance ?? DEFAULT_GRADE_WEIGHTS.agentPerformance,
      daCompliance: raw.gradingWeights?.daCompliance ?? DEFAULT_GRADE_WEIGHTS.daCompliance,
      recommendationFollowThrough: raw.gradingWeights?.recommendationFollowThrough ?? DEFAULT_GRADE_WEIGHTS.recommendationFollowThrough,
    },
    // PRD 2.10: per-input weights for the new grading module. Safe defaults = equal weighting per spec.
    gradingInputWeights: raw.gradingInputWeights
      ? {
          throughput: raw.gradingInputWeights.throughput ?? DEFAULT_INPUT_WEIGHTS.throughput,
          qcPassRate: raw.gradingInputWeights.qcPassRate ?? DEFAULT_INPUT_WEIGHTS.qcPassRate,
          sopCoverage: raw.gradingInputWeights.sopCoverage ?? DEFAULT_INPUT_WEIGHTS.sopCoverage,
          kpiAttainment: raw.gradingInputWeights.kpiAttainment ?? DEFAULT_INPUT_WEIGHTS.kpiAttainment,
        }
      : undefined,
    gradingWindowDays: typeof raw.gradingWindowDays === 'number' ? raw.gradingWindowDays : undefined,
    departments: Array.isArray(raw.departments) && raw.departments.length > 0
      ? raw.departments
      : [],
  };

  cachedConfig = config;
  return config;
}

/**
 * Invalidate cached config (call after config changes).
 */
export function invalidateCompanyConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get grading weights from company config.
 */
export function getGradingWeights(): GradeWeights {
  return loadCompanyConfig().gradingWeights;
}

/**
 * Get KPIs from company config.
 * Returns empty array if none configured.
 */
export function getCompanyKPIs(): CompanyKpi[] {
  return loadCompanyConfig().companyKPIs;
}

/**
 * Get company name from config.
 */
export function getCompanyName(): string {
  return loadCompanyConfig().companyName;
}

/**
 * Get industry from config.
 */
export function getIndustry(): string {
  return loadCompanyConfig().industry;
}
