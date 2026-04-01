'use client';

import { Terminal, CheckCircle, GitPullRequest, AlertCircle } from 'lucide-react';

interface RepositoryStatusCardProps {
  repoName?: string;
  version?: string;
  pullRequests?: number;
  openIssues?: number;
  buildNumber?: number;
  buildDuration?: string;
  buildTime?: string;
  buildSuccess?: boolean;
}

export function RepositoryStatusCard({
  repoName = 'luminous-core-api',
  version = 'v4.2.1-stable',
  pullRequests = 14,
  openIssues = 3,
  buildNumber = 2904,
  buildDuration = '4m 32s',
  buildTime = '2 mins ago',
  buildSuccess = true,
}: RepositoryStatusCardProps) {
  const prPercent = Math.min(pullRequests * 5, 100);
  const issuePercent = Math.min(openIssues * 5, 100);

  return (
    <div className="space-y-4">
      {/* Top Repository */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
        <h5 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Top Repository</h5>
        <div className="flex items-center gap-3 mb-5">
          <div className="w-11 h-11 bg-gray-50 rounded-xl flex items-center justify-center border border-gray-200">
            <Terminal className="h-5 w-5 text-brand-600" />
          </div>
          <div>
            <p className="font-bold text-gray-900">{repoName}</p>
            <p className="text-xs text-gray-400">{version}</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between text-sm mb-1.5">
              <span className="text-gray-500 flex items-center gap-1.5">
                <GitPullRequest className="h-3.5 w-3.5" />
                Pull Requests
              </span>
              <span className="font-bold text-gray-900">{pullRequests}</span>
            </div>
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                style={{ width: `${prPercent}%` }}
              />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between text-sm mb-1.5">
              <span className="text-gray-500 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                Open Issues
              </span>
              <span className="font-bold text-gray-900">{openIssues}</span>
            </div>
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-rose-400 rounded-full transition-all duration-500"
                style={{ width: `${issuePercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Recent Build */}
      <div className="bg-gray-50 rounded-2xl border border-gray-100 p-5">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Recent Build</p>
        <div className="flex items-center gap-2">
          <CheckCircle className={`h-4 w-4 ${buildSuccess ? 'text-emerald-500' : 'text-rose-500'}`} style={{ fontVariationSettings: "'FILL' 1" } as React.CSSProperties} />
          <span className={`text-sm font-bold ${buildSuccess ? 'text-emerald-600' : 'text-rose-600'}`}>
            {buildSuccess ? 'Success' : 'Failed'} #{buildNumber}
          </span>
        </div>
        <p className="text-xs text-gray-400 mt-1.5">
          Completed in {buildDuration} &middot; {buildTime}
        </p>
      </div>
    </div>
  );
}
