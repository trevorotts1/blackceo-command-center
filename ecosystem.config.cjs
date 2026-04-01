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
      PORT: process.env.PORT || 4000
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
