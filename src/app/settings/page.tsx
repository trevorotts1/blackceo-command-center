/**
 * Settings Page
 * Configure Command Center paths, URLs, and preferences
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Save, RotateCcw, FolderOpen, Link as LinkIcon, Brain, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { getConfig, updateConfig, resetConfig, type MissionControlConfig } from '@/lib/config';
import { Breadcrumb } from '@/components/Breadcrumb';

export default function SettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<MissionControlConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEnvVars, setShowEnvVars] = useState(false);

  useEffect(() => {
    setConfig(getConfig());
  }, []);

  const handleSave = async () => {
    if (!config) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      updateConfig(config);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (confirm('Reset all settings to defaults? This cannot be undone.')) {
      resetConfig();
      setConfig(getConfig());
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  };

  const handleChange = (field: keyof MissionControlConfig, value: string) => {
    if (!config) return;
    setConfig({ ...config, [field]: value });
  };

  if (!config) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] p-8">
        <div className="max-w-4xl mx-auto space-y-12">
          {/* Header skeleton */}
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 bg-gray-200 rounded-lg animate-pulse" />
            <div className="h-9 w-32 bg-gray-200 rounded animate-pulse" />
          </div>
          {/* Intelligence Settings card skeleton */}
          <div className="rounded-2xl shadow-sm bg-white/90 backdrop-blur-md p-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gray-200 rounded-xl animate-pulse" />
              <div className="space-y-2 flex-1">
                <div className="h-5 w-48 bg-gray-200 rounded animate-pulse" />
                <div className="h-4 w-72 bg-gray-100 rounded animate-pulse" />
              </div>
            </div>
          </div>
          {/* Section skeleton */}
          <div className="rounded-2xl shadow-sm bg-white/90 backdrop-blur-md p-6 space-y-4">
            <div className="h-6 w-40 bg-gray-200 rounded animate-pulse" />
            <div className="h-4 w-64 bg-gray-100 rounded animate-pulse" />
            <div className="space-y-4 mt-4">
              <div>
                <div className="h-4 w-32 bg-gray-200 rounded mb-2 animate-pulse" />
                <div className="h-10 w-full bg-gray-100 rounded-lg animate-pulse" />
              </div>
              <div>
                <div className="h-4 w-28 bg-gray-200 rounded mb-2 animate-pulse" />
                <div className="h-10 w-full bg-gray-100 rounded-lg animate-pulse" />
              </div>
              <div>
                <div className="h-4 w-36 bg-gray-200 rounded mb-2 animate-pulse" />
                <div className="h-10 w-full bg-gray-100 rounded-lg animate-pulse" />
              </div>
            </div>
          </div>
          {/* API section skeleton */}
          <div className="rounded-2xl shadow-sm bg-white/90 backdrop-blur-md p-6 space-y-4">
            <div className="h-6 w-40 bg-gray-200 rounded animate-pulse" />
            <div className="h-4 w-56 bg-gray-100 rounded animate-pulse" />
            <div>
              <div className="h-4 w-36 bg-gray-200 rounded mb-2 animate-pulse" />
              <div className="h-10 w-full bg-gray-100 rounded-lg animate-pulse" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors"
              title="Back to Command Center"
            >
              ← Back
            </button>
            <Settings className="w-6 h-6 text-brand-600" />
            <h1 className="text-page-title text-gray-900">Settings</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600 flex items-center gap-2 font-medium transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Reset to Defaults
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-2 disabled:opacity-50 font-medium transition-colors"
            >
              <Save className="w-4 h-4" />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto p-8 space-y-12">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Settings' },
          ]}
        />

        {/* Success Message */}
        {saveSuccess && (
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm">
            ✓ Settings saved successfully
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
            ✗ {error}
          </div>
        )}

        {/* Intelligence Settings Link - Prominent at top */}
        <section
          onClick={() => router.push('/settings/intelligence')}
          className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm cursor-pointer hover:shadow-md transition-all group"
        >
          <div className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-xl flex items-center justify-center">
                  <Brain className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-card-title text-gray-900">Intelligence Settings</h2>
                  <p className="text-base text-gray-600">Manage which AI models and personas power each department and role</p>
                </div>
              </div>
              <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-brand-600 group-hover:translate-x-1 transition-all" />
            </div>
          </div>
        </section>

        {/* Department Paths */}
        <section className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
            <div className="w-1 h-6 rounded-full bg-brand-500 flex-shrink-0" />
            <div className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5 text-brand-600" />
              <h2 className="text-section text-gray-900">Department Paths</h2>
            </div>
          </div>
          <div className="p-6">
            <p className="text-base text-gray-600 mb-6">
              Configure where Command Center stores projects and deliverables.
            </p>

            <div className="space-y-6">
              <div>
                <label className="block text-label font-medium text-gray-700 mb-2">
                  Department Base Path
                </label>
                <input
                  type="text"
                  value={config.workspaceBasePath}
                  onChange={(e) => handleChange('workspaceBasePath', e.target.value)}
                  placeholder="~/Documents/Shared"
                  className="w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
                />
                <p className="text-sm text-gray-500 mt-1">
                  Base directory for all Command Center files. Use ~ for home directory.
                </p>
              </div>

              <div>
                <label className="block text-label font-medium text-gray-700 mb-2">
                  Projects Path
                </label>
                <input
                  type="text"
                  value={config.projectsPath}
                  onChange={(e) => handleChange('projectsPath', e.target.value)}
                  placeholder="~/Documents/Shared/projects"
                  className="w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
                />
                <p className="text-sm text-gray-500 mt-1">
                  Directory where project folders are created. Each project gets its own folder.
                </p>
              </div>

              <div>
                <label className="block text-label font-medium text-gray-700 mb-2">
                  Default Project Name
                </label>
                <input
                  type="text"
                  value={config.defaultProjectName}
                  onChange={(e) => handleChange('defaultProjectName', e.target.value)}
                  placeholder="command-center"
                  className="w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
                />
                <p className="text-sm text-gray-500 mt-1">
                  Default name for new projects. Can be changed per project.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* API Configuration */}
        <section className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
            <div className="w-1 h-6 rounded-full bg-blue-500 flex-shrink-0" />
            <div className="flex items-center gap-2">
              <LinkIcon className="w-5 h-5 text-blue-600" />
              <h2 className="text-section text-gray-900">API Configuration</h2>
            </div>
          </div>
          <div className="p-6">
            <p className="text-base text-gray-600 mb-6">
              Configure Command Center API URL for agent orchestration.
            </p>

            <div>
              <label className="block text-label font-medium text-gray-700 mb-2">
                Command Center URL
              </label>
              <input
                type="text"
                value={config.missionControlUrl}
                onChange={(e) => handleChange('missionControlUrl', e.target.value)}
                placeholder="http://localhost:4000"
                className="w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-brand-500 focus:border-transparent focus:outline-none"
              />
              <p className="text-sm text-gray-500 mt-1">
                URL where Command Center is running. Auto-detected by default. Change for remote access.
              </p>
            </div>
          </div>
        </section>

        {/* Environment Variables - Collapsible Advanced section */}
        <section className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowEnvVars(!showEnvVars)}
            className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-1 h-6 rounded-full bg-gray-400 flex-shrink-0" />
              <h2 className="text-card-title text-gray-900">Advanced</h2>
              <span className="text-sm text-gray-500">Environment variables</span>
            </div>
            {showEnvVars ? (
              <ChevronUp className="w-5 h-5 text-gray-400" />
            ) : (
              <ChevronDown className="w-5 h-5 text-gray-400" />
            )}
          </button>
          {showEnvVars && (
            <div className="px-6 pb-6 border-t border-gray-100 pt-4">
              <div className="bg-gray-50 rounded-xl p-5">
                <p className="text-sm text-gray-600 mb-4">
                  Some settings are also configurable via environment variables in{' '}
                  <code className="px-2 py-1 bg-white rounded border border-gray-200 text-sm">.env.local</code>:
                </p>
                <ul className="text-sm text-gray-600 space-y-2 ml-4 list-disc">
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">MISSION_CONTROL_URL</code> - API URL override</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">WORKSPACE_BASE_PATH</code> - Base department directory</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">PROJECTS_PATH</code> - Projects directory</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">OPENCLAW_GATEWAY_URL</code> - Gateway WebSocket URL</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">OPENCLAW_GATEWAY_TOKEN</code> - Gateway auth token</li>
                </ul>
                <p className="text-sm text-gray-500 mt-4">
                  Environment variables take precedence over UI settings for server-side operations.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Bottom Save Button */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-100">
          <button
            onClick={handleReset}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600 flex items-center gap-2 font-medium transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to Defaults
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-2 disabled:opacity-50 font-medium transition-colors"
          >
            <Save className="w-4 h-4" />
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
