import fs from 'fs';
import path from 'path';
import CompanySettingsForm, { type CompanySettingsInitial } from '@/components/CompanySettingsForm';
import { getClientContext } from '@/lib/clients';
import { loadCompanyConfig, invalidateCompanyConfigCache } from '@/lib/company-config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /settings/company — company white-label settings (Bug 5, v4.0.2).
 *
 * Server component. Reads config/company-config.json and hands the editable
 * subset to the client form. Edits are POSTed to /api/company/config which
 * writes back to the same file and invalidates the in-process cache.
 *
 * v4.63: brandPrimaryColor/brandSecondaryColor/logoUrl now come from
 * loadCompanyConfig() (src/lib/company-config.ts) instead of a second, ad
 * hoc raw-JSON parse of the same file done here. loadCompanyConfig()
 * previously wrote-but-never-read-back these fields, so this page had to
 * duplicate the parsing itself; now the canonical loader carries them and
 * this page (and any future caller) reads the same source of truth.
 * companyName/commandCenterName/industry keep their existing raw-file
 * read/defaults unchanged (loadCompanyConfig() applies a different default
 * for an unset companyName, which would have changed this form's blank vs.
 * pre-filled behavior for that field).
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

  invalidateCompanyConfigCache(); // always read fresh — mirrors GET /api/company/config
  const persisted = loadCompanyConfig();

  // D1/D3: the selected client tenant record is the source of truth for brand
  // color + logo when set; fall back to the persisted company-config.json values.
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
    logoUrl: clientLogoUrl || persisted.logoUrl,
    brandPrimaryColor: clientBrandColor || persisted.brandPrimaryColor,
    brandSecondaryColor: clientBrandSecondaryColor || persisted.brandSecondaryColor,
  };

  return <CompanySettingsForm initial={initial} />;
}
