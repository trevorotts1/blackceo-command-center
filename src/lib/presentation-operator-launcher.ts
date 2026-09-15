/** Server-only launcher for a validated operator intake contract. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { bridgeReceipt, loadOperatorPresentationContract } from '@/lib/presentation-operator-contract';
import { operatorPresentationRunDir } from '@/lib/presentation-run-roots';

const execFileAsync = promisify(execFile);
function bridgePath(): string {
  const explicit = process.env.PRESENTATION_INTAKE_BRIDGE?.trim();
  if (explicit) return explicit;
  return path.join(process.env.HOME || os.homedir(), '.openclaw', 'workspace', 'departments', 'Presentations', 'intake', 'interview-app', 'bridge', 'intake_bridge.py');
}
/**
 * The bridge owns the lease and engine launch. This function only supplies a
 * server-validated contract file; it never writes a run artifact itself.
 */
export type OperatorBridgeLaunch =
  | { kind: 'acknowledged'; runDir: string; detail: string }
  | { kind: 'retryable' | 'deferred' | 'blocked'; detail: string };

/**
 * Translate the bridge's documented process contract into typed CC outcomes.
 * A nonzero exit is data here: it must reach the normal task retry ladder, not
 * turn into a false handoff merely because the subprocess produced JSON.
 */
export async function launchOperatorPresentationContract(taskId: string): Promise<OperatorBridgeLaunch | null> {
  const contract = loadOperatorPresentationContract(taskId);
  if (!contract) return null;
  const runDir = operatorPresentationRunDir(taskId);
  await mkdir(path.dirname(runDir), { recursive: true });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cc-presentation-contract-'));
  const contractFile = path.join(temp, 'contract.json');
  await writeFile(contractFile, JSON.stringify(bridgeReceipt(contract)), { encoding: 'utf8', mode: 0o600 });
  try {
    const { stdout } = await execFileAsync('python3', [bridgePath(), 'operator-contract', '--contract-file', contractFile, '--run-dir', runDir], { timeout: 30_000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(stdout) as { status?: unknown; bridge?: { _rc?: unknown; detail?: unknown } };
    if (result.status === 'worker_acknowledged' || result.status === 'already_complete') {
      return { kind: 'acknowledged', runDir, detail: typeof result.bridge?.detail === 'string' ? result.bridge.detail : String(result.status) };
    }
    throw new Error(`operator bridge exited 0 without acknowledged status (${String(result.status)})`);
  } catch (error) {
    const processError = error as Error & { code?: unknown; stdout?: unknown };
    const rc = typeof processError.code === 'number' ? processError.code : undefined;
    const output = typeof processError.stdout === 'string' ? processError.stdout : '';
    let detail = processError.message;
    try {
      const result = JSON.parse(output) as { bridge?: { detail?: unknown } };
      if (typeof result.bridge?.detail === 'string') detail = result.bridge.detail;
    } catch { /* malformed bridge output remains retryable transport failure */ }
    if (rc === 7) return { kind: 'deferred', detail };
    if (rc === 8) return { kind: 'blocked', detail };
    return { kind: 'retryable', detail };
  }
}
