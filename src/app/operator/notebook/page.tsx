/**
 * /operator/notebook - Notebook library landing page.
 *
 * Track B5 (PRD Section 4.6). All state lives in the client component
 * `NotebookList`. The route is intentionally a thin server-component shell
 * so the OperatorLayout (sidebar + command palette) wraps it consistently.
 */

import type { Metadata } from 'next';
import NotebookList from '@/components/operator/NotebookList';

export const metadata: Metadata = {
  title: 'Notebook - Operator Console',
  description: 'NotebookLM-style document Q&A grounded in your sources.',
};

export default function NotebookLibraryPage() {
  return <NotebookList />;
}
