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
  const waitFor = async (expression, label) => ui.page.evaluate(`new Promise((resolve,reject)=>{
    const deadline=Date.now()+90000;
    const check=()=>{if(${expression})return resolve(true);
      if(Date.now()>deadline)return reject(Error(${JSON.stringify(label)}));
      setTimeout(check,100);};check();})`,95000);
  const tap = async expression => {
    await waitFor(`(()=>{const el=${expression};if(!el)return false;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&el.contains(document.elementFromPoint(x,y));})()`,'Tap target is not visible or is covered');
    const point=await ui.page.evaluate(`(()=>{const el=${expression};if(!el)throw Error('Tap target missing');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await ui.page.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});
    await ui.page.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  await waitFor(`document.querySelector('[data-message-row]') || [...document.querySelectorAll('button')].some(b=>b.innerText.includes('Pepper'))`, 'Hydrated bot list missing');
  await waitFor(`Boolean(document.querySelector('[data-mausbot-welcome-later]'))`,'Expected fixture first-run welcome missing');
  {
    await tap(`document.querySelector('[data-mausbot-welcome-later]')`);
    await waitFor(`!document.querySelector('[data-mausbot-welcome-later]')`,'Welcome dialog did not dismiss');
  }
  const pepperButton=`document.querySelector('[data-sidebar-bot-row="${ui.info.botId}"]')`;
  const visible=await ui.page.evaluate(`(()=>{const b=${pepperButton};const r=b?.getBoundingClientRect();return r&&r.x>=0&&r.x<innerWidth&&r.y>=0&&r.y<innerHeight;})()`);
  if(!visible)await tap(`document.querySelector('button[aria-label="Open bot list"]')`);
  await tap(pepperButton);
  await waitFor(`document.querySelector('textarea') && [...document.querySelectorAll('[data-message-row]')].some(r=>r.innerText.includes('SWIPE_USER_RELEASE_')) && [...document.querySelectorAll('[data-message-row]')].some(r=>r.innerText.includes('SWIPE_BOT_RELEASE'))`, 'Hydrated seeded conversation missing');
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
  const frames=[],screencastErrors=[];
  ui.page.on('Page.screencastFrame',event=>{
    const file=`${mode}-frame-${String(frames.length).padStart(5,'0')}.png`;
    writeFileSync(join(evidence,file),Buffer.from(event.data,'base64'));
    frames.push({file,timestamp:event.metadata.timestamp});
    void ui.page.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(e=>screencastErrors.push(String(e)));
  });
  await ui.page.send('Page.startScreencast',{format:'png',maxWidth:390,maxHeight:844,everyNthFrame:1});
  await ui.page.evaluate(`window.__swipeEvents=[];for(const name of ['touchstart','touchmove','touchend','touchcancel']) document.addEventListener(name,e=>window.__swipeEvents.push({type:e.type,trusted:e.isTrusted,cancelable:e.cancelable,prevented:e.defaultPrevented}),{passive:true});`);
  const cases=[];
  for(const surface of [{kind:'chat',markers:['SWIPE_USER_RELEASE_3','SWIPE_BOT_RELEASE']},{kind:'room',markers:['SWIPE_ROOM_USER','SWIPE_BOT_RELEASE']}]) {
    if(surface.kind==='room') {
      await tap(`document.querySelector('button[aria-label="Open bot list"]')`);
      await tap(`document.querySelector('[data-sidebar-group-row="${ui.info.roomId}"]')`);
      await waitFor(`document.querySelector('textarea')&&[...document.querySelectorAll('[data-message-row]')].some(r=>r.innerText.includes('SWIPE_ROOM_USER'))`,'Seeded room did not open');
    }
    for(const marker of surface.markers) {
    const targetExpression=`[...document.querySelectorAll('[data-message-row]')].filter(r=>r.innerText.includes(${JSON.stringify(marker)})).at(-1)`;
    const point=await ui.page.evaluate(`(()=>{const row=${targetExpression};if(!row)throw Error('Missing swipe row');const p=row.querySelector('p')||row.querySelector('.chat-text')||row;p.scrollIntoView({block:'center'});const r=p.getBoundingClientRect();return {x:Math.max(20,Math.min(innerWidth-110,r.x+20)),y:Math.max(60,Math.min(innerHeight-160,r.y+20)),id:row.closest('[data-mid]')?.getAttribute('data-mid'),text:row.innerText.slice(0,200)};})()`);
    if(!point.id)throw Error('Message source ID missing');
    await ui.page.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1}]});
    for(const dx of [2,6,14,30,50,70,82]) {
      await ui.page.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+dx,y:point.y+1,id:1}]});
      await ui.page.evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    }
    const moving=await ui.page.evaluate(`({translate:(${targetExpression}).style.translate,icon:Boolean(document.querySelector('[data-swipe-reply]')),quote:document.querySelector('[data-composer-reply]')?.innerText??null})`);
    writeFileSync(join(evidence,`${mode}-${surface.kind}-${marker}-drag.png`),Buffer.from((await ui.page.screenshot()).data,'base64'));
    await ui.page.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    if(mode==='after')await waitFor(`Boolean(document.querySelector('[data-composer-reply]'))`,'Swipe did not open quote preview');
    else await ui.page.evaluate('new Promise(resolve=>setTimeout(resolve,300))');
    const released=await ui.page.evaluate(`({translate:(${targetExpression}).style.translate,quote:document.querySelector('[data-composer-reply]')?.innerText??null,events:window.__swipeEvents.splice(0)})`);
    if(mode==='before'&&released.quote)throw Error('Baseline unexpectedly supports swipe reply');
    if(mode==='after'&&(!released.quote?.includes(marker)||moving.quote||!moving.icon||moving.translate!=='80px'||!released.events.some(e=>e.type==='touchmove'&&e.trusted&&e.prevented)))throw Error('Swipe quote/gesture contract failed: '+JSON.stringify({moving,released}));
    if(mode==='after')await waitFor(`Math.abs(parseFloat(getComputedStyle(${targetExpression}).translate)||0)<0.1`,'Message did not return after release');
    writeFileSync(join(evidence,`${mode}-${surface.kind}-${marker}-released.png`),Buffer.from((await ui.page.screenshot()).data,'base64'));
    const result={surface:surface.kind,marker,point,moving,released};
    if(mode==='after') {
      const text=`NATIVE_QUOTE_READBACK_${surface.kind}_${marker}`;
      await tap(`document.querySelector('textarea')`);
      await waitFor(`document.activeElement===document.querySelector('textarea')`,'Composer did not focus after native tap');
      await ui.page.send('Input.insertText',{text});
      await waitFor(`document.querySelector('button[aria-label="Send message"]:not(:disabled)')`,'Send button not ready');
      await tap(`document.querySelector('button[aria-label="Send message"]')`);
      const target=surface.kind==='chat'?['--bot',ui.info.botId]:['--channel',ui.info.roomId];
      const settled=await ui.control(['wait',...target,'--timeout','30']);
      if(settled.status!=='settled')throw Error('Native reply did not settle: '+JSON.stringify(settled));
      const transcript=await ui.control(['messages',...target,'--limit','40']);
      const found=[];
      const visit=value=>{if(!value||typeof value!=='object')return;if(value.text===text)found.push(value);for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);};
      visit(transcript);
      if(!found.length||!found.every(m=>m.replyToId===point.id))throw Error('Saved reply does not reference swiped message: '+JSON.stringify({sourceId:point.id,found,transcript}));
      result.savedReply=found;result.wait=settled;
      writeFileSync(join(evidence,`${mode}-${surface.kind}-${marker}-transcript.json`),JSON.stringify(transcript,null,2)+'\n');
    }
    cases.push(result);
    }
  }
  const longPressRow=`[...document.querySelectorAll('[data-message-row]')].find(r=>r.innerText.includes('SWIPE_ROOM_USER:'))`;
  const longPressPoint=await ui.page.evaluate(`(()=>{const row=${longPressRow};if(!row)throw Error('Original room message missing');const text=row.querySelector('.chat-text')||row.querySelector('p')||row;text.scrollIntoView({block:'center'});const r=text.getBoundingClientRect();return {x:Math.min(innerWidth-40,r.x+20),y:Math.max(80,Math.min(innerHeight-160,r.y+20)),sourceId:row.closest('[data-mid]')?.getAttribute('data-mid')};})()`);
  await ui.page.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:longPressPoint.x,y:longPressPoint.y,id:1}]});
  await waitFor(`(${longPressRow}).querySelector('[data-testid="message-actions"][data-shown="true"]')`,'Long press did not expose message actions');
  await ui.page.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  if(await ui.page.evaluate(`Boolean(document.querySelector('[data-composer-reply]'))`))throw Error('Long press selected a swipe reply');
  await tap(`(${longPressRow}).querySelector('button[aria-label="Message actions"]')`);
  await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some(b=>b.innerText.trim()==='Reply')`,'Long press menu has no Reply');
  await tap(`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.innerText.trim()==='Reply')`);
  await waitFor(`document.querySelector('[data-composer-reply]')?.innerText.includes('SWIPE_ROOM_USER:')`,'Existing menu Reply did not select original message');
  writeFileSync(join(evidence,`${mode}-longpress-reply.png`),Buffer.from((await ui.page.screenshot()).data,'base64'));
  writeFileSync(join(evidence,`${mode}-longpress.json`),JSON.stringify({mode,source:ui.info.expectedHead,point:longPressPoint,actionsExposed:true,replyViaExistingMenu:true,quote:await ui.page.evaluate(`document.querySelector('[data-composer-reply]').innerText`)},null,2)+'\n');
  await tap(`document.querySelector('[data-composer-reply] button')`);
  writeFileSync(join(evidence,`${mode}-native-touch.json`),JSON.stringify({source:ui.info.expectedHead,mode,cases,qualification:'Chrome mobile emulation; not physical Android. Chat and room user/bot swipe, quote preview and saved source ID readback; scrolling, selection and long press browser checks still pending.'},null,2)+'\n');
  await ui.page.evaluate('new Promise(resolve=>setTimeout(resolve,250))');
  await ui.page.send('Page.stopScreencast');
  if(frames.length<3||screencastErrors.length)throw Error('Screencast failed: '+JSON.stringify({frames:frames.length,screencastErrors}));
  const playlist=['ffconcat version 1.0'];
  for(let i=0;i<frames.length;i++) {
    playlist.push(`file '${frames[i].file}'`);
    if(i<frames.length-1)playlist.push(`duration ${Math.max(0.001,frames[i+1].timestamp-frames[i].timestamp)}`);
  }
  playlist.push(`file '${frames.at(-1).file}'`);
  writeFileSync(join(evidence,`${mode}-frames.ffconcat`),playlist.join('\n')+'\n');
  writeFileSync(join(evidence,`${mode}-screencast.json`),JSON.stringify({frames,screencastErrors,qualification:'Actual browser screencast frames and original timestamps; MP4 encoding remains pending on operator host because runner has no ffmpeg; no synthetic animation'},null,2)+'\n');
  writeFileSync(join(evidence, `${mode}-server.log`), readFileSync(ui.info.fixture.logPath));
  if (runtimeErrors.length) throw Error('Application runtime exceptions: ' + JSON.stringify(runtimeErrors).slice(0,1000));
  console.log(JSON.stringify({ mode, applicationLoaded: true, source: ui.info.expectedHead, buttons: dom.buttons.length, rows: dom.rows.length, inputAssertionsRun: true, nativeTouchCases: cases.length, videoEncodingPending: true }));
} catch (error) {
  let dom;
  try { const shot=await ui?.page.screenshot();if(shot)writeFileSync(join(evidence,`${mode}-failure.png`),Buffer.from(shot.data,'base64')); } catch {}
  try { dom = await ui?.page.evaluate('({url:location.href,text:document.body.innerText,html:document.body.outerHTML.slice(0,100000)})'); } catch (e) { dom = { error: String(e) }; }
  writeFileSync(join(evidence, `${mode}-explore-failure.json`), JSON.stringify({ at: new Date().toISOString(), error: String(error.stack || error), info: ui?.info, runtimeErrors, dom }, null, 2) + '\n');
  throw error;
} finally {
  await ui?.close();
}
