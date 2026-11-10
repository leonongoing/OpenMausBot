import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome, launchPipeChrome } from './proof-chrome.ts';

const root = process.cwd();
const evidence = process.env.OCPR_EVIDENCE_DIR;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (!evidence || git('status','--porcelain')) throw Error('Expected clean source and evidence path');
const binary = findChrome();
if (!binary) throw Error('Chrome missing');
mkdirSync(evidence,{recursive:true});
const files = [];
function fixture(path,data) {
  const file = join(root,path);
  writeFileSync(file,data,{flag:'wx'});
  files.push(file);
}
let vite, chrome;
try {
  const original = 'src/components/McpServersPanel.tsx';
  for (const [mode,body] of [['Before',git('show','HEAD^:'+original)],['After',readFileSync(original,'utf8')]]) {
    const store = 'from "@/state/store"';
    if (body.split(store).length!==2) throw Error('Unexpected store import');
    fixture('src/components/ocprMcp'+mode+'.tsx',body.replace(store,'from "./ocprMcpStore"'));
  }
  fixture('src/components/ocprMcpStore.ts',`
let requests = 0;
const store = { config: null, bots: [] };
const dispatch = () => {};
export const useStore = () => ({ state: store, dispatch });
export async function api(path: string) {
  if (path !== "/api/mcp/servers") throw Error("Unexpected fixture request " + path);
  document.documentElement.dataset.fixtureRequests = String(++requests);
  if (requests === 1) throw Error("no route: GET /api/mcp/servers");
  return { servers: [] };
}
`);
  fixture('ocpr-mcp-proof.html','<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/src/ocpr-mcp-proof.tsx"></script></html>');
  fixture('src/ocpr-mcp-proof.tsx',`
import { createRoot } from "react-dom/client";
import { McpServersPanel as Before } from "./components/ocprMcpBefore";
import { McpServersPanel as After } from "./components/ocprMcpAfter";
import { applySkinChoice } from "./lib/skins";
import "./styles.css";
applySkinChoice("daylight");
const Panel = location.search.includes("before") ? Before : After;
createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 760, margin: "auto", padding: "24px 18px 30px" }}>
    <h1 style={{fontSize:20,fontWeight:600,marginBottom:12}}>Apps</h1>
    <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <Panel hostedCards={{ shown: () => true, onConnections: () => {} }} />
    </section>
  </main>
);
`);
  const {createServer}=await import(join(root,'node_modules/vite/dist/node/index.js'));
  vite=await createServer({server:{host:'127.0.0.1',port:0},clearScreen:false});
  await vite.listen();
  const {port}=vite.httpServer.address();
  chrome=await launchPipeChrome(binary,['--window-size=840,820']);
  const page=await chrome.page();
  const wait=condition=>page.evaluate(`new Promise((resolve,reject)=>{
    const end=Date.now()+18000;
    const poll=()=>{if(${condition}) return resolve(true); if(Date.now()>end) return reject(Error(document.body.innerText)); setTimeout(poll,70);};
    poll();
  })`,20000);
  const read=()=>page.evaluate(`({
    alerts:[...document.querySelectorAll('main [role=alert]')].map(x=>x.innerText),
    tiles:document.querySelectorAll('main [data-app-tile]').length,
    retries:[...document.querySelectorAll('main button')].filter(x=>x.innerText.trim()==='Retry').length,
    requests:Number(document.documentElement.dataset.fixtureRequests),
    width:innerWidth,scrollWidth:document.documentElement.scrollWidth
  })`);
  const results=[];
  for(const mode of ['before','after']) {
    for(const [layout,width] of [['desktop',840],['mobile',390]]) {
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:820,deviceScaleFactor:1,mobile:layout==='mobile'});
      const url='http://127.0.0.1:'+port+'/ocpr-mcp-proof.html?'+mode;
      await page.navigate(url); await page.loaded(url);
      await wait("document.querySelector('main [role=alert]') && [...document.querySelectorAll('main button')].some(x=>x.innerText.trim()==='Retry' && !x.disabled)");
      const errors=await read();
      const expected=mode==='before'?6:1;
      if(errors.alerts.length!==expected||errors.retries!==expected||errors.requests!==1||errors.scrollWidth>width) throw Error(JSON.stringify(errors));
      if(mode==='after'&&errors.tiles!==0) throw Error('Error shown with app tiles');
      const save=async label=>writeFileSync(join(evidence,label+'.png'),Buffer.from((await page.screenshot()).data,'base64'));
      await page.evaluate('document.fonts.ready.then(()=>true)');
      await save(mode+'-'+layout);
      let retried=null;
      if(mode==='after'){
        const point=await page.evaluate(`(()=>{const button=[...document.querySelectorAll('main button')].find(x=>x.innerText.trim()==='Retry'); const r=button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
        await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});
        await wait("document.documentElement.dataset.fixtureRequests==='2' && !document.querySelector('main [role=alert]') && document.querySelectorAll('main [data-app-tile]').length===6");
        retried=await read();
        if(retried.retries||retried.scrollWidth>width) throw Error(JSON.stringify(retried));
        await save('retry-'+layout);
      }
      results.push({mode,layout,errors,retried});
    }
  }
  writeFileSync(join(evidence,'proof.json'),JSON.stringify({head:git('rev-parse','HEAD'),base:git('rev-parse','HEAD^'),results,
    scope:'Actual MCP panel and app styles in Chrome. Only the store/API module was replaced with a disposable fixture, first rejection then empty list.'},null,2)+'\n');
} finally {
  await chrome?.close();
  await vite?.close();
  for(const file of files) rmSync(file);
}
if(git('status','--porcelain')) throw Error('Fixture did not leave source clean');
