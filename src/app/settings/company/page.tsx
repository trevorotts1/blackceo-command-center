import fs from 'fs';
import path from 'path';
import CompanySettingsForm, { type CompanySettingsInitial } from '@/components/CompanySettingsForm';
import { getClientContext } from '@/lib/clients';

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

  // D1/D3: the selected client tenant record is the source of truth for brand
  // color + logo when set; fall back to company-config.json.
  let clientBrandColor: string | null = null;
  let clientBrandSecondaryColor: string | null = null;
  let clientLogoUrl: string | null = null;
  try {
    const client = getClientContext();
    clientBrandColor = client?.brand_color ?? null;
    clientBrandSecondaryColor = client?.brand_secondary_color ?? null;
    clientLogoUrl = client?.logo_url ?? null;
  } catch {
    // ignore — no clients table yet / outside request scope
  }

  const initial: CompanySettingsInitial = {
    companyName: typeof raw.companyName === 'string' ? raw.companyName : '',
    commandCenterName:
      typeof raw.commandCenterName === 'string' && raw.commandCenterName
        ? raw.commandCenterName
        : 'Zero Human Company Command Center',
    industry: typeof raw.industry === 'string' ? raw.industry : '',
    logoUrl:
      clientLogoUrl ||
      (typeof raw.logoUrl === 'string' && raw.logoUrl) ||
      (typeof branding.logoUrl === 'string' && branding.logoUrl) ||
      '',
    brandPrimaryColor:
      clientBrandColor ||
      (typeof raw.brandPrimaryColor === 'string' && raw.brandPrimaryColor) ||
      (typeof branding.primaryColor === 'string' && branding.primaryColor) ||
      '',
    brandSecondaryColor:
      clientBrandSecondaryColor ||
      (typeof raw.brandSecondaryColor === 'string' && raw.brandSecondaryColor) ||
      (typeof branding.secondaryColor === 'string' && branding.secondaryColor) ||
      '',
  };

  return <CompanySettingsForm initial={initial} />;
}
