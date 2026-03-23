module.exports = {
  apps: [{
    name: 'mission-control',
    script: '/opt/homebrew/bin/npx',
    args: 'next start -p 3000 -H 0.0.0.0',
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'production',
      PORT: '3000'
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
