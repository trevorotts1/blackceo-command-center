/**
 * The ONE installed-provider route adapter used by both the single-operation
 * transport and the composed canonical engine (CTR-191).
 *
 * Route law: the route snapshot frozen on the approved run grant is the exact
 * route. `selectionSource` must be `explicit`, `fallbackPolicy` `none`, the
 * route kind `fixed_model`, and both provider and model pinned. A combination
 * route is refused, never collapsed to a member; a model owned by another
 * provider is a mismatch, never a substitution.
 */
import { getProvider } from '@/lib/model-providers';
import type { ChatCompletionResponse } from '@/lib/model-providers/types';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';
import type { CouncilRouteSelection } from './explicit-selection';

export class CouncilRouteRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CouncilRouteRefusal';
    this.code = code;
  }
}

function refusal(code: string, message: string): never {
  throw new CouncilRouteRefusal(code, message);
}

export function assertExplicitRoute(route: CouncilRouteSelection): void {
  if (route.selectionSource !== 'explicit') {
    refusal(
      'RUN_ROUTE_NOT_EXPLICIT',
      'The run grant does not pin an explicit route; the council transport never resolves a default.',
    );
  }
  if (route.fallbackPolicy !== 'none') {
    refusal(
      'RUN_ROUTE_FALLBACK_REFUSED',
      'The run grant permits fallback; the council transport executes only the pinned route.',
    );
  }
  if (route.routeKind !== 'fixed_model') {
    refusal(
      'RUN_ROUTE_COMBINATION_UNSUPPORTED',
      'A combination route cannot be executed by one dispatch; no member is selected implicitly.',
    );
  }
  if (!route.providerSlug || !route.requestedModelOrAlias) {
    refusal(
      'RUN_ROUTE_PIN_INCOMPLETE',
      'The run grant does not pin both a provider and an exact model; nothing was dispatched.',
    );
  }
}

export function nativeModelId(route: CouncilRouteSelection): string {
  const raw = (route.requestedModelOrAlias as string).trim();
  const slug = route.providerSlug;
  if (raw.startsWith(`${slug}/`)) return raw.slice(slug.length + 1);
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const root = raw.slice(0, slash);
    if (root !== slug && getProvider(root)) {
      refusal(
        'RUN_ROUTE_MODEL_MISMATCH',
        `The pinned model belongs to provider "${root}", not the grant's provider "${slug}".`,
      );
    }
  }
  return raw;
}

export function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  for (const key of ['status', 'httpStatus', 'statusCode']) {
    if (typeof record[key] === 'number') return record[key] as number;
  }
  return null;
}

export interface ResolvedConnector {
  provider: NonNullable<ReturnType<typeof getProvider>>;
  apiKey: string;
  model: string;
}

/** Resolve the connector and its server-side credential; value returned once. */
export function resolveConfiguredConnector(route: CouncilRouteSelection): ResolvedConnector {
  assertExplicitRoute(route);
  const provider = getProvider(route.providerSlug);
  if (!provider) {
    refusal(
      'RUN_PROVIDER_NOT_REGISTERED',
      `No installed provider connector is registered for "${route.providerSlug}".`,
    );
  }
  if (typeof provider.chatCompletion !== 'function') {
    refusal(
      'RUN_PROVIDER_TRANSPORT_UNSUPPORTED',
      `The "${route.providerSlug}" connector exposes no completion transport.`,
    );
  }
  const keyResult = resolveProviderApiKey(provider);
  let apiKey: string;
  if ('localEndpoint' in keyResult) {
    apiKey = '';
  } else if (keyResult.found) {
    apiKey = keyResult.value;
  } else {
    refusal(
      'RUN_PROVIDER_CREDENTIAL_ABSENT',
      `No credential is configured for provider "${route.providerSlug}" (presence only; no value was read).`,
    );
  }
  return { provider, apiKey, model: nativeModelId(route) };
}

export type ProviderCompletion = ChatCompletionResponse;
