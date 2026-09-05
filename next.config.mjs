/** @type {import('next').NextConfig} */
const nextConfig = {
  // BUG-1 FIX (atomic-deploy.sh build isolation): honour NEXT_DIST_DIR so a
  // build can be pointed at a temp directory instead of the live .next. Next.js
  // resolves this via path.join(<project dir>, distDir), which does NOT
  // special-case an absolute second argument (it concatenates instead of
  // replacing) -- so this value must be a path RELATIVE to the project root,
  // never absolute. scripts/atomic-deploy.sh passes a relative temp-dir name
  // for exactly this reason. Falls back to the normal '.next' when unset.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Instrumentation is stable; keep native SQLite outside the server bundle.
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config, { nextRuntime }) => {
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
