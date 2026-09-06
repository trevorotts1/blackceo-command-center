#!/usr/bin/env node
/** Keep inherited literal service values literal through Next's dotenv-expand.
 * Called only in the final Next process; PM2, migrations and path checks retain
 * their raw environment. No credentials are printed or written by this shim.
 */
const fs = require('node:fs');
const path = require('node:path');
let prepared = false;

function prepareNextEnvironment(directory, development = false) {
  if (prepared) return;
  if (process.env.__NEXT_PROCESSED_ENV) {
    throw new Error('Next service environment must be prepared before loading Next');
  }
  const mode = process.env.NODE_ENV === 'test' ? 'test' : development ? 'development' : 'production';
  const files = [`.env.${mode}.local`, mode !== 'test' && '.env.local', `.env.${mode}`, '.env'].filter(Boolean);
  const assignments = new Map();
  // Follow dotenv's assignment grammar, including quoted multiline values, so
  // apparent KEY= text inside a quoted value is not mistaken for a binding.
  const line = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
  for (const filename of files) {
    let contents;
    try {
      contents = fs.readFileSync(path.join(directory, filename), 'utf8').replace(/\r\n?/g, '\n');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('Cannot read service environment file');
    }
    const inFile = new Map();
    for (const match of contents.matchAll(line)) inFile.set(match[1], match[2] || '');
    for (const [key, value] of inFile) {
      const previous = assignments.get(key) || { files: 0, dollar: false };
      assignments.set(key, { files: previous.files + 1, dollar: previous.dollar || value.includes('$') });
    }
  }
  // dotenv-expand expands inherited keys again in each env-file layer. A
  // repeated dollar-valued key cannot safely be escaped just once. Refuse the
  // ambiguous layered input instead of changing a path or credential silently.
  for (const [key, assignment] of assignments) {
    const inherited = process.env[key];
    if (assignment.files > 1 && (assignment.dollar || inherited?.includes('$'))) {
      throw new Error('Dollar-valued service environment keys must be defined in only one env file');
    }
  }
  for (const key of assignments.keys()) {
    if (typeof process.env[key] === 'string') {
      process.env[key] = process.env[key].replace(/\$/g, '\\$');
    }
  }
  prepared = true;
}

module.exports = { prepareNextEnvironment };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    prepareNextEnvironment(process.cwd(), args[0] === 'dev');
    const cli = require.resolve('next/dist/bin/next');
    process.argv = [process.execPath, cli, ...args];
    require(cli);
  } catch {
    console.error('[next-service-env] Cannot prepare literal service environment; check env-file bindings.');
    process.exitCode = 1;
  }
}
