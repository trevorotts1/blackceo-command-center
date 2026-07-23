// OpenClaw Gateway WebSocket Client

import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import type { OpenClawMessage, OpenClawSessionInfo } from '../types';
import { loadOrCreateDeviceIdentity, signDevicePayload, buildDeviceAuthPayload, publicKeyRawBase64Url } from './device-identity';
import { createHash } from 'crypto';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

/**
 * Per-client connection target. A remote client supplies its own gateway URL +
 * token and a Cloudflare Access service-token header pair. The CF-Access
 * headers are sent on the WebSocket UPGRADE request — which the browser/global
 * `WebSocket` cannot do — so a target carrying CF-Access headers forces the
 * `ws` npm transport (see `connect()`).
 *
 * Shape intentionally mirrors the subset of `Client` (src/lib/clients.ts) that
 * the gateway connection needs, so callers can pass a client record straight
 * through `getOpenClawClient(clientToTarget(client))`.
 */
export interface OpenClawClientTarget {
  /** Stable id used to cache one client instance per target (client id). */
  id: string;
  url: string;
  token?: string | null;
  cfAccessClientId?: string | null;
  cfAccessClientSecret?: string | null;
}

// Global deduplication cache that persists across module reloads in Next.js dev
// Use globalThis to ensure it's shared across all instances
// Using Map for LRU (access time tracking) instead of Set
const GLOBAL_EVENT_CACHE_KEY = '__openclaw_processed_events__';
const GLOBAL_CACHE_CLEANUP_KEY = '__openclaw_cache_cleanup_timer__';

if (!(GLOBAL_EVENT_CACHE_KEY in globalThis)) {
  (globalThis as Record<string, unknown>)[GLOBAL_EVENT_CACHE_KEY] = new Map<string, number>();
}

const globalProcessedEvents = (globalThis as unknown as Record<string, Map<string, number>>)[GLOBAL_EVENT_CACHE_KEY];

// Minimal structural type covering both the DOM `WebSocket` and the `ws` npm
// library's WebSocket. Both expose these members and use identical numeric
// readyState values (CONNECTING=0, OPEN=1), so the existing
// `WebSocket.OPEN` / `WebSocket.CONNECTING` comparisons against the global
// remain valid for either transport.
type SocketLike = {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

/**
 * Minimal structural shape of an inbound gateway WebSocket frame, used only
 * by generateEventId() for content-hash deduplication. The full message shape
 * is OpenClawMessage; this covers only the fields the hash function reads.
 */
interface GatewayFrame {
  type?: unknown;
  seq?: unknown;
  payload?: Record<string, unknown> | null;
  event?: unknown;
}

// ── U020 ANTI-FURNACE: bounded reconnect backoff ─────────────────────────────
// A flapping gateway used to trigger an infinite fixed-10s reconnect loop.
// Mirrors the task-dispatcher's anti-furnace pattern (MAX_DISPATCH_ATTEMPTS,
// exponential backoff, blocked terminal state): back off exponentially, and
// after MAX_RECONNECT_ATTEMPTS consecutive failures enter a terminal "blocked"
// state and stop retrying. A successful connection resets the counter.
const MAX_RECONNECT_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '5', 10),
);
const RECONNECT_BACKOFF_BASE_MS = Math.max(
  500,
  parseInt(process.env.RECONNECT_BACKOFF_BASE_MS || '2000', 10),
);
const RECONNECT_BACKOFF_MAX_MS = Math.max(
  RECONNECT_BACKOFF_BASE_MS,
  parseInt(process.env.RECONNECT_BACKOFF_MAX_MS || '32000', 10),
);

