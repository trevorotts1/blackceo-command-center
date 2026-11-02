#!/usr/bin/env node
/**
 * Keep inherited literal service values literal through Next's dotenv-expand.
 * Called only in the final Next process; PM2, migrations and path checks retain
 * their raw environment. No credential values are printed or written by this
 * shim.
 *
 * Trusted build environment (documented path)
 * -------------------------------------------
 * A private build lane may have no `.env.local` of its own. Name the box's
 * existing, absolute env source explicitly:
 *
 *   node scripts/next-service-env.cjs build --webpack \
 *     --env-file /absolute/path/to/trusted/.env.local
 *
 * or `NEXT_SERVICE_ENV_FILE=/absolute/path/to/trusted/.env.local npm run build`.
 *
 * The path MUST be absolute and must already exist. Its values are read into
 * this process only — never copied into the repository, printed, or committed.
 * The binding guard is not bypassed: if a key is defined by both the named
 * source and a project env file, the build is refused and the EXACT key is
 * named. Only that refusal is re-evaluated; there is no broad ignore switch.
 */
const fs = require('node:fs');
const path = require('node:path');
let prepared = false;

class ServiceEnvError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceEnvError';
    this.code = code;
  }
}

const LINE_RE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

function readLayer(directory, filename) {
  try {
    const contents = fs.readFileSync(path.join(directory, filename), 'utf8').replace(/\r\n?/g, '\n');
    const inFile = new Map();
    for (const match of contents.matchAll(LINE_RE)) inFile.set(match[1], match[2] || '');
    return inFile;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ServiceEnvError('SERVICE_ENV_UNREADABLE', `Cannot read service environment file "${filename}".`);
  }
}

function readExplicitSource(envFile) {
  if (!path.isAbsolute(envFile)) {
    throw new ServiceEnvError(
      'SERVICE_ENV_PATH_NOT_ABSOLUTE',
      `--env-file must be an absolute path; received "${envFile}".`,
    );
  }
  let contents;
  try {
    contents = fs.readFileSync(envFile, 'utf8').replace(/\r\n?/g, '\n');
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'SERVICE_ENV_FILE_MISSING' : 'SERVICE_ENV_UNREADABLE';
    throw new ServiceEnvError(code, `Cannot read the named service environment source "${envFile}".`);
  }
  const values = new Map();
  for (const match of contents.matchAll(LINE_RE)) values.set(match[1], match[2] || '');
  return values;
}

function prepareNextEnvironment(directory, development = false, options = {}) {
  if (prepared) return;
  if (process.env.__NEXT_PROCESSED_ENV) {
    throw new ServiceEnvError(
      'SERVICE_ENV_ALREADY_LOADED',
      'Next service environment must be prepared before loading Next.',
    );
  }
  const mode = process.env.NODE_ENV === 'test' ? 'test' : development ? 'development' : 'production';
  const files = [`.env.${mode}.local`, mode !== 'test' && '.env.local', `.env.${mode}`, '.env'].filter(Boolean);
  const assignments = new Map();
  // Follow dotenv's assignment grammar, including quoted multiline values, so
  // apparent KEY= text inside a quoted value is not mistaken for a binding.
  for (const filename of files) {
    const inFile = readLayer(directory, filename);
    if (!inFile) continue;
    for (const [key, value] of inFile) {
      const previous = assignments.get(key) || { files: 0, dollar: false };
      assignments.set(key, { files: previous.files + 1, dollar: previous.dollar || value.includes('$') });
    }
  }

  const explicit = options.envFile ? readExplicitSource(options.envFile) : null;
  if (explicit) {
    for (const key of explicit.keys()) {
      if (assignments.has(key)) {
        throw new ServiceEnvError(
          'SERVICE_ENV_BINDING_AMBIGUOUS',
          `Key "${key}" is defined by both the named source "${options.envFile}" and this project's env files. Choose one source for that key.`,
        );
      }
    }
  }

  // dotenv-expand expands inherited keys again in each env-file layer. A
  // repeated dollar-valued key cannot safely be escaped just once. Refuse the
  // ambiguous layered input instead of changing a path or credential silently,
  // naming the EXACT keys responsible.
  const ambiguous = [];
  for (const [key, assignment] of assignments) {
    const inherited = process.env[key];
    if (assignment.files > 1 && (assignment.dollar || inherited?.includes('$'))) ambiguous.push(key);
  }
  if (ambiguous.length > 0) {
    throw new ServiceEnvError(
      'SERVICE_ENV_BINDING_AMBIGUOUS',
      `Dollar-valued service environment key(s) defined in more than one env file: ${ambiguous.join(', ')}. Define each in exactly one file.`,
    );
  }

  if (explicit) {
    for (const [key, value] of explicit) {
      process.env[key] = value.replace(/\$/g, '\\$');
    }
  }
  for (const key of assignments.keys()) {
    if (typeof process.env[key] === 'string') {
      process.env[key] = process.env[key].replace(/\$/g, '\\$');
    }
  }
  prepared = true;
}

module.exports = { prepareNextEnvironment, ServiceEnvError };
if (require.main === module) {
  try {
    const sourceArgs = process.argv.slice(2);
    let envFile = process.env.NEXT_SERVICE_ENV_FILE;
    const nextArgs = [];
    for (let index = 0; index < sourceArgs.length; index += 1) {
      const arg = sourceArgs[index];
      if (arg === '--env-file') {
        envFile = sourceArgs[index + 1];
        index += 1;
        continue;
      }
      if (arg.startsWith('--env-file=')) {
        envFile = arg.slice('--env-file='.length);
        continue;
      }
      nextArgs.push(arg);
    }
    prepareNextEnvironment(process.cwd(), nextArgs[0] === 'dev', { envFile });
    const cli = require.resolve('next/dist/bin/next');
    process.argv = [process.execPath, cli, ...nextArgs];
    require(cli);
  } catch (error) {
    // Surface the EXACT failure. No values are printed; only the code, the
    // exact missing/ambiguous key names and file paths travel here.
    const code = error && error.code ? error.code : 'SERVICE_ENV_PREPARE_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[next-service-env] ${code}: ${message}`);
    process.exitCode = 1;
  }
}
