/**
 * Settings Page — hub for Command Center configuration surfaces.
 *
 * HONESTY FIX (v4.63): this page used to be a form that read/wrote
 * `workspaceBasePath`, `projectsPath`, `defaultProjectName`, and
 * `missionControlUrl` to localStorage via src/lib/config.ts's old
 * getConfig()/updateConfig(). NONE of those fields had a server consumer of
 * the UI value — the server exclusively reads the corresponding env vars
 * (see src/lib/config.ts), and `defaultProjectName` had zero consumers
 * anywhere at all. So "Save Changes" always showed success while changing
 * nothing real. Rather than keep a Save button that lies, this page is now
 * a hub: links to the settings surfaces that DO persist to something the
 * server reads (Intelligence Settings → agent_settings table, Company
 * Settings → config/company-config.json + the client record), plus a
 * read-only reference for the env vars that actually control paths/URLs.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, FolderOpen, Brain, Building2, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';

export default function SettingsPage() {
  const router = useRouter();
  const [showEnvVars, setShowEnvVars] = useState(false);

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-4xl mx-auto px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto p-8 space-y-8">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Settings' },
          ]}
        />

        {/* Intelligence Settings link */}
        <section
          onClick={() => router.push('/settings/intelligence')}
          className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm cursor-pointer hover:shadow-md transition-all group"
        >
          <div className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 flex-shrink-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-xl flex items-center justify-center">
                  <Brain className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-card-title text-gray-900">Intelligence Settings</h2>
                  <p className="text-base text-gray-600">Manage which AI models and personas power each department and role</p>
                </div>
              </div>
              <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-brand-600 group-hover:translate-x-1 transition-all flex-shrink-0" />
            </div>
          </div>
        </section>

        {/* Company Settings link */}
        <section
          onClick={() => router.push('/settings/company')}
          className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm cursor-pointer hover:shadow-md transition-all group"
        >
          <div className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 flex-shrink-0 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-xl flex items-center justify-center">
                  <Building2 className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-card-title text-gray-900">Company Settings</h2>
                  <p className="text-base text-gray-600">Company name, industry, logo, and brand colors</p>
                </div>
              </div>
              <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-brand-600 group-hover:translate-x-1 transition-all flex-shrink-0" />
            </div>
          </div>
        </section>

        {/* Environment Variables reference — read-only, collapsible */}
        <section className="bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowEnvVars(!showEnvVars)}
            className="w-full px-6 py-4 flex items-center justify-between gap-3 text-left hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-1 h-6 rounded-full bg-gray-400 flex-shrink-0" />
              <FolderOpen className="w-5 h-5 text-gray-500 flex-shrink-0" />
              <h2 className="text-card-title text-gray-900">Server configuration (env vars)</h2>
            </div>
            {showEnvVars ? (
              <ChevronUp className="w-5 h-5 text-gray-400 flex-shrink-0" />
            ) : (
              <ChevronDown className="w-5 h-5 text-gray-400 flex-shrink-0" />
            )}
          </button>
          {showEnvVars && (
            <div className="px-6 pb-6 border-t border-gray-100 pt-4">
              <div className="bg-gray-50 rounded-xl p-5">
                <p className="text-sm text-gray-600 mb-4">
                  Command Center&rsquo;s paths and URLs are read directly from the server&rsquo;s
                  environment — there is no in-app editor for them. To change one, set the
                  variable (e.g. in <code className="px-1.5 py-0.5 bg-white rounded border border-gray-200 text-sm">.env.local</code>)
                  and restart the server:
                </p>
                <ul className="text-sm text-gray-600 space-y-2 ml-4 list-disc">
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">MISSION_CONTROL_URL</code> - API URL for internal orchestration calls</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">WORKSPACE_BASE_PATH</code> - Base department directory</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">PROJECTS_PATH</code> - Projects directory</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">OPENCLAW_GATEWAY_URL</code> - Gateway WebSocket URL</li>
                  <li><code className="px-2 py-0.5 bg-white rounded border border-gray-200 text-sm">OPENCLAW_GATEWAY_TOKEN</code> - Gateway auth token</li>
                </ul>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