export class OpenClawClient extends EventEmitter {
  private ws: SocketLike | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** U020: consecutive failed reconnect attempts (reset on a successful connect). */
  private reconnectAttempts = 0;
  /** U020: terminal state after MAX_RECONNECT_ATTEMPTS consecutive failures —
   *  scheduleReconnect() stops retrying until resetReconnectBackoff() is called. */
  private reconnectBlocked = false;
  private messageId = 0;
  private pendingRequests = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private connected = false;
  private authenticated = false; // Track auth state separately from connection state
  private connecting: Promise<void> | null = null; // Lock to prevent multiple simultaneous connection attempts
  private autoReconnect = true;
  private token: string;
  private deviceIdentity: { deviceId: string; publicKeyPem: string; privateKeyPem: string } | null = null;
  private lastConnectError: string | null = null;
  private lastConnectErrorAtMs = 0;
  /** True once an auto-approve attempt is in flight or has been made for the
   *  current pairing cycle, so we never loop approve→retry→approve forever. */
  private autoApproveInFlight = false;
  private autoApproveAttempted = false;
  /** One-time human-readable "pairing… approved automatically" status, surfaced
   *  to the status route in place of the raw red error after a successful
   *  self-heal. Cleared on the next successful connect. */
  private pairingAutoApprovedNote: string | null = null;
  private messageHandlers = new Set<(event: { data: unknown }) => void>(); // Track all message handlers for cleanup
  private readonly MAX_PROCESSED_EVENTS = 1000; // Limit the size of the processed events cache
  private readonly CLEANUP_THRESHOLD = 100; // Number of entries to remove when limit exceeded
  private readonly CACHE_ENTRY_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for cache entries
  private readonly PERIODIC_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Cleanup every 5 minutes
  private periodicCleanupTimer: NodeJS.Timeout | null = null;

  /**
   * Generate a unique event ID using content hashing for proper deduplication.
   * Uses SHA-256 hash of event type, sequence/run ID, and payload content.
   * This prevents collision from Date.now() and ensures events with same
   * structure but different content are not incorrectly deduplicated.
   */
  private generateEventId(data: GatewayFrame): string {
    // Create a canonical string representation of the event
    const canonical = JSON.stringify({
      type: data.type,
      seq: data.seq,
      runId: data.payload?.runId,
      stream: data.payload?.stream,
      event: data.event,
      // Include hash of payload for content-aware deduplication
      payloadHash: data.payload ? createHash('sha256').update(JSON.stringify(data.payload)).digest('hex').slice(0, 16) : null
    });

    // Hash the canonical representation for a fixed-length ID
    return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  }

