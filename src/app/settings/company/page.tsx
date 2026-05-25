import fs from 'fs';
import path from 'path';
import CompanySettingsForm, { type CompanySettingsInitial } from '@/components/CompanySettingsForm';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /settings/company — company white-label settings (Bug 5, v4.0.2).
 *
 * Server component. Reads config/company-config.json and hands the editable
 * subset to the client form. Edits are POSTed to /api/company/config which
 * writes back to the same file and invalidates the in-process cache.
 */
export default function CompanySettingsPage() {
  const configPath = path.join(process.cwd(), 'config', 'company-config.json');

  let raw: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // fall through with empty defaults
  }

  const branding = (raw.branding ?? {}) as Record<string, unknown>;

  const initial: CompanySettingsInitial = {
    companyName: typeof raw.companyName === 'string' ? raw.companyName : '',
    commandCenterName:
      typeof raw.commandCenterName === 'string' && raw.commandCenterName
        ? raw.commandCenterName
        : 'Zero Human Company Command Center',
    industry: typeof raw.industry === 'string' ? raw.industry : '',
    logoUrl:
      (typeof raw.logoUrl === 'string' && raw.logoUrl) ||
      (typeof branding.logoUrl === 'string' && branding.logoUrl) ||
      '',
    brandPrimaryColor:
      (typeof raw.brandPrimaryColor === 'string' && raw.brandPrimaryColor) ||
      (typeof branding.primaryColor === 'string' && branding.primaryColor) ||
      '',
  };

  return <CompanySettingsForm initial={initial} />;
}
