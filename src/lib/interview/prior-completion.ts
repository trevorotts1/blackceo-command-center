import { queryOne, run } from '@/lib/db';
import type { TenantContext, TenantRegistration } from '@/lib/auth/tenant-context';

type Scope = Pick<TenantRegistration, 'tenantId' | 'companyId' | 'installationId'>;
export interface PriorCompletionDeclaration {
  declaredBy: string;
  declaredAt: string;
  source: 'owner-self-attestation';
}

/** Durable shell admission only. Never transcript, QC, or workforce build evidence. */
export function priorCompletion(scope: Scope): PriorCompletionDeclaration | null {
  return queryOne<PriorCompletionDeclaration>(`SELECT declared_by AS declaredBy,
    declared_at AS declaredAt, source FROM interview_prior_completion_declarations
    WHERE tenant_id=? AND company_id=? AND installation_id=?`,
  [scope.tenantId, scope.companyId, scope.installationId]) ?? null;
}

export function declarePriorCompletion(context: TenantContext): PriorCompletionDeclaration {
  run(`INSERT OR IGNORE INTO interview_prior_completion_declarations
    (tenant_id,company_id,installation_id,declared_by,declared_at,source)
    VALUES (?,?,?,?,?,'owner-self-attestation')`,
  [context.tenantId, context.companyId, context.installationId, context.subject, new Date().toISOString()]);
  const saved = priorCompletion(context);
  if (!saved) throw new Error('Prior completion declaration was not saved');
  return saved;
}
