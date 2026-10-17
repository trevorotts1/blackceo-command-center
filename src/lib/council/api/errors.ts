/**
 * Council API error envelope and error translation (CWE-029, directive
 * Section 17.3).
 *
 * Every council route answers with the Section 17.3 envelope:
 *   success: { ok: true, data, request_id }
 *   failure: { ok: false, error: { code, message, retryable, action,
 *              request_id } }
 *
 * Error CODES are never invented at this layer. They pass through from
 * the canonical sources that own them:
 *   - CWE-003 contract codes (ContractErrorCode, for example
 *     SCHEMA_VALIDATION, INVALID_JSON, VERSION_MISMATCH),
 *   - CWE-007 authorization codes (COUNCIL_*),
 *   - CWE-006 persistence codes (PERSISTENCE_*).
 * The two codes this layer adds are named by the directive and the
 * acceptance scope themselves: FEATURE_NOT_READY (Section 17.6, an
 * unwired production endpoint) and IDEMPOTENCY_CONFLICT (the Section
 * 17.1 rule that reusing a key with a different payload returns 409).
 * This module translates lower-layer errors to HTTP statuses; it does
 * not rename their codes.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ContractError } from '../contracts';
import { CouncilAuthError } from '../auth';
import { CouncilPersistenceError } from '../store';

export interface CouncilErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    action: string;
    request_id: string;
  };
}

export interface CouncilOkEnvelope<T> {
  ok: true;
  data: T;
  request_id: string;
  meta?: Record<string, unknown>;
}

/** An error raised deliberately by the API foundation layer. */
export class CouncilApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly action: string;

  constructor(
    code: string,
    message: string,
    options: { status: number; retryable?: boolean; action: string },
  ) {
    super(message);
    this.name = 'CouncilApiError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.action = options.action;
  }
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * The typed FEATURE_NOT_READY error (Section 17.6). It names the owning
 * unit that will wire the real service, carries no identifier fields,
 * and never claims success.
 */
export function featureNotReady(owningUnit: string, surface: string): CouncilApiError {
  return new CouncilApiError(
    'FEATURE_NOT_READY',
    `${surface} is registered but its production service is not wired in the API foundation. Owning unit: ${owningUnit}. No operation was performed.`,
    { status: 501, retryable: false, action: 'wait_for_owning_unit' },
  );
}

export function idempotencyConflict(operation: string): CouncilApiError {
  return new CouncilApiError(
    'IDEMPOTENCY_CONFLICT',
    `The idempotency key for ${operation} was already used with a different payload. The conflicting request was not applied.`,
    { status: 409, retryable: false, action: 'use_a_new_idempotency_key' },
  );
}

export function schemaValidation(message: string): CouncilApiError {
  return new CouncilApiError('SCHEMA_VALIDATION', message, {
    status: 400,
    retryable: false,
    action: 'fix_request',
  });
}

const PERSISTENCE_STATUS: Record<string, { status: number; action: string }> = {
  PERSISTENCE_SESSION_NOT_FOUND: { status: 404, action: 'check_session_id' },
  PERSISTENCE_SESSION_DELETED: { status: 410, action: 'do_not_retry' },
  PERSISTENCE_STATE_CONFLICT: { status: 409, action: 'reload_and_retry' },
  PERSISTENCE_DUPLICATE_OPERATION: { status: 409, action: 'reload_and_retry' },
  PERSISTENCE_OPERATION_CONFLICT: { status: 409, action: 'do_not_retry' },
  PERSISTENCE_SCOPE_DENIED: { status: 403, action: 'check_authorization' },
  PERSISTENCE_VALIDATION_FAILED: { status: 400, action: 'fix_request' },
  PERSISTENCE_STORE_DEFERRED: { status: 503, action: 'retry_later' },
  PERSISTENCE_DIAGNOSTIC_DENIED: { status: 403, action: 'check_authorization' },
  PERSISTENCE_CONFIG_INVALID: { status: 500, action: 'contact_support' },
  PERSISTENCE_INTERNAL: { status: 500, action: 'contact_support' },
};

const AUTH_ACTIONS: Record<string, string> = {
  COUNCIL_UNAUTHENTICATED: 'sign_in',
  COUNCIL_AUTH_NOT_CONFIGURED: 'contact_support',
  COUNCIL_SCOPE_MISMATCH: 'fix_scope_claim',
  COUNCIL_CROSS_SCOPE: 'check_authorization',
  COUNCIL_PRIVATE_OWNER_REQUIRED: 'contact_owner',
  COUNCIL_PERMISSION_DENIED: 'check_authorization',
  COUNCIL_MACHINE_BINDING: 'check_authorization',
  COUNCIL_QUERY_CREDENTIAL: 'fix_request',
  COUNCIL_CSRF_REQUIRED: 'refresh_csrf_token',
  COUNCIL_SECRET_LEAK: 'contact_support',
};

interface TranslatedError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  action: string;
}

export function translateError(error: unknown): TranslatedError {
  if (error instanceof CouncilApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      action: error.action,
    };
  }
  if (error instanceof CouncilAuthError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.status >= 500,
      action: AUTH_ACTIONS[error.code] ?? 'check_authorization',
    };
  }
  if (error instanceof CouncilPersistenceError) {
    const mapped = PERSISTENCE_STATUS[error.code] ?? {
      status: 500,
      action: 'contact_support',
    };
    return {
      code: error.code,
      message: error.message,
      status: mapped.status,
      retryable: error.retryable,
      action: mapped.action,
    };
  }
  if (error instanceof ContractError) {
    return {
      code: error.code,
      message: error.message,
      status: 400,
      retryable: false,
      action: 'fix_request',
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred while serving the council request.',
    status: 500,
    retryable: false,
    action: 'contact_support',
  };
}

export function errorResponse(error: unknown, requestId: string): NextResponse {
  const translated = translateError(error);
  const body: CouncilErrorEnvelope = {
    ok: false,
    error: {
      code: translated.code,
      message: translated.message,
      retryable: translated.retryable,
      action: translated.action,
      request_id: requestId,
    },
  };
  return NextResponse.json(body, { status: translated.status });
}

export function okResponse<T>(
  data: T,
  requestId: string,
  options: { status?: number; meta?: Record<string, unknown> } = {},
): NextResponse {
  const body: CouncilOkEnvelope<T> = { ok: true, data, request_id: requestId };
  if (options.meta) body.meta = options.meta;
  return NextResponse.json(body, { status: options.status ?? 200 });
}
