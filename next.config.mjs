import path from 'node:path';

/**
 * distDir MUST be relative to the project root: Next resolves it with
 * path.join(<project dir>, distDir), which concatenates an absolute second
 * argument instead of replacing it. An absolute NEXT_DIST_DIR (v7.6.2 pinned
 * "<CC_DIR>/.next" in cc-start.sh) therefore made `next start` look for
 * <dir>/<dir>/.next and refuse with "Could not find a production build" on every
 * restart (operator Mac, 2026-09-18, 71 pm2 restarts). Normalize defensively:
 * an absolute value inside the project becomes its relative form; anything
 * outside the project (or unparseable) falls back to '.next'.
 */
function resolveDistDir() {
  const raw = process.env.NEXT_DIST_DIR;
  if (!raw) return '.next';
  if (!path.isAbsolute(raw)) return raw;
  const rel = path.relative(process.cwd(), raw);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '.next';
  return rel;
}

/**
 * The files the canonical `public/chamber/index.html` loads by relative
 * reference. They are served from `/chamber/...`; the browser resolves the
 * document's `./name` against `/council`, so each one needs a root-level
 * rewrite that does not alter a single canonical byte. Keep this list in step
 * with the bundle manifest (PROVENANCE.json) if the canonical release adds a
 * top-level asset.
 */
const CHAMBER_ROOT_ASSETS = [
  'chamber-theme.css',
  'chamber-shell.css',
  'chamber-decision.css',
  'chamber-advisory.css',
  'chamber-room.css',
  'chamber-keypoints.css',
  'chamber-seatcard.css',
  'chamber-cue.css',
  'council-theme.css',
  'council-room.css',
  'council-journey.css',
  'chamber-seats.js',
  'chamber-state.js',
  'chamber-live.js',
  'chamber-shell.js',
  'chamber-decision.js',
  'chamber-room.js',
  'chamber-keypoints.js',
  'chamber-seatcard.js',
  'chamber-advisory.js',
  'chamber-cue.js',
  'demo-replay.json',
  'advisors.html',
  'not-packaged.html',
  'blackceo-logo.png',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Loopback browser fixtures use this host. Next 16 carries React's dev debug
  // stream over HMR; rejecting its origin also prevents client hydration.
  // This allowlist applies only to development resources, not production auth.
  allowedDevOrigins: ['127.0.0.1'],
  // BUG-1 FIX (atomic-deploy.sh build isolation): honour NEXT_DIST_DIR so a
  // build can be pointed at a temp directory instead of the live .next. Next.js
  // resolves this via path.join(<project dir>, distDir), which does NOT
  // special-case an absolute second argument (it concatenates instead of
  // replacing) -- so this value must be a path RELATIVE to the project root,
  // never absolute. scripts/atomic-deploy.sh passes a relative temp-dir name
  // for exactly this reason. Falls back to the normal '.next' when unset.
  distDir: resolveDistDir(),
  // Instrumentation is stable; keep native SQLite outside the server bundle.
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config, { nextRuntime, webpack }) => {
    config.externals.push({
      'better-sqlite3': 'commonjs better-sqlite3',
      // PORT-FIX-3: the nodejs runtime legitimately uses node:child_process
      // (relaunch bridge src/lib/jobs/relaunch.ts -> scripts/relaunch-cc-on-4000.cjs).
      // Keep it external so webpack never tries to bundle the builtin in the
      // nodejs runtime (the edge stub below already handles the edge runtime).
      'node:child_process': 'commonjs node:child_process',
    });
    // instrumentation.ts pulls node-only modules (db/migrations, jobs/scheduler,
    // openclaw client) into its dependency graph. They run ONLY in the nodejs
    // runtime (guarded by NEXT_RUNTIME), but webpack still compiles instrumentation
    // for the edge runtime, where node built-ins have no polyfill. Stub them for
    // edge so the build doesn't choke; they are never executed there.
    if (nextRuntime === 'edge') {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        os: false, crypto: false, fs: false, path: false,
        child_process: false, net: false, tls: false, stream: false,
        zlib: false, http: false, https: false, dns: false,
      };
      // node-only INSTALLED packages reachable from the node-guarded instrumentation
      // graph. fallback doesn't apply to resolvable packages — alias:false does, which
      // stubs the whole module for edge so their internal node:* imports never compile.
      // Also stub node: URI-prefixed variants (used in sop-auto-replace / sop-authoring).
      // webpack rejects the `node:` URI scheme before alias/fallback run
      // (UnhandledSchemeError), so strip the prefix first and let the bare-name
      // fallback/alias stubs below apply (dev server failed on node:crypto).
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '');
        }),
      );
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        'node-cron': false, 'better-sqlite3': false,
        'node:fs': false, 'node:path': false, 'node:os': false,
        'node:child_process': false, 'node:crypto': false,
        'node:net': false, 'node:tls': false, 'node:stream': false,
        'node:http': false, 'node:https': false, 'node:dns': false,
      };
    }
    return config;
  },
  async rewrites() {
    /**
     * CTR-191 universal Council screen.
     *
     * `/council` must open the SAME chamber the OpenClaw / claude-nine entry
     * opens. That chamber is the canonical, dependency-free, same-origin bundle
     * synced verbatim into `public/chamber` by
     * `scripts/council/sync-chamber.mjs` — not a second renderer that imitates
     * it. The rewrite keeps the URL at `/council` and runs AFTER middleware, so
     * every existing auth, tenant and interview gate still runs first; only the
     * document that renders changes. The chamber carries no data of its own: it
     * reads this app's own authorized `/api/council/*` endpoints, which keep the
     * Command Center's managed session store, tenant scope and principal
     * authoritative.
     *
     * The chamber's single session read is `GET /council/<id>` with
     * `Accept: application/json`. That path is also the React session page, so
     * only the JSON read is rerouted, and only when the caller asks for JSON.
     */
    return {
      beforeFiles: [
        {
          source: '/council',
          destination: '/chamber/index.html',
        },
        {
          source: '/council/:sessionId',
          has: [{ type: 'header', key: 'accept', value: '(.*application/json.*)' }],
          destination: '/api/council/chamber-sessions/:sessionId',
        },
        {
          source: '/council/:sessionId/report.pdf',
          destination: '/api/council/chamber-sessions/:sessionId/report.pdf',
        },
        /**
         * Base-path adapter for the unchanged canonical document.
         *
         * The canonical chamber is copied byte-for-byte and is served at
         * `/council`, so every relative reference in its HTML/CSS
         * (`./chamber-theme.css`, `./portraits/x.webp`, `./demo-replay.json`)
         * resolves against `/`, not `/chamber/`. Rewriting only the files the
         * canonical bundle itself names keeps the bundle bit-identical while
         * letting its styles, scripts and portraits load. Nothing else under
         * `/` is touched, and the `/council/*` app routes keep their own
         * meanings.
         */
        ...CHAMBER_ROOT_ASSETS.map((asset) => ({
          source: `/${asset}`,
          destination: `/chamber/${asset}`,
        })),
        {
          source: '/portraits/:file*',
          destination: '/chamber/portraits/:file*',
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
