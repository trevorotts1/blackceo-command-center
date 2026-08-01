/** PLANTED FIXTURE — must FAIL. THE BLIND SPOT: instances:1, exec_mode:fork, shared DATABASE_PATH. */
const D='/planted/fixture/does-not-exist/mission-control.db',C='/planted/fixture/does-not-exist';
module.exports = { apps: [
  { name: 'planted-twin-a', script: 'bash', args: 'scripts/cc-start.sh --port 4000', cwd: C, env: { DATABASE_PATH: D }, instances: 1, exec_mode: 'fork' },
  { name: 'planted-twin-b', script: 'bash', args: 'scripts/cc-start.sh --port 4001', cwd: C, env: { DATABASE_PATH: D }, instances: 1, exec_mode: 'fork' },
] };