  /**
   * Perform LRU cleanup of the event cache.
   * Removes the oldest entries based on access time when size exceeds limit.
   * Also removes entries older than TTL to prevent unbounded growth.
   */
  private performCacheCleanup(): void {
    const now = Date.now();
    let removed = 0;
    const initialSize = globalProcessedEvents.size;

    // First, remove expired entries (older than TTL)
    const entries = Array.from(globalProcessedEvents.entries());
    for (const [eventId, timestamp] of entries) {
      if (now - timestamp > this.CACHE_ENTRY_TTL_MS) {
        globalProcessedEvents.delete(eventId);
        removed++;
      }
    }

    // Then, if still over limit, remove oldest entries (LRU)
    if (globalProcessedEvents.size > this.MAX_PROCESSED_EVENTS) {
      const entriesToRemove = globalProcessedEvents.size - this.MAX_PROCESSED_EVENTS + this.CLEANUP_THRESHOLD;

      // Sort by access time (oldest first) and remove
      const sortedEntries = Array.from(globalProcessedEvents.entries())
        .sort((a, b) => a[1] - b[1]);

      for (const [eventId] of sortedEntries) {
        if (removed >= entriesToRemove) break;
        globalProcessedEvents.delete(eventId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[OpenClaw] Cache cleanup: removed ${removed} entries (size: ${initialSize} -> ${globalProcessedEvents.size})`);
    }
  }

  private cfAccessClientId: string | null;
  private cfAccessClientSecret: string | null;

  constructor(
    private url: string = GATEWAY_URL,
    token: string = GATEWAY_TOKEN,
    opts: { cfAccessClientId?: string | null; cfAccessClientSecret?: string | null } = {},
  ) {
    super();
    this.token = token;
    this.cfAccessClientId = opts.cfAccessClientId ?? null;
    this.cfAccessClientSecret = opts.cfAccessClientSecret ?? null;
    // Prevent Node.js from throwing on unhandled 'error' events
    this.on('error', () => {});
    // Load device identity for pairing
    try {
      this.deviceIdentity = loadOrCreateDeviceIdentity();
      console.log('[OpenClaw] Device identity loaded:', this.deviceIdentity.deviceId);
    } catch (err) {
      console.warn('[OpenClaw] Failed to load device identity, will connect without:', err);
    }
// Start periodic cleanup to prevent unbounded cache growth
    this.startPeriodicCleanup();
  }

  /**
   * Start periodic cleanup of the global event cache.
   * Uses a shared timer across all instances to avoid multiple timers.
   */
  private startPeriodicCleanup(): void {
    // Check if a cleanup timer already exists (shared across all instances)
    if (!(GLOBAL_CACHE_CLEANUP_KEY in globalThis)) {
      const timer = setInterval(() => {
        // Perform cleanup even if no new events have arrived
        this.performCacheCleanup();
      }, this.PERIODIC_CLEANUP_INTERVAL_MS);

      // Store the timer globally so all instances share it
      (globalThis as Record<string, unknown>)[GLOBAL_CACHE_CLEANUP_KEY] = timer;
      console.log('[OpenClaw] Started periodic cache cleanup (interval:', this.PERIODIC_CLEANUP_INTERVAL_MS, 'ms)');
    }

    // Keep a reference to stop it when the last instance disconnects
    this.periodicCleanupTimer = (globalThis as unknown as Record<string, NodeJS.Timeout>)[GLOBAL_CACHE_CLEANUP_KEY];
  }

  /**
   * Stop the periodic cleanup timer if this is the last instance.
   */
  private stopPeriodicCleanup(): void {
    // We don't stop the timer here since it's shared across instances
    // The timer will continue running as long as any instance exists
    // This is safe because the cleanup function is lightweight

  }

  async connect(): Promise<void> {
    // If already connected, return immediately
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // If a connection attempt is already in progress, wait for it
    if (this.connecting) {
      return this.connecting;
    }

    // Create a new connection attempt
    this.connecting = new Promise((resolve, reject) => {
      try {
        // Clean up any existing connection and handlers
        if (this.ws) {
          // Remove all tracked message handlers
          this.messageHandlers.clear();
          this.ws.onclose = null;
          this.ws.onerror = null;
          this.ws.onmessage = null;
          this.ws.onopen = null;
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
          }
          this.ws = null;
        }

        // Add token to URL query string for Gateway authentication
        const wsUrl = new URL(this.url);
        if (this.token) {
          wsUrl.searchParams.set('token', this.token);
        }
        console.log('[OpenClaw] Connecting to:', wsUrl.toString().replace(/token=[^&]+/, 'token=***'));
        console.log('[OpenClaw] Token in URL:', wsUrl.searchParams.has('token'));

        // Cloudflare Access service token must be sent as HTTP headers on the
        // WebSocket UPGRADE request. The DOM/global `WebSocket` cannot set
        // request headers, so for a CF-Access-protected remote client we use
        // the `ws` npm library (which accepts a headers option). The local /
        // self loopback path has no CF-Access headers and keeps using the
        // global WebSocket — so `ws` is only required when at least one remote
        // client is configured.
        const needsCfAccess = !!(this.cfAccessClientId && this.cfAccessClientSecret);
        if (needsCfAccess) {
          let WsCtor: new (url: string, opts: { headers: Record<string, string> }) => SocketLike;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const wsModule = require('ws');
            WsCtor = (wsModule.WebSocket || wsModule.default || wsModule) as typeof WsCtor;
          } catch {
            this.connecting = null;
            this.recordConnectError(
              "Remote client requires the 'ws' npm package for Cloudflare Access headers, but it is not installed. Run `npm install ws`.",
            );
            reject(new Error("The 'ws' package is required to connect to a Cloudflare Access protected client"));
            return;
          }
          this.ws = new WsCtor(wsUrl.toString(), {
            headers: {
              'CF-Access-Client-Id': this.cfAccessClientId as string,
              'CF-Access-Client-Secret': this.cfAccessClientSecret as string,
            },
          });
        } else {
          this.ws = new WebSocket(wsUrl.toString()) as unknown as SocketLike;
        }

        const connectionTimeout = setTimeout(() => {
          if (!this.connected) {
            this.recordConnectError('Connection timeout (gateway did not complete the handshake in 10s)');
            this.ws?.close();
            reject(new Error('Connection timeout'));
          }
        }, 10000); // 10 second connection timeout

        this.ws.onopen = async () => {
          clearTimeout(connectionTimeout);
          console.log('[OpenClaw] WebSocket opened, waiting for challenge...');
          // Don't send anything yet - wait for Gateway challenge
          // Token is in URL query string
        };

        this.ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          const wasConnected = this.connected;
          this.connected = false;
          this.authenticated = false;
          this.connecting = null;
          this.messageHandlers.clear(); // Clear handlers on disconnect
          // Note: globalProcessedEvents is NOT cleared as it's shared across all instances
          this.emit('disconnected');
          // Log close reason for debugging
          console.log(`[OpenClaw] Disconnected from Gateway (code: ${event.code}, reason: "${event.reason}", wasClean: ${event.wasClean})`);
          // Only auto-reconnect if we were previously connected (not on initial connection failure)
          if (this.autoReconnect && wasConnected) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          console.error('[OpenClaw] WebSocket error');
          this.emit('error', error);
          if (!this.connected) {
            this.connecting = null;
            this.recordConnectError(`WebSocket transport error reaching ${this.url}`);
            reject(new Error('Failed to connect to OpenClaw Gateway'));
          }
        };

        // Create message handler. `event.data` is a string from the global
        // WebSocket and a string|Buffer from the `ws` library — coerce both.
        const messageHandler = (event: { data: unknown }) => {
          try {
            const data = JSON.parse(String(event.data));

            // Generate unique event ID using content hashing for proper deduplication
            const eventId = this.generateEventId(data);

            // Skip if we've already processed this event (using global cache for all instances)
            if (globalProcessedEvents.has(eventId)) {
              console.log('[OpenClaw] Skipping duplicate event:', eventId.slice(0, 16));
              return;
            }

            // Mark this event as processed in the global cache with current timestamp for LRU
            const now = Date.now();
            globalProcessedEvents.set(eventId, now);

            // Perform LRU cleanup if cache size exceeds limit
            this.performCacheCleanup();

            console.log('[OpenClaw] Received:', eventId.slice(0, 16));

            // Handle challenge-response authentication (OpenClaw RequestFrame format)
            if (data.type === 'event' && data.event === 'connect.challenge') {
              console.log('[OpenClaw] Challenge received, responding...');
              const nonce = data.payload?.nonce;
              const requestId = crypto.randomUUID();
              const signedAtMs = Date.now();
              const role = 'operator';
              const scopes = ['operator.admin'];

              // Build device identity for the connect params
              const clientId = 'cli';
              let device: Record<string, unknown> | undefined;
              if (this.deviceIdentity) {
                const payload = buildDeviceAuthPayload({
                  deviceId: this.deviceIdentity.deviceId,
                  clientId,
                  clientMode: 'ui',
                  role,
                  scopes,
                  signedAtMs,
                  token: this.token || null,
                  nonce,
                });
                const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, payload);
                device = {
                  id: this.deviceIdentity.deviceId,
                  publicKey: publicKeyRawBase64Url(this.deviceIdentity.publicKeyPem),
                  signature,
                  signedAt: signedAtMs,
                  nonce,
                };
                console.log('[OpenClaw] Device identity prepared:', {
                  deviceId: this.deviceIdentity.deviceId,
                  hasSignature: !!signature,
                  nonce,
                });
              }

              const response = {
                type: 'req',
                id: requestId,
                method: 'connect',
                params: {
                  // The gateway "rejects ranges that do not include its current
                  // protocol". OpenClaw's current PROTOCOL_VERSION is 4
                  // (MIN_CLIENT_PROTOCOL_VERSION = 4), so a hardcoded [3,3] range
                  // was the root cause of "Authentication failed: protocol
                  // mismatch". Advertise [3,4] so we satisfy a v4 gateway while
                  // staying tolerant of an older v3 one.
                  minProtocol: 3,
                  maxProtocol: 4,
                  client: {
                    id: clientId,
                    version: '1.0.1',
                    platform: process.platform || 'web',
                    mode: 'ui',
                  },
                  auth: { token: this.token },
                  role,
                  scopes,
                  device,
                }
              };

              // Set up response handler
              this.pendingRequests.set(requestId, {
                resolve: () => {
                  this.connected = true;
                  this.authenticated = true;
                  this.connecting = null;
                  this.lastConnectError = null;
                  this.lastConnectErrorAtMs = 0;
                  this.resetReconnectBackoff(); // U020: healthy connect resets the backoff counter
                  this.emit('connected');
                  console.log('[OpenClaw] Authenticated successfully');
                  resolve();
                },
                reject: (error: Error) => {
                  this.connecting = null;
                  // A rejected `connect` RPC almost always means the gateway
                  // does not (yet) trust this operator device — i.e. pairing
                  // is pending. Record a precise, actionable error so the
                  // status route can tell the operator to approve the device.
                  this.recordConnectError(
                    `Gateway rejected device pairing (device ${this.deviceIdentity?.deviceId ?? 'unknown'}): ${error.message}`,
                  );
                  this.ws?.close();
                  reject(new Error(`Authentication failed: ${error.message}`));
                }
              });

              console.log('[OpenClaw] Sending challenge response');
              this.ws!.send(JSON.stringify(response));
              return;
            }

            // Handle RPC responses and other messages
            this.handleMessage(data as OpenClawMessage);
          } catch (err) {
            console.error('[OpenClaw] Failed to parse message:', err);
          }
        };

        // Track and assign the message handler
        this.messageHandlers.add(messageHandler);
        this.ws.onmessage = messageHandler;
      } catch (err) {
        this.connecting = null;
        reject(err);
      }
    });

    return this.connecting;
  }

  /**
   * True when this client targets the LOCAL/self gateway over loopback with no
   * Cloudflare-Access headers. Only in that case can we run the gateway-host
   * `openclaw devices approve` CLI to self-heal pairing — a remote client's
   * gateway lives on another box where we cannot invoke its CLI.
   */
  private isLocalSelfGateway(): boolean {
    if (this.cfAccessClientId || this.cfAccessClientSecret) return false;
    try {
      const host = new URL(this.url).hostname;
      return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    } catch {
      return false;
    }
  }

  /**
   * Connect, and if the gateway rejects our device (pairing pending) AND this is
   * the local/self gateway, auto-approve THIS device via the documented CLI
   * (`openclaw devices list --json` → match our deviceId → `openclaw devices
   * approve <requestId>`), then retry the connection ONCE. The operator never
   * has to approve manually for the self box.
   *
   * For a remote client (no local CLI / token for that box) this is a no-op
   * beyond the normal connect; the caller keeps the clear actionable message.
   *
   * Returns true on a (re)connected socket; throws the original connect error
   * when auto-approve is not possible or did not help.
   */
  async connectWithAutoPair(): Promise<void> {
    try {
      await this.connect();
      this.autoApproveAttempted = false; // healthy connect resets the cycle
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const pairingPending = /pairing|Authentication failed|device/i.test(message);
      // Only self-heal a pairing failure on the local box, and only once per
      // cycle to avoid an approve→retry→approve loop.
      if (
        !pairingPending ||
        !this.isLocalSelfGateway() ||
        this.autoApproveAttempted ||
        this.autoApproveInFlight
      ) {
        throw err;
      }
      this.autoApproveInFlight = true;
      this.autoApproveAttempted = true;
      try {
        const approved = await this.autoApproveLocalDevice();
        if (!approved) throw err; // could not approve — surface the original error
        // Approved: retry the handshake once. A fresh connect re-runs the
        // challenge/response with the now-trusted device.
        await this.connect();
        this.pairingAutoApprovedNote =
          `Device ${this.deviceIdentity?.deviceId ?? 'unknown'} was not approved; the Command Center approved it automatically and reconnected.`;
        this.lastConnectError = null;
        this.lastConnectErrorAtMs = 0;
      } finally {
        this.autoApproveInFlight = false;
      }
    }
  }

  /**
   * Run the documented OpenClaw CLI on the LOCAL gateway host to approve THIS
   * device. Returns true when an approve command was run for a request whose
   * device id matches our own deviceId.
   *
   * Steps (per docs/cli/devices.md):
   *   1. `openclaw devices list --json` → find the pending request for our
   *      deviceId, read its requestId.
   *   2. `openclaw devices approve <requestId> [--token <token>]`.
   *
   * The JSON shape is not strictly documented, so parsing is defensive: we scan
   * the structure for any object that carries our deviceId AND a request-id-like
   * field. Never throws — returns false on any failure.
   */
  private async autoApproveLocalDevice(): Promise<boolean> {
    const deviceId = this.deviceIdentity?.deviceId;
    if (!deviceId) return false;
    try {
      const listOut = await this.runOpenClawCli(['devices', 'list', '--json']);
      if (listOut === null) return false;
      const requestId = this.findPendingRequestId(listOut, deviceId);
      if (!requestId) {
        console.warn('[OpenClaw] auto-pair: no pending request found for device', deviceId);
        return false;
      }
      // Approve by exact requestId. Pass the token when we hold one; the local
      // loopback pairing fallback covers the no-token case (see docs/cli/devices.md).
      const approveArgs = ['devices', 'approve', requestId];
      if (this.token) approveArgs.push('--token', this.token);
      const approveOut = await this.runOpenClawCli(approveArgs);
      if (approveOut === null) return false;
      console.log('[OpenClaw] auto-pair: approved device', deviceId, 'request', requestId);
      return true;
    } catch (e) {
      console.warn('[OpenClaw] auto-pair failed:', e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /**
   * Find the pending pairing requestId whose device id matches `deviceId` in the
   * `openclaw devices list --json` output. Defensive against unknown nesting:
   * walks the parsed JSON and matches any object that exposes our deviceId on a
   * device-id-like field plus a request-id-like field.
   */
  private findPendingRequestId(jsonText: string, deviceId: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return null;
    }
    const deviceKeys = ['deviceId', 'device_id', 'device'];
    const requestKeys = ['requestId', 'request_id', 'id'];
    let found: string | null = null;
    const visit = (node: unknown) => {
      if (found) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        const matchesDevice = deviceKeys.some((k) => {
          const v = obj[k];
          return typeof v === 'string' && v === deviceId;
        });
        if (matchesDevice) {
          for (const rk of requestKeys) {
            const v = obj[rk];
            // Don't mistake the deviceId field itself for the requestId.
            if (typeof v === 'string' && v && v !== deviceId) {
              found = v;
              return;
            }
          }
        }
        for (const v of Object.values(obj)) visit(v);
      }
    };
    visit(parsed);
    return found;
  }

  /**
   * Invoke the `openclaw` CLI and return stdout, or null on failure. Bounded
   * runtime + buffer so a hung CLI cannot wedge a request. Never throws.
   */
  private runOpenClawCli(args: string[]): Promise<string | null> {
    const bin = process.env.OPENCLAW_CLI_BIN || 'openclaw';
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(stdout?.toString() ?? '');
        },
      );
    });
  }

  /** The one-time "approved automatically" note, or null. Read by the status
   *  route to render a clean state instead of the raw pairing error. */
  getPairingAutoApprovedNote(): string | null {
    return this.pairingAutoApprovedNote;
  }

  private handleMessage(data: OpenClawMessage & { type?: string; ok?: boolean; payload?: unknown }): void {
    // Handle OpenClaw ResponseFrame format (type: "res")
    if (data.type === 'res' && data.id !== undefined) {
      const requestId = data.id as string | number;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        const { resolve, reject } = pending;
        this.pendingRequests.delete(requestId);

        if (data.ok === false && data.error) {
          reject(new Error(data.error.message));
        } else {
          resolve(data.payload);
        }
        return;
      }
    }

    // Handle legacy JSON-RPC responses
    const legacyId = data.id as string | number | undefined;
    if (legacyId !== undefined && this.pendingRequests.has(legacyId)) {
      const { resolve, reject } = this.pendingRequests.get(legacyId)!;
      this.pendingRequests.delete(legacyId);

      if (data.error) {
        reject(new Error(data.error.message));
      } else {
        resolve(data.result);
      }
      return;
    }

    // Handle events/notifications
    if (data.method) {
      this.emit('notification', data);
      this.emit(data.method, data.params);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.autoReconnect) return;

    // U020: terminal blocked state — after MAX_RECONNECT_ATTEMPTS consecutive
    // failures stop retrying instead of hammering a flapping gateway forever.
    if (this.reconnectBlocked) return;

    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.reconnectBlocked = true;
      this.recordConnectError(
        `Reconnect blocked after ${MAX_RECONNECT_ATTEMPTS} failed attempts — gateway ${this.url} unreachable; not retrying`,
      );
      console.error(
        `[OpenClaw] Reconnect blocked after ${MAX_RECONNECT_ATTEMPTS} failed attempts — giving up on ${this.url}`,
      );
      return;
    }

    // Bounded exponential backoff: base*2^(n-1) capped at the max
    // (2s → 4s → 8s → 16s → 32s with the defaults).
    const delayMs = Math.min(
      RECONNECT_BACKOFF_MAX_MS,
      RECONNECT_BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.autoReconnect || this.reconnectBlocked) return;

      console.log(`[OpenClaw] Attempting reconnect (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      try {
        await this.connect();
      } catch {
        // Failed attempt: back off further, or block once the ceiling is hit.
        this.scheduleReconnect();
      }
    }, delayMs);
  }

  /**
   * U020: reset the reconnect backoff/attempt counter after a successful
   * connection (or an explicit manual reconnect request). Clears the terminal
   * blocked state so the client can try again.
   */
  resetReconnectBackoff(): void {
    this.reconnectAttempts = 0;
    this.reconnectBlocked = false;
  }

  /** U020: true once the client gave up after MAX_RECONNECT_ATTEMPTS consecutive
   *  failures. Surfaced so the status route / callers can tell a blocked client
   *  from a merely disconnected one. */
  isReconnectBlocked(): boolean {
    return this.reconnectBlocked;
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || !this.connected || !this.authenticated) {
      throw new Error('Not connected to OpenClaw Gateway');
    }

    const id = crypto.randomUUID();
    const message = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);

      this.ws!.send(JSON.stringify(message));
    });
  }

  // Session management methods
  async listSessions(): Promise<OpenClawSessionInfo[]> {
    return this.call<OpenClawSessionInfo[]>('sessions.list');
  }

  async getSessionHistory(sessionId: string): Promise<unknown[]> {
    return this.call<unknown[]>('sessions.history', { session_id: sessionId });
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    await this.call('sessions.send', { session_id: sessionId, content });
  }

  async createSession(channel: string, peer?: string): Promise<OpenClawSessionInfo> {
    return this.call<OpenClawSessionInfo>('sessions.create', { channel, peer });
  }

  // Node methods (device capabilities)
  async listNodes(): Promise<unknown[]> {
    return this.call<unknown[]>('node.list');
  }

  async describeNode(nodeId: string): Promise<unknown> {
    return this.call('node.describe', { node_id: nodeId });
  }

  disconnect(): void {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnect on intentional close
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.connecting = null;
    this.messageHandlers.clear(); // Clear all tracked handlers
    // Note: globalProcessedEvents is NOT cleared as it's shared across all instances
  }

  private recordConnectError(message: string): void {
    this.lastConnectError = message;
    this.lastConnectErrorAtMs = Date.now();
  }

  isConnected(): boolean {
    return this.connected && this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * The gateway URL this client connects to (token stripped). Surfaced by the
   * status route so the operator can confirm the resolved default vs an
   * explicit `OPENCLAW_GATEWAY_URL`.
   */
  getGatewayUrl(): string {
    return this.url;
  }

  /**
   * The local operator device id (ed25519 public-key fingerprint), or null if
   * the identity could not be loaded. This is the id the operator approves on
   * the gateway with `openclaw devices approve <requestId>`.
   */
  getDeviceId(): string | null {
    return this.deviceIdentity?.deviceId ?? null;
  }

  /**
   * The most recent connect/auth failure (or null when connected). Lets the
   * status route distinguish "gateway unreachable" from "device pairing
   * pending" and render the exact remediation.
   */
  getLastConnectError(): { message: string; atMs: number } | null {
    if (!this.lastConnectError) return null;
    return { message: this.lastConnectError, atMs: this.lastConnectErrorAtMs };
  }

  setAutoReconnect(enabled: boolean): void {
    this.autoReconnect = enabled;
    if (enabled) {
      // U020: an explicit re-enable is a manual reconnect request — clear the
      // terminal blocked state so the client may try again.
      this.resetReconnectBackoff();
    } else if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// Per-target instance cache for server-side usage. Keyed by target id so each
// selected client gets its OWN gateway connection (the root-cause fix: the CC
// used to share one loopback singleton for every client). The local/self
// loopback uses the reserved '__self__' key and preserves the historical
// zero-argument singleton behavior for all existing callers.
const SELF_KEY = '__self__';
const clientInstances = new Map<string, OpenClawClient>();

/**
 * Resolve an OpenClaw gateway client.
 *
 * - No argument (or a self/loopback target): returns the shared local
 *   singleton, exactly as before — fully backward compatible.
 * - A remote `OpenClawClientTarget`: returns (and caches) a dedicated client
 *   that connects to THAT client's gateway URL, carrying its gateway token and
 *   Cloudflare Access service-token headers on the WS upgrade.
 */
export function getOpenClawClient(target?: OpenClawClientTarget): OpenClawClient {
  // No target, or the reserved self id → the shared local loopback singleton,
  // constructed with the historical env-derived defaults. Fully backward
  // compatible with every existing zero-argument caller.
  if (!target || target.id === SELF_KEY) {
    let inst = clientInstances.get(SELF_KEY);
    if (!inst) {
      inst = new OpenClawClient();
      clientInstances.set(SELF_KEY, inst);
    }
    return inst;
  }

  // Remote (or any explicitly-targeted) client → one cached instance per id.
  const key = target.id || target.url;
  let inst = clientInstances.get(key);
  if (!inst) {
    inst = new OpenClawClient(target.url, target.token ?? '', {
      cfAccessClientId: target.cfAccessClientId ?? null,
      cfAccessClientSecret: target.cfAccessClientSecret ?? null,
    });
    clientInstances.set(key, inst);
  }
  return inst;
}
