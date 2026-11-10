import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { findChrome, launchPipeChrome } from './proof-chrome.ts';

const root = process.env.OCPR_SOURCE_DIR;
const evidence = process.env.OCPR_EVIDENCE_DIR;
if (!root || !evidence) throw Error('Explicit isolated source/evidence roots required');
mkdirSync(evidence, { recursive: true });
const { createServer } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
const { launchVerificationServer, runControlOmb } = await import(pathToFileURL(join(root, 'scripts/control-omb.ts')).href);
const { fixtureApi } = await import(pathToFileURL(join(root, 'scripts/testing/preview-fixture.ts')).href);
const expectedHead = '961198857d94718c98b1309819cdd0b0dc6b0f7e';
const baseline = '6199598b66fe520e165b05eff69ed55fd081fad9';
const sourcePaths = ['src/components/HtmlFilePreview.tsx'];
const hash = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
const available = () => { const s = statfsSync(root); return s.bavail * s.bsize; };

function resourceStatus() {
  const memory = readFileSync('/proc/meminfo', 'utf8');
  const total = Number(memory.match(/^MemTotal:\s*(\d+)/m)?.[1]);
  const free = Number(memory.match(/^MemAvailable:\s*(\d+)/m)?.[1]);
  return { at: new Date().toISOString(), availableBytes: available(), memoryFreePercent: Math.floor(free / total * 100), primaryRssKiB: 0, primaryChrome: [], runner: 'isolated GitHub Ubuntu runner; local Mac primary is separate' };
}

