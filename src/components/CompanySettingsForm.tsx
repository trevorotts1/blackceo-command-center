'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Building2, Save, Check, Loader2 } from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';

export interface CompanySettingsInitial {
  companyName: string;
  commandCenterName: string;
  industry: string;
  logoUrl: string;
  brandPrimaryColor: string;
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
export default function CompanySettingsForm({ initial }: Props) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState(initial.companyName);
  const [commandCenterName, setCommandCenterName] = useState(initial.commandCenterName);
  const [industry, setIndustry] = useState(initial.industry);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [brandPrimaryColor, setBrandPrimaryColor] = useState(initial.brandPrimaryColor);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChanges =
    companyName !== initial.companyName ||
    commandCenterName !== initial.commandCenterName ||
    industry !== initial.industry ||
    logoUrl !== initial.logoUrl ||
    brandPrimaryColor !== initial.brandPrimaryColor;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/company/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          commandCenterName,
          industry,
          logoUrl,
          brandPrimaryColor,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Save failed (${res.status})`);
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
                onChange={(e) => setCompanyName(e.target.value)}
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
                onChange={(e) => setCommandCenterName(e.target.value)}
                placeholder="Zero Human Company Command Center"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Shown in the header and browser tab title.
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
                <input
                  type="color"
                  value={brandPrimaryColor || '#43A047'}
                  onChange={(e) => setBrandPrimaryColor(e.target.value)}
                  className="h-10 w-12 border border-gray-300 rounded-lg cursor-pointer"
                />
                <input
                  type="text"
                  value={brandPrimaryColor}
                  onChange={(e) => setBrandPrimaryColor(e.target.value)}
                  placeholder="#43A047"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
