'use client';

/**
 * /operator/call
 *
 * Track B8 (SCOPE-ADDITION Section 6).
 *
 * The canonical Call Mode surface lives inline next to the Bridge mic
 * (Track B2 owns BridgeChat.tsx). This standalone route is the secondary
 * entry point: the Operator landing tile and the sidebar both link here,
 * and Cmd K navigates here as well. The route immediately mounts the
 * full-screen CallMode modal. End call returns to the operator landing.
 */

import { useRouter } from 'next/navigation';
import CallMode from '@/components/operator/CallMode';

export default function OperatorCallPage() {
  const router = useRouter();
  return (
    <CallMode
      onClose={() => {
        router.push('/operator');
      }}
    />
  );
}
