import type { Metadata } from 'next';
import WorkspaceView from '@/components/operator/WorkspaceView';

export const metadata: Metadata = {
  title: 'Workspace - Operator Console',
  description: 'Per-agent scratch directories with inline file preview and output buckets.',
};

export default function OperatorWorkspacePage() {
  return <WorkspaceView />;
}
