/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
    // Required in Next 14.2 to load the project-root `instrumentation.ts` file
    // that registers in-process cron jobs on app boot (v4.0.1 P0-6).
    instrumentationHook: true,
  },
  webpack: (config, { nextRuntime }) => {
    config.externals.push({
      'better-sqlite3': 'commonjs better-sqlite3',
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
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        'node-cron': false, 'better-sqlite3': false,
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
