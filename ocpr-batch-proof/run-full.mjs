import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

const root = process.env.OCPR_SOURCE_DIR;
const evidence = process.env.OCPR_EVIDENCE_DIR;
const head = process.env.OCPR_SOURCE_HEAD;
const pr = Number(process.env.OCPR_PR);
if (!/^[0-9a-f]{40}$/.test(head ?? '') || !Number.isInteger(pr) || pr <= 0) throw Error('Explicit frozen PR and source head required');
if (!root || !evidence) throw Error('Explicit isolated source and evidence roots required');
mkdirSync(evidence, { recursive: true });
const git = args => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
const clean = () => git(['rev-parse', 'HEAD']) === head && !git(['status', '--porcelain']);
const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PNPM_HOME, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':'), NODE_OPTIONS: '--max-old-space-size=4096', SHELL: '/bin/sh', OMB_VITEST_RETRY_LOG: join(evidence, 'project-ci-retries.jsonl') };
for (const key of ['OMB_VITEST_E2E', 'OMB_VITEST_SUBSET', 'OMB_VITEST_WORKERS', 'OCPR_SYNC_FREE_BYTES', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) delete env[key];
const results = [];
async function run(name, args) {
  if (!clean()) throw Error('Source head/clean-state guard failed before ' + name);
  const log = join(evidence, name + '.log');
  const output = createWriteStream(log, { flags: 'wx' });
  const startedAt = new Date().toISOString();
  const child = spawn('pnpm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) { stream.pipe(output, { end: false }); stream.pipe(process.stdout, { end: false }); }
  writeFileSync(join(evidence, 'current.json'), JSON.stringify({ at: startedAt, pr, name, head, childPid: child.pid, log, state: 'running; no pass yet' }, null, 2) + '\n');
  const result = await new Promise(resolve => { child.once('error', error => resolve({ error: error.message })); child.once('close', (exit, signal) => resolve({ exit, signal })); });
  await new Promise(resolve => output.end(resolve));
  const receipt = { pr, name, args, head, ...result, startedAt, finishedAt: new Date().toISOString(), unchanged: clean(), log };
  results.push(receipt);
  writeFileSync(join(evidence, name + '.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

let error = null, typecheck, full;
try {
  typecheck = await run('full-typecheck', ['typecheck']);
  if (typecheck.exit !== 0 || !typecheck.unchanged) throw Error('Required full typecheck did not pass');
  full = await run('full-pnpm-test', ['test']);
  if (full.exit !== 0) {
    const log = readFileSync(full.log, 'utf8');
    for (const component of ['broker:test', 'test:electron', 'test:packaged-server']) {
      const ran = log.split('\n').some(line => line.startsWith('> openmausbot@') && line.includes(' ' + component + ' '));
      if (!ran) await run('remaining-' + component.replaceAll(':', '-'), [component]);
    }
  }
} catch (failure) { error = String(failure.stack || failure); }
const passed = !error && typecheck?.exit === 0 && typecheck.unchanged && full?.exit === 0 && full.unchanged;
const summary = {
  at: new Date().toISOString(), sourceHead: head, pr, platform: process.platform, release: os.release(), node: process.version,
  pnpm: execFileSync('pnpm', ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(), ci: process.env.CI === 'true',
  fullTypecheckAndTestPassed: passed, sourceUnchanged: clean(), results, error,
  scope: 'Unfiltered pnpm test on a separate Linux GitHub runner, project default worker setting; no subset/shard/disk preload or worker override. This never replaces the local Mac result.',
  retries: 'Project CI-only known-flake retry behavior is unchanged; project-ci-retries.jsonl retains any retries. A separate component pass does not turn a failed full command into a pass.',
};
writeFileSync(join(evidence, 'full-result.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
if (!passed) process.exitCode = 1;