export async function launchHtmlUi(mode) {
  if (!['before', 'after'].includes(mode)) throw Error('Explicit before/after mode required');
  if (process.env.NODE_OPTIONS !== '--max-old-space-size=512') throw Error('Explicit bounded UI Node heap required');
  if (git(['rev-parse', 'HEAD']) !== expectedHead || git(['status', '--porcelain'])) throw Error('Source head or clean state changed');
  const attempt = `${mode}-${Date.now()}`;
  let fixture, vite, browser, page, timer, abortReason = null, failure = null;
  const samples = [], loadedBaseline = new Set();
  const ownedPids = [], cleanupErrors = [];
  const progress = phase => {
    const row = { at: new Date().toISOString(), phase, attempt, parentPid: process.pid, fixture: fixture?.info ?? null, chrome: browser?.owner ?? null, ownedPids, abortReason, failure, cleanupErrors, baselineFilesLoaded: [...loadedBaseline] };
    appendFileSync(join(evidence, `5318-${attempt}-ui-history.jsonl`), JSON.stringify(row) + '\n');
    writeFileSync(join(evidence, `5318-${attempt}-ui-owner.json`), JSON.stringify(row, null, 2) + '\n');
  };
  const preflight = resourceStatus();
  const check = status => {
    if (status.availableBytes < 3 * 1024 ** 3 || status.memoryFreePercent < 35 || !Number.isFinite(status.memoryFreePercent) || status.primaryChrome.length) throw Error('UI resource floor: ' + JSON.stringify(status));
  };
  check(preflight);
  const close = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    const b = browser; browser = null; await b?.close().catch(error => cleanupErrors.push({ part: 'chrome', error: String(error) }));
    const v = vite; vite = null; await v?.close().catch(error => cleanupErrors.push({ part: 'vite', error: String(error) }));
    const f = fixture; fixture = null; await f?.close().catch(error => cleanupErrors.push({ part: 'fixture', error: String(error) }));
    const liveOwnedPids = ownedPids.filter(pid => { try { execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { stdio: 'ignore' }); return true; } catch { return false; } });
    progress(cleanupErrors.length || liveOwnedPids.length ? 'cleanup-needs-review' : 'owned-fixtures-closed');
    writeFileSync(join(evidence, `5318-${attempt}-ui-resources.json`), JSON.stringify({ at: new Date().toISOString(), preflight, samples, abortReason, failure, cleanupErrors, liveOwnedPids, scope: 'Owned UI fixture only; primary proof never stopped' }, null, 2) + '\n');
  };
  const assertActive = () => { if (abortReason) throw Error(abortReason); };
  try {
    timer = setInterval(() => {
      try { const status = resourceStatus(); samples.push(status); check(status); }
      catch (error) { abortReason = String(error); void close(); }
    }, 5000);
    timer.unref();
    fixture = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
    ownedPids.push(fixture.info.pid);progress('isolated-server-started');assertActive();
    const api=fixtureApi(fixture.info.url);
    const control=async args=>{assertActive();const result=await runControlOmb([...args,'--url',fixture.info.url]);assertActive();return result;};
    await control(['new-bot','--name','Pepper']);
    const {bots}=await api('GET','/api/bots?messages=0');
    const pepper=bots.find(bot=>bot.name==='Pepper');if(!pepper)throw Error('Fixture bot missing');
    writeFileSync(join(fixture.info.dataDir,'room-plan.json'),JSON.stringify({[pepper.id]:{script:[{key:'seed',match:['Prepare to review a synthetic HTML attachment.'],reply:'Ready to review the synthetic report.'}]}}));
    await control(['send','--bot',pepper.id,'--text','Prepare to review a synthetic HTML attachment.']);
    const settled=await control(['wait','--bot',pepper.id,'--timeout','30']);
    if(settled.status!=='settled')throw Error('Fixture chat did not settle');
    const snapshots = new Map(sourcePaths.map(path => {
      const text = execFileSync('/usr/bin/git', ['show', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' });
      return [join(root, path), { path, text, sha256: hash(text), gitBlob: git(['rev-parse', `${baseline}:${path}`]) }];
    }));
    const route = '/__html-notice.html';
    vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] }, proxy: { '/api': { target: fixture.info.url }, '/.well-known/openmausbot/environment': { target: fixture.info.url } } }, plugins: [{
      name: 'isolated-html-preview-control', enforce: 'pre',
      load(id) {
        if (mode !== 'before') return null;
        const snapshot = snapshots.get(id.split('?')[0]);
        if (!snapshot) return null;
        loadedBaseline.add(snapshot.path);
        return snapshot.text;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if ((req.url ?? '').split('?')[0] !== route) return next();
          const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated HTML preview verification</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/threads-preview.tsx"></script></body></html>';
          void server.transformIndexHtml(route, html).then(html => { res.setHeader('content-type', 'text/html'); res.end(html); }).catch(next);
        });
      },
    }] });
    await vite.listen(); assertActive();
    progress('isolated-preview-started');
    const address = vite.httpServer.address();
    const previewUrl = `http://127.0.0.1:${address.port}${route}`;
    browser = await launchPipeChrome(findChrome(), ['--window-size=1100,850', '--js-flags=--max-old-space-size=256']);
    ownedPids.push(browser.owner.pid);
    progress('owned-chrome-started');
    assertActive(); page = await browser.page();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.navigate(previewUrl);
    progress('page-navigated');
    const info = { at: new Date().toISOString(), attempt, mode, expectedHead, baseline, sourceFiles: [...snapshots.values()].map(({ text, ...info }) => info), fixture: fixture.info, previewUrl, botId: pepper.id, limits: { viteNodeHeapMiB: 512, chromeJsHeapMiB: 256 }, proofState: 'Launched only; actual input assertions pending' };
    writeFileSync(join(evidence, `5318-${attempt}-ui-launch.json`), JSON.stringify(info, null, 2) + '\n');
    return { info, page, api, control, browserSend:(method,params)=>browser.send(method,params), browserOn:(method,listener)=>browser.on(method,listener), close, assertActive, resources: () => ({ preflight, samples, abortReason }), baselineLoaded: () => [...loadedBaseline] };
  } catch (error) { failure = String(error); await close(); throw error; }
}
