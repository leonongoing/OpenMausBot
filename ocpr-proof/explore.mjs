import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchSwipeUi } from './ui-session.mjs';

const mode = process.argv[2];
const evidence = process.env.OCPR_EVIDENCE_DIR;
if (!evidence || !['before', 'after'].includes(mode)) throw Error('Explicit isolated evidence root and mode required');
mkdirSync(evidence, { recursive: true });
let ui;
const runtimeErrors = [];
try {
  ui = await launchSwipeUi(mode);
  ui.page.on('Runtime.exceptionThrown', event => runtimeErrors.push(event));
  await ui.page.send('Runtime.enable');
  await ui.page.evaluate(`new Promise((resolve,reject)=>{
    const deadline=Date.now()+90000;
    const check=()=>{
      if(document.body.innerText.trim().length>40&&document.querySelectorAll('button').length>3)return resolve(true);
      if(Date.now()>deadline)return reject(Error('Application did not render'));
      requestAnimationFrame(check);
    };check();
  })`, 95000);
  ui.assertActive();
  const dom = await ui.page.evaluate(`({
    title:document.title,url:location.href,text:document.body.innerText.slice(0,14000),html:document.body.outerHTML.slice(0,200000),
    viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touchPoints:navigator.maxTouchPoints,userAgent:navigator.userAgent},
    buttons:[...document.querySelectorAll('button')].map(b=>{
      const r=b.getBoundingClientRect();return {text:b.innerText.trim().slice(0,120),aria:b.getAttribute('aria-label'),attributes:[...b.attributes].filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value]),rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth};
    }),
    rows:[...document.querySelectorAll('[data-message-row]')].map(r=>({id:r.closest('[data-mid]')?.getAttribute('data-mid'),text:r.innerText.slice(0,500)})),
    composer:Boolean(document.querySelector('textarea'))
  })`);
  const screenshot = await ui.page.screenshot();
  writeFileSync(join(evidence, `${mode}-initial.png`), Buffer.from(screenshot.data, 'base64'));
  writeFileSync(join(evidence, `${mode}-initial-dom.json`), JSON.stringify({ at: new Date().toISOString(), info: ui.info, dom, runtimeErrors, baselineLoaded: ui.baselineLoaded(), applicationLoaded: true, inputAssertionsRun: false, qualification: 'Exploration only. No gesture, quote selection or animation claim yet.' }, null, 2) + '\n');
  writeFileSync(join(evidence, `${mode}-server.log`), readFileSync(ui.info.fixture.logPath));
  if (runtimeErrors.length) throw Error('Application runtime exceptions: ' + JSON.stringify(runtimeErrors).slice(0,1000));
  console.log(JSON.stringify({ mode, applicationLoaded: true, source: ui.info.expectedHead, buttons: dom.buttons.length, rows: dom.rows.length, inputAssertionsRun: false }));
} catch (error) {
  let dom;
  try { dom = await ui?.page.evaluate('({url:location.href,text:document.body.innerText,html:document.body.outerHTML.slice(0,100000)})'); } catch (e) { dom = { error: String(e) }; }
  writeFileSync(join(evidence, `${mode}-explore-failure.json`), JSON.stringify({ at: new Date().toISOString(), error: String(error.stack || error), info: ui?.info, runtimeErrors, dom }, null, 2) + '\n');
  throw error;
} finally {
  await ui?.close();
}
