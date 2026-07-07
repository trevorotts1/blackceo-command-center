module.exports = {
  apps: [{
    name: 'mission-control',
    script: '/usr/local/bin/npx',
    args: 'next start -p 4000 -H 0.0.0.0',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      PORT: 4000,
      DATABASE_PATH: './mission-control.db',
      PROJECTS_PATH: '~/projects',
      MISSION_CONTROL_URL: 'http://localhost:4000'
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
