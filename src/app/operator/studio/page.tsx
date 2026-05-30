/**
 * /operator/studio
 *
 * Operator Studio landing page. Image, video, and audio generation backed by
 * the model registry (Track C1) + provider connectors (Track C2). Async jobs
 * driven by `POST /api/operator/studio/generate` and polled via
 * `GET /api/operator/studio/jobs/[id]`.
 *
 * Track B4 (PRD Section 4.5).
 */

import StudioCanvas from '@/components/operator/StudioCanvas';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';
import ModuleHealthDot from '@/components/operator/ModuleHealthDot';
import { availableModels, type StudioKind, type StudioModelOption } from '@/lib/studio/generators';

export const dynamic = 'force-dynamic';

export default async function OperatorStudioPage() {
  const initialModels: Record<StudioKind, StudioModelOption[]> = {
    image: availableModels('image'),
    video: availableModels('video'),
    audio: availableModels('audio'),
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight text-bcc-text flex items-center gap-3">
            Studio
            <ModuleHealthDot module="studio" showLabel />
          </h1>
          <OperatorHelpButton card="studio" />
        </div>
        <p className="text-sm text-bcc-text-secondary max-w-3xl">
          Generate images, videos, and audio with the providers wired into your model registry. Outputs land in
          the vault under <code className="font-mono text-[12px] text-bcc-text">studio/&lt;type&gt;/YYYY/MM/</code>.
        </p>
      </header>
      <StudioCanvas initialModels={initialModels} />
    </div>
  );
}
