module.exports = {
  apps: [{
    name: 'mission-control',
    // Mac: /opt/homebrew/bin/npx | VPS/Docker: npx (from PATH, install via npm i -g)
    // If npx not found, replace with full path: which npx
    script: 'npx',
    args: `next start -p ${process.env.PORT || 4000} -H 0.0.0.0`,
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 4000,
      // OpenClaw Bridge: pass these through explicitly so they land in the pm2
      // child env (pm2 does not always inherit a shell's exported vars). They
      // still default at the app layer when unset — OPENCLAW_GATEWAY_URL
      // defaults to ws://127.0.0.1:18789. Set the real values in the
      // container/host .env (Hostinger /docker/<project>/.env) or app .env.local
      // and run `pm2 restart mission-control --update-env`.
      ...(process.env.OPENCLAW_GATEWAY_URL ? { OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL } : {}),
      ...(process.env.OPENCLAW_GATEWAY_TOKEN ? { OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN } : {}),
      ...(process.env.BCC_DEVICE_IDENTITY_DIR ? { BCC_DEVICE_IDENTITY_DIR: process.env.BCC_DEVICE_IDENTITY_DIR } : {}),
      ...(process.env.BCC_INSTALL_TYPE ? { BCC_INSTALL_TYPE: process.env.BCC_INSTALL_TYPE } : {}),
      ...(process.env.OPENCLAW_PLATFORM ? { OPENCLAW_PLATFORM: process.env.OPENCLAW_PLATFORM } : {})
    },
    // PM2 settings
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    watch: false,
    max_memory_restart: '512M'
  }]
};
