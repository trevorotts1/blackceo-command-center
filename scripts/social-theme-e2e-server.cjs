// Start the social acceptance server with no operator credentials or live state.
const { spawn } = require('node:child_process');
const { mkdirSync, existsSync } = require('node:fs');
const path = require('node:path');
const root = process.env.SOCIAL_THEME_E2E_RUN_ROOT;
const port = process.env.SOCIAL_THEME_E2E_PORT || '4127';
if (!root || !path.isAbsolute(root) || !/^\d+$/.test(port)) {
  throw new Error('Explicit isolated SOCIAL_THEME_E2E_RUN_ROOT and numeric port required');
}
for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
  if (existsSync(file)) throw new Error(`Run social E2E in an isolated worktree without ${file}; Next would load its credentials`);
}
const home = path.join(root, 'home');
mkdirSync(home, { recursive: true });
const env = {
  PATH: process.env.PATH,
  TMPDIR: root,
  HOME: home,
  NODE_ENV: 'development',
  DATABASE_PATH: path.join(root, 'social-theme.db'),
  MC_TENANT_SESSION_SECRET: 'f27-e2e-secret',
  MC_API_TOKEN: 'f27-e2e-operator-token',
  MC_INSTALLATION_ID: 'f27-e2e-install',
  MC_TENANT_PUBLIC_URL: `http://127.0.0.1:${port}`,
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1',
  OPENCLAW_GATEWAY_URL: 'not-a-valid-url',
  DISABLE_CRON: '1',
  DISABLE_BRIDGE_BOOTSTRAP: '1',
  DISABLE_AGENT_SYNC: '1',
  DISABLE_REGISTRY_BOOT_SEED: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--webpack', '-p', port, '-H', '127.0.0.1'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
