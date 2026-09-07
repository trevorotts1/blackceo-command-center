/** Isolated HTTPS loopback proxy for a prebuilt production Next server.
 * Build first with the fixture's NEXT_DIST_DIR, then run:
 * INTERVIEW_LOCK_PRODUCTION=1 npm run test:e2e:interview-lock
 * Keeps production HTTPS invitation validation and Secure cookies intact.
 */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const port = Number(process.env.PORT || 4123);
const internalPort = port + 1;
const directory = path.resolve('test-results/interview-lock/tls');
fs.mkdirSync(directory, { recursive: true });
const key = path.join(directory, 'key.pem');
const cert = path.join(directory, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
  '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
fs.chmodSync(key, 0o600);
// Next normalizes loopback middleware URLs to localhost. Match that internal
// hostname so its auth-rejection rewrite remains in-process instead of HTTP.
const app = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', 'localhost', '--port', String(internalPort)], {
  stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', PORT: String(internalPort),
    CC_PORT: String(internalPort), NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first`.trim() },
});
const proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
  const upstream = http.request({ hostname: 'localhost', port: internalPort, path: req.url,
    // Next's internal rewrites must use the HTTP upstream transport. The
    // verified public HTTPS origin remains MC_TENANT_PUBLIC_URL, not this hint.
    method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'http' } }, reply => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('Fixture server starting'); });
  req.pipe(upstream);
});
proxy.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  proxy.close();
  app.kill(signal);
});
app.on('exit', code => { proxy.close(); process.exit(code ?? 1); });
