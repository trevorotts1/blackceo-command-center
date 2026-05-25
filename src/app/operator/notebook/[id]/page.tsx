/**
 * /operator/notebook/[id] - single notebook detail page.
 *
 * Track B5 (PRD Section 4.6). Thin server-component shell over the
 * `NotebookDetail` client component.
 */

import type { Metadata } from 'next';
import NotebookDetail from '@/components/operator/NotebookDetail';

export const metadata: Metadata = {
  title: 'Notebook - Operator Console',
  description: 'NotebookLM-style document Q&A grounded in your sources.',
};

interface PageProps {
  params: { id: string };
}

export default function NotebookDetailPage({ params }: PageProps) {
  return <NotebookDetail notebookId={params.id} />;
}
