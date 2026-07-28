/** PLANTED FIXTURE — must FAIL the pm2-single-instance-guard CI check. */
module.exports = { apps: [{ name: 'planted-clustered-command-center', script: 'bash', args: 'scripts/cc-start.sh --port 4000', cwd: '/planted/fixture/does-not-exist', env: { DATABASE_PATH: '/planted/fixture/does-not-exist/mission-control.db' }, instances: 4, exec_mode: 'cluster_mode' }] };
