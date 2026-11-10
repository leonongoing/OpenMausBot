import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const evidence = process.env.OCPR_EVIDENCE_DIR;
if (!evidence) throw Error('Missing artifact directory');
mkdirSync(evidence, { recursive: true });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
if (git('status', '--porcelain')) throw Error('Expected clean source');

const driverPath = 'server/drivers/pi.ts';
const testPath = 'server/drivers/pi-lifecycle.test.ts';
const driver = readFileSync(driverPath, 'utf8');
const original = readFileSync(testPath, 'utf8');
const anchor = '    expect(request?.rw).toEqual([dirname(configPath!)]);';
if (original.split(anchor).length !== 2) throw Error('Unexpected fixture source');
const snippet = `
    if (!request || !configPath) throw Error("Missing real Pi launch request");
    const plan = planBox({ dataDir: join(dir, "data"), home: dir, codeRoots: [], engineRoots: [], bridges: [] },
      { ...request, command: "/bin/sh", args: [], cwd: undefined, env: { PATH: "/usr/bin:/bin" } });
    const probe = spawnSync("/usr/bin/bwrap", [
      ...bwrapArgs(plan), "--chdir", "/", "--", "/bin/sh", "-c",
      'if [ ! -r "$1" ]; then echo pi-box-config-hidden; exit 42; fi; /bin/cat "$1"; printf ready > "$2"',
      "pi-box", configPath, join(dirname(configPath), "scope-ready.json"),
    ], { encoding: "utf8", timeout: 15000 });
    console.log(JSON.stringify({ piBoxExit: probe.status, stdout: probe.stdout, stderr: probe.stderr }));
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout)).toMatchObject({ askUser: true, mcpServers: {} });
    expect(readFileSync(join(dirname(configPath), "scope-ready.json"), "utf8")).toBe("ready");
`;
const modified = 'import { spawnSync } from "node:child_process";\nimport { bwrapArgs, planBox } from "../bot-box/plan.ts";\n'
  + original.replace(anchor, snippet + anchor);
try {
  writeFileSync(testPath, modified);
  for (const mode of ['before', 'after']) {
    writeFileSync(driverPath, mode === 'before' ? git('show', 'HEAD^:' + driverPath) : driver);
    const run = spawnSync('pnpm', ['exec','vitest','run',testPath,'-t','private turn MCP configuration'],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    const log = run.stdout + '\n' + run.stderr;
    writeFileSync(join(evidence, mode + '.log'), log);
    console.log(log);
    if (run.error) throw run.error;
    if (mode === 'before' && (run.status !== 1 || !log.includes('"piBoxExit":42') || !log.includes('pi-box-config-hidden'))) {
      throw Error('Baseline did not reach the expected missing-file boundary');
    }
    if (mode === 'after' && (run.status !== 0 || !log.includes('"piBoxExit":0'))) {
      throw Error('Fixed Linux box did not read and write its private turn directory');
    }
  }
} finally {
  writeFileSync(driverPath, driver);
  writeFileSync(testPath, original);
}
if (git('status', '--porcelain')) throw Error('Proof changed the source');
