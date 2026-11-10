import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { launchHtmlUi } from './html-session.mjs';

const mode=process.argv[2], evidence=process.env.OCPR_EVIDENCE_DIR;
if(!evidence||!['before','after'].includes(mode))throw Error('Explicit evidence root and mode required');
mkdirSync(evidence,{recursive:true});
const requests=[],downloads=[],runtimeErrors=[];
const sink=createServer((req,res)=>{requests.push({url:req.url,at:new Date().toISOString()});res.setHeader('content-type',req.url?.endsWith('.css')?'text/css':'text/javascript');res.end('document.body.dataset.externalRan="yes";');});
await new Promise((resolve,reject)=>{sink.once('error',reject);sink.listen(0,'127.0.0.1',resolve);});
const sinkUrl=`http://127.0.0.1:${sink.address().port}`;
const name='synthetic-report.html';
const source=`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic report</title><link rel="stylesheet" href="${sinkUrl}/remote.css"><style>body{font:15px system-ui;padding:20px;color:#172033}h1{font-size:24px}#chart{padding:35px;background:#eef2f7;border-radius:12px;color:#64748b}</style></head><body><h1>Synthetic release report</h1><p>This report contains an interactive chart and external assets.</p><div id="chart">Loading chart…</div><p><img src="${sinkUrl}/diagram.png" alt="External diagram"></p><script src="${sinkUrl}/chart.js"></script><script>document.body.dataset.scriptRan='yes';document.getElementById('chart').textContent='Interactive chart loaded';</script></body></html>`;
const input=join(evidence,`${mode}-${name}`);writeFileSync(input,source);
const sha=value=>createHash('sha256').update(value).digest('hex');
let ui;
const hostWait=async(check,label)=>{const end=Date.now()+90000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,80));}throw Error(label);};
try {
  ui=await launchHtmlUi(mode);
  ui.page.on('Runtime.exceptionThrown',event=>runtimeErrors.push(event));
  await ui.page.send('Runtime.enable');
  const waitFor=async(expression,label)=>ui.page.evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+90000;const check=()=>{if(${expression})return resolve(true);if(Date.now()>end)return reject(Error(${JSON.stringify(label)}));setTimeout(check,80);};check();})`,95000);
  const click=async expression=>{
    await waitFor(`(()=>{const el=${expression};if(!el)return false;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&el.contains(document.elementFromPoint(x,y));})()`,'Native click target missing or covered');
    const point=await ui.page.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await ui.page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
    await ui.page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});
  };
  await waitFor(`document.querySelector('[data-mausbot-welcome-later]')`,'Fixture welcome missing');
  await click(`document.querySelector('[data-mausbot-welcome-later]')`);
  await waitFor(`!document.querySelector('[data-mausbot-welcome-later]')&&document.querySelector('textarea')&&document.querySelector('[data-composer-row] input[type=file]')`,'Composer not hydrated');
  const workspace=join(ui.info.fixture.dataDir,'workspaces',ui.info.botId);mkdirSync(workspace,{recursive:true});
  const deliveredFile=join(workspace,name);writeFileSync(deliveredFile,source);
  writeFileSync(join(evidence,`${mode}-tool-calls.json`),JSON.stringify([{name:'attach_file',server:'agents',input:{path:deliveredFile}}]));
  await click(`document.querySelector('textarea')`);
  await ui.page.send('Input.insertText',{text:'Please attach the synthetic HTML report.'});
  await waitFor(`document.querySelector('button[aria-label="Send message"]:not(:disabled)')`,'Composer send not ready');
  await click(`document.querySelector('button[aria-label="Send message"]')`);
  const settled=await ui.control(['wait','--bot',ui.info.botId,'--timeout','30']);
  if(settled.status!=='settled')throw Error('Attachment turn did not settle: '+JSON.stringify(settled));
  const fileButton=`[...document.querySelectorAll('[data-mid] button[aria-label="Preview page: ${name}"]')].find(b=>b.innerText.includes(${JSON.stringify(name)}))`;
  await waitFor(fileButton,'Sent attachment preview not present');
  await click(fileButton);
  const frameSelector=`iframe[title="Preview of ${name}"]`;
  await waitFor(`document.querySelector(${JSON.stringify(frameSelector)})`,'HTML preview frame missing');
  const tree=await ui.page.send('Page.getFrameTree');
  const frames=[];const visit=node=>{frames.push(node.frame);for(const child of node.childFrames??[])visit(child);};visit(tree.frameTree);
  const child=frames.find(frame=>frame.url==='about:srcdoc');if(!child)throw Error('Preview child frame missing');
  const {executionContextId}=await ui.page.send('Page.createIsolatedWorld',{frameId:child.id,worldName:'html-preview-proof'});
  const frameRead=async()=>{
    const answer=await ui.page.send('Runtime.evaluate',{contextId:executionContextId,returnByValue:true,expression:`({ready:document.readyState,text:document.body?.innerText,scriptRan:document.body?.dataset.scriptRan??null,externalRan:document.body?.dataset.externalRan??null,chart:document.querySelector('#chart')?.textContent,csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content})`});
    if(answer.exceptionDetails)throw Error(JSON.stringify(answer.exceptionDetails));return answer.result.value;
  };
  const content=await hostWait(async()=>{const value=await frameRead();return value.ready==='complete'?value:null;},'Preview document did not load');
  const frame=await ui.page.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(frameSelector)});return {sandbox:f.getAttribute('sandbox'),referrerPolicy:f.referrerPolicy,srcDoc:f.srcdoc};})()`);
  const note=await ui.page.evaluate(`document.querySelector('dialog[open] [role=note]')?.innerText??null`);
  if(frame.sandbox!==''||frame.referrerPolicy!=='no-referrer'||!frame.srcDoc.endsWith(source))throw Error('Preview guards or original source changed');
  if(content.scriptRan||content.externalRan||content.chart!=='Loading chart…'||requests.length)throw Error('Preview executed scripts or fetched external resources: '+JSON.stringify({content,requests}));
  if(!content.csp?.includes("default-src 'none'"))throw Error('Preview policy missing');
  if(mode==='before'&&note!==null)throw Error('Baseline unexpectedly has preview notice');
  if(mode==='after'&&(!note?.includes('Scripts and external resources are disabled in this preview.')||!note.includes('Download the original file')))throw Error('Preview notice missing');
  writeFileSync(join(evidence,`${mode}-desktop.png`),Buffer.from((await ui.page.screenshot()).data,'base64'));
  const desktop=await ui.page.evaluate(`({width:innerWidth,height:innerHeight,text:document.querySelector('dialog[open]')?.innerText})`);
  await ui.page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await ui.page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  writeFileSync(join(evidence,`${mode}-mobile.png`),Buffer.from((await ui.page.screenshot()).data,'base64'));
  const mobile=await ui.page.evaluate(`({width:innerWidth,height:innerHeight,note:document.querySelector('dialog[open] [role=note]')?.getBoundingClientRect().toJSON(),dialog:document.querySelector('dialog[open]')?.getBoundingClientRect().toJSON()})`);
  if(mobile.dialog&&(mobile.dialog.left<0||mobile.dialog.right>mobile.width))throw Error('Dialog overflows mobile viewport');
  if(mode==='after'&&(!mobile.note||mobile.note.left<0||mobile.note.right>390||mobile.note.bottom>844))throw Error('Notice not visible on mobile');
  const downloadDir=join(evidence,`${mode}-downloads`);mkdirSync(downloadDir,{recursive:true});
  ui.browserOn('Browser.downloadProgress',event=>downloads.push(event));
  await ui.browserSend('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:downloadDir,eventsEnabled:true});
  await click(`document.querySelector('dialog[open] button[aria-label="Save a copy of ${name}"]')`);
  const completed=await hostWait(()=>downloads.find(d=>d.state==='completed'),'Original file download did not complete');
  const downloaded=completed.filePath??join(downloadDir,completed.guid);
  if(!existsSync(downloaded)||!readFileSync(downloaded).equals(Buffer.from(source)))throw Error('Downloaded original bytes changed');
  const result={at:new Date().toISOString(),mode,sourceHead:ui.info.expectedHead,baseline:ui.info.baseline,sourceSha256:sha(source),downloadSha256:sha(readFileSync(downloaded)),downloadedBytes:readFileSync(downloaded).length,originalDownloadVerified:true,frame,content,note,desktop,mobile,forbiddenRequests:requests,downloads,baselineLoaded:ui.baselineLoaded(),runtimeErrors,scope:'Real composer send, fake-engine attach_file delivery, private attachment preview, opaque sandbox readback and native download in isolated fake-engine app. Chrome desktop and mobile layout emulation, not physical phone.'};
  if(runtimeErrors.length)throw Error('App runtime exceptions: '+JSON.stringify(runtimeErrors));
  writeFileSync(join(evidence,`${mode}-result.json`),JSON.stringify(result,null,2)+'\n');
  writeFileSync(join(evidence,`${mode}-server.log`),readFileSync(ui.info.fixture.logPath));
  console.log(JSON.stringify({mode,notice:Boolean(note),sandboxPreserved:true,externalRequests:requests.length,originalDownloadVerified:true,sourceHead:ui.info.expectedHead}));
} catch(error) {
  let dom;try{dom=await ui?.page.evaluate(`({text:document.body.innerText,html:document.body.outerHTML.slice(0,160000)})`);const shot=await ui?.page.screenshot();if(shot)writeFileSync(join(evidence,`${mode}-failure.png`),Buffer.from(shot.data,'base64'));}catch(e){dom={error:String(e)};}
  writeFileSync(join(evidence,`${mode}-failure.json`),JSON.stringify({at:new Date().toISOString(),error:String(error.stack||error),info:ui?.info,dom,requests,downloads,runtimeErrors},null,2)+'\n');throw error;
} finally {
  await ui?.close();sink.closeAllConnections();await new Promise(resolve=>sink.close(resolve));
}
