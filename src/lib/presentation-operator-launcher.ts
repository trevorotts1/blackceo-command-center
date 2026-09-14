/** Server-only launcher for a validated operator intake contract. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadOperatorPresentationContract } from '@/lib/presentation-operator-contract';
import { DEPARTMENT_PRESENTATIONS_RUNS } from '@/lib/presentation-run-roots';

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
export async function launchOperatorPresentationContract(taskId: string): Promise<{ runDir: string; output: string } | null> {
  const contract = loadOperatorPresentationContract(taskId);
  if (!contract) return null;
  const root = process.env.PRESENTATION_OPERATOR_RUNS_DIR?.trim() || DEPARTMENT_PRESENTATIONS_RUNS;
  const runDir = path.join(root, `pres-operator-${taskId}`);
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cc-presentation-contract-'));
  const contractFile = path.join(temp, 'contract.json');
  await writeFile(contractFile, JSON.stringify(contract), { encoding: 'utf8', mode: 0o600 });
  const { stdout } = await execFileAsync('python3', [bridgePath(), 'operator-contract', '--contract-file', contractFile, '--run-dir', runDir], { timeout: 30_000, maxBuffer: 64 * 1024 });
  return { runDir, output: stdout.trim() };
}
