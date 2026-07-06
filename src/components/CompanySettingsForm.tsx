'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Building2, Save, Check, Loader2 } from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';
import { resolveBrandColor } from '@/lib/branding';
import { derivePaletteFromPrimary } from '@/lib/colors';

export interface CompanySettingsInitial {
  companyName: string;
  commandCenterName: string;
  industry: string;
  logoUrl: string;
  brandPrimaryColor: string;
  /** Secondary brand color (v4.13.0). Persisted separately from primary. */
  brandSecondaryColor: string;
}

interface Props {
  initial: CompanySettingsInitial;
}

/**
 * /settings/company form (Bug 5, v4.0.2).
 *
 * Wraps the config/company-config.json subset that an operator can edit:
 *   companyName, commandCenterName ("product name"), industry, logoUrl,
 *   brandPrimaryColor.
 *
 * POSTs to /api/company/config which writes back to disk and invalidates
 * the in-process config cache.
 */
/** Derive the default product name from a company name. */
function deriveProductName(company: string): string {
  return company.trim() ? `${company.trim()} Command Center` : '';
}

export default function CompanySettingsForm({ initial }: Props) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState(initial.companyName);
  const [commandCenterName, setCommandCenterName] = useState(initial.commandCenterName);
  const [industry, setIndustry] = useState(initial.industry);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  // D1: the brand color answer can be a hex OR a color name. We keep the raw
  // text the operator typed, and resolve it to a hex (name → hex automatically).
  const [brandColorInput, setBrandColorInput] = useState(initial.brandPrimaryColor);
  const resolution = resolveBrandColor(brandColorInput);
  const brandPrimaryColor = resolution.hex ?? '';
  // Secondary color (v4.13.0): same name-or-hex logic as primary.
  const [brandSecondaryInput, setBrandSecondaryInput] = useState(initial.brandSecondaryColor);
  const secondaryResolution = resolveBrandColor(brandSecondaryInput);
  const brandSecondaryColor = secondaryResolution.hex ?? '';
  // Live palette preview (D2): complementary/analogous shades from the primary.
  const previewPalette = resolution.hex ? derivePaletteFromPrimary(resolution.hex) : null;

  // Track whether the product name has been manually edited away from its
  // derived value so we don't overwrite a deliberate customization.
  const [productNameEdited, setProductNameEdited] = useState(
    initial.commandCenterName !== '' &&
    initial.commandCenterName !== deriveProductName(initial.companyName) &&
    initial.commandCenterName !== 'Zero Human Company Command Center'
  );

  /** Auto-populate product name when company name changes (unless manually edited). */
  const handleCompanyNameChange = (v: string) => {
    setCompanyName(v);
    if (!productNameEdited) {
      setCommandCenterName(v.trim() ? deriveProductName(v) : 'Zero Human Company Command Center');
    }
  };

  const handleProductNameChange = (v: string) => {
    setCommandCenterName(v);
    // Once the operator types their own value, stop auto-deriving.
    setProductNameEdited(true);
  };

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-fatal: config/company-config.json saved fine but the live-branding
  // PATCH to the client tenant record (the ONLY path that actually drives
  // <BrandTheme/>) failed or had no client to target. Previously this was
  // swallowed with a console.warn and the button still said "Saved!" —
  // technically true (the file wrote) but misleading (branding didn't
  // change on screen). Surfaced here so the operator knows to investigate.
  const [brandWarning, setBrandWarning] = useState<string | null>(null);

  const hasChanges =
    companyName !== initial.companyName ||
    commandCenterName !== initial.commandCenterName ||
    industry !== initial.industry ||
    logoUrl !== initial.logoUrl ||
    brandColorInput !== initial.brandPrimaryColor ||
    brandSecondaryInput !== initial.brandSecondaryColor;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setBrandWarning(null);
    try {
      const res = await fetch('/api/company/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          commandCenterName,
          industry,
          logoUrl,
          // Always persist the RESOLVED hex (name → hex) to company config.
          brandPrimaryColor,
          brandSecondaryColor,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Save failed (${res.status})`);
      }

      // D1/D2/D3: also persist brand_color + logo_url on the SELECTED client
      // tenant record so <BrandTheme/> re-themes and the Header swaps the logo.
      // This PATCH is the ONLY path that actually drives live branding — if it
      // fails, or there's no client to target, config/company-config.json
      // still saved, but the operator would otherwise see a bare "Saved!"
      // that lies about branding having taken effect. Track the real outcome
      // instead of swallowing it.
      let brandFailureReason: string | null = null;
      try {
        const sel = await fetch('/api/clients', { cache: 'no-store' });
        if (sel.ok) {
          const data = await sel.json();
          const selectedId: string | null =
            (typeof data.selected_id === 'string' ? data.selected_id : null) ??
            (Array.isArray(data.clients)
              ? data.clients.find((c: { id: string; is_self: boolean }) => c.is_self)?.id ?? null
              : null);
          if (selectedId) {
            const patchRes = await fetch(`/api/clients/${selectedId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                brand_color: brandPrimaryColor || null,
                brand_secondary_color: brandSecondaryColor || null,
                ...(logoUrl ? { logo_url: logoUrl } : {}),
              }),
            });
            if (!patchRes.ok) {
              const patchBody = await patchRes.json().catch(() => ({}));
              brandFailureReason = patchBody?.error || `client update failed (${patchRes.status})`;
            }
          } else {
            brandFailureReason = 'no client selected — branding was saved to config only';
          }
        } else {
          brandFailureReason = `could not look up the selected client (${sel.status})`;
        }
      } catch (e) {
        brandFailureReason = e instanceof Error ? e.message : 'network error contacting the client record';
      }

      if (brandFailureReason) {
        console.warn('Could not persist brand to client record:', brandFailureReason);
        setBrandWarning(brandFailureReason);
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      // Refresh the server component so the next visit reads the new values.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/settings')}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors"
              title="Back to Settings"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <Building2 className="w-6 h-6 text-brand-600" />
            <h1 className="text-2xl font-bold text-gray-900">Company Settings</h1>
          </div>

          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={`px-4 py-2 rounded-lg flex items-center gap-2 font-medium transition-colors ${
              hasChanges
                ? 'bg-brand-600 text-white hover:bg-brand-700'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : saved ? (
              <Check className="w-4 h-4" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Saving...' : saved ? 'Saved!' : hasChanges ? 'Save Changes' : 'No Changes'}
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Settings', href: '/settings' },
            { label: 'Company' },
          ]}
        />

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {brandWarning && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">
            Saved to config, but live branding not applied: {brandWarning}
          </div>
        )}

        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Company identity</h2>
            <p className="text-sm text-gray-500">
              These values drive the white-label labels and brand colors across the dashboard.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Company name
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => handleCompanyNameChange(e.target.value)}
                placeholder="e.g. Acme Industries"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Product name
              </label>
              <input
                type="text"
                value={commandCenterName}
                onChange={(e) => handleProductNameChange(e.target.value)}
                placeholder="Zero Human Company Command Center"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Shown in the header and browser tab title. Auto-populated from
                the company name (e.g. &ldquo;Acme Industries Command Center&rdquo;).
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Industry
              </label>
              <input
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. saas, ecommerce, healthcare"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Logo URL
              </label>
              <input
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://example.com/logo.png"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Brand primary color
              </label>
              <div className="flex items-center gap-2">
                {/* Color picker reflects the RESOLVED hex (or BlackCEO green). */}
                <input
                  type="color"
                  value={resolution.hex || '#43A047'}
                  onChange={(e) => setBrandColorInput(e.target.value)}
                  className="h-10 w-12 border border-gray-300 rounded-lg cursor-pointer"
                  aria-label="Pick brand color"
                />
                {/* D1: accepts a hex code OR a color name. */}
                <input
                  type="text"
                  value={brandColorInput}
                  onChange={(e) => setBrandColorInput(e.target.value)}
                  placeholder="#43A047 or a color name (e.g. navy, forest green)"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono text-sm"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Know your hex code? Enter it (e.g. <span className="font-mono">#1E3A8A</span>).
                Don&apos;t? Just type the color name — &ldquo;navy&rdquo;, &ldquo;forest
                green&rdquo;, &ldquo;coral&rdquo; — and we&apos;ll convert it automatically.
              </p>
              {brandColorInput && resolution.source === 'name' && resolution.hex && (
                <p className="text-xs text-emerald-600 mt-1">
                  Resolved &ldquo;{brandColorInput}&rdquo; →{' '}
                  <span className="font-mono">{resolution.hex}</span>
                </p>
              )}
              {brandColorInput && resolution.source === 'unknown' && (
                <p className="text-xs text-amber-600 mt-1">
                  We didn&apos;t recognize that color. Enter a hex code (e.g. #1E3A8A) or a
                  common color name. The default BlackCEO green will be used until then.
                </p>
              )}
              {previewPalette && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                    Auto-derived palette
                  </p>
                  <div className="flex items-center gap-1">
                    {[
                      previewPalette.primaryColor,
                      previewPalette.primaryDark,
                      previewPalette.secondaryColor,
                      previewPalette.accent,
                      previewPalette.primaryLight,
                    ]
                      .filter(Boolean)
                      .map((c, i) => (
                        <span
                          key={i}
                          className="h-7 w-7 rounded-md border border-gray-200"
                          style={{ backgroundColor: c as string }}
                          title={c as string}
                        />
                      ))}
                  </div>
                </div>
              )}
            </div>

            {/* v4.13.0: Brand secondary color */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Brand secondary color
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={secondaryResolution.hex || (resolution.hex ? resolution.hex : '#388E3C')}
                  onChange={(e) => setBrandSecondaryInput(e.target.value)}
                  className="h-10 w-12 border border-gray-300 rounded-lg cursor-pointer"
                  aria-label="Pick brand secondary color"
                />
                <input
                  type="text"
                  value={brandSecondaryInput}
                  onChange={(e) => setBrandSecondaryInput(e.target.value)}
                  placeholder="#388E3C or a color name (e.g. navy, coral)"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono text-sm"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Used for accents, gradients, and secondary UI elements. Leave
                blank to auto-derive from the primary color.
              </p>
              {brandSecondaryInput && secondaryResolution.source === 'name' && secondaryResolution.hex && (
                <p className="text-xs text-emerald-600 mt-1">
                  Resolved &ldquo;{brandSecondaryInput}&rdquo; →{' '}
                  <span className="font-mono">{secondaryResolution.hex}</span>
                </p>
              )}
              {brandSecondaryInput && secondaryResolution.source === 'unknown' && (
                <p className="text-xs text-amber-600 mt-1">
                  We didn&apos;t recognize that color. Enter a hex code or a common
                  color name. The auto-derived analogous shade will be used until then.
                </p>
              )}
              {brandSecondaryInput && secondaryResolution.hex && (
                <div className="mt-3 flex items-center gap-2">
                  <span
                    className="h-7 w-7 rounded-md border border-gray-200"
                    style={{ backgroundColor: secondaryResolution.hex }}
                    title={secondaryResolution.hex}
                  />
                  <span className="text-xs text-gray-500 font-mono">{secondaryResolution.hex}</span>
                  <span className="text-xs text-gray-400">secondary</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
