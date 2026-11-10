import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome, launchPipeChrome } from './proof-chrome.ts';
const root = process.cwd();
const evidence = process.env.OCPR_EVIDENCE_DIR;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const sourceHead = git('rev-parse', 'HEAD').trim();
const baseHead = git('rev-parse', 'HEAD^').trim();
if (!evidence || git('status', '--porcelain')) throw Error('Expected clean source and evidence path');
const binary = findChrome();
if (!binary) throw Error('Chrome missing');
mkdirSync(evidence, { recursive: true });
const html = join(root, 'ocpr-queue-proof.html');
const tsx = join(root, 'src', 'ocpr-queue-proof.tsx');
const baseline = join(root, 'src', 'components', 'ocpr-queue-baseline.tsx');
const created = [];
function write(path, content) { writeFileSync(path, content, { flag:'wx' }); created.push(path); }
let vite, chrome;
try {
  write(baseline, git('show', 'HEAD^:src/components/ComposerQueuedMessages.tsx'));
  write(html, '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/src/ocpr-queue-proof.tsx"></script></html>');
  write(tsx, `
import { createRoot } from "react-dom/client";
import { QueuedComposerMessages as Before } from "./components/ocpr-queue-baseline";
import { QueuedComposerMessages as After } from "./components/ComposerQueuedMessages";
import { applySkinChoice } from "./lib/skins";
import "./styles.css";
applySkinChoice("daylight");
const Q = location.search.includes("before") ? Before : After;
const one = [{ queueId: "one", text: "Please review the updated draft." }];
const two = [...one, { queueId: "two", text: "Check the table as well." }];
const cases = [
  { title: "One queued message", items: one, steerInterrupts: true },
  { title: "Room queue", items: two, steerMode: "next" as const, steerInterrupts: true },
  { title: "Direct chat queue", items: two, steerMode: "all" as const, steerInterrupts: true },
  { title: "Live steering supported", items: two, steerMode: "all" as const, steerInterrupts: false },
];
createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 550, margin: "auto", padding: "24px 10px 30px", display: "grid", gap: 25 }}>
    {cases.map(({title, ...props}) => <section key={title} style={{minWidth:0,paddingBottom:10}}>
      <h2 style={{margin:"0 12px 8px",fontSize:14,fontWeight:600}}>{title}</h2>
      <Q {...props} onSteer={() => {}} onCancel={() => {}} onEdit={() => {}} />
    </section>)}
  </main>,
);
`);
  const { createServer } = await import(join(root,'node_modules/vite/dist/node/index.js'));
  vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, clearScreen: false });
  await vite.listen();
  const { port } = vite.httpServer.address();
  chrome = await launchPipeChrome(binary, ['--window-size=800,780']);
  const page = await chrome.page();
  const results = [];
  for (const mode of ['before', 'after']) {
    const expected = mode === 'before' ? ['Steer','Steer next','Steer all','Steer all'] : ['Stop and send','Stop and send next','Stop and send all','Steer all'];
    for (const [layout, width] of [['desktop',800],['mobile',390]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: layout === 'mobile' });
      const url = 'http://127.0.0.1:' + port + '/ocpr-queue-proof.html?' + mode;
      await page.navigate(url);
      await page.loaded(url);
      const buttons = await page.evaluate(`new Promise((resolve,reject) => {const end=Date.now()+20000; const check=async()=>{const sections=[...document.querySelectorAll('main section')];if(sections.length===4){await document.fonts.ready; return resolve(sections.map(section=>{const button=section.querySelector('button'); const rect=button.getBoundingClientRect(); return {label:button.innerText.trim(), title:button.title, aria:button.getAttribute('aria-label'), left:rect.left, right:rect.right, bottom:rect.bottom, rowOverflow:button.closest('li').scrollWidth>button.closest('li').clientWidth};}));}if(Date.now()>end)return reject(Error(document.body.innerText));setTimeout(check,60);};check();})`,22000);
      if(JSON.stringify(buttons.map(b=>b.label))!==JSON.stringify(expected) || buttons.some(b=>b.left<0||b.right>width||b.bottom>760||b.rowOverflow)) throw Error(JSON.stringify({mode,layout,buttons}));
      if(mode==='after' && buttons.slice(0,3).some(b=>b.aria!==b.label||!b.title.startsWith('Stop the running turn'))) throw Error(JSON.stringify(buttons));
      writeFileSync(join(evidence,mode+'-'+layout+'.png'), Buffer.from((await page.screenshot()).data,'base64'));
      results.push({mode,layout,width,buttons});
    }
  }
  writeFileSync(join(evidence,'proof.json'), JSON.stringify({sourceHead,baseHead,results,scope:'Real queue component in isolated Chromium/Vite fixture; no turn dispatch or physical device.'},null,2)+'\n');
} finally {
  await chrome?.close();
  await vite?.close();
  for(const path of created) rmSync(path);
}
if(git('status','--porcelain')) throw Error('Fixture did not leave source clean');
