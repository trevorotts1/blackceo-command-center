import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import OperatorSidebar from '@/components/OperatorSidebar';

export const metadata: Metadata = {
  title: 'Operator Console',
  description: 'Direct operator-level access to CLIs, workspaces, studio, and the vault.',
};

export default function OperatorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bcc-bg">
      <OperatorSidebar />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
