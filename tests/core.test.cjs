const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const C = require(path.join(root, 'core.js'));

test('settings bounds and credentials excluded from public settings', () => {
  const v = C.sanitize({...C.DEFAULTS, apiKey:' secret ', fontSize:999, bottom:-9, opacity:8, prefetch:NaN, model:'bad model', target:'invalid'});
  assert.equal(v.apiKey,'secret'); assert.equal(v.fontSize,56); assert.equal(v.bottom,2); assert.equal(v.opacity,1); assert.equal(v.prefetch,45); assert.equal(v.model,'deepseek-flash');
  assert.equal(C.publicSettings(v).apiKey,undefined); assert.equal(C.publicSettings(v).hasApiKey,true);
});
test('JSON3 includes append fragments and caps rolling overlap', () => {
  const cues=C.parseJson3({events:[{tStartMs:0,dDurationMs:5000,segs:[{utf8:'Hello'}]},{tStartMs:600,dDurationMs:1800,aAppend:1,segs:[{utf8:' world'}]},{tStartMs:2500,dDurationMs:1000,segs:[{utf8:'Next'}]}]});
  assert.deepEqual(cues,[{start:0,end:2.5,text:'Hello world'},{start:2.5,end:3.5,text:'Next'}]);
});
test('time lookup handles gaps, seek backwards and exact end boundaries', () => {
  const cues=[{start:1,end:3,text:'A'},{start:5,end:8,text:'B'}];
  assert.equal(C.findCue(cues,0),null); assert.equal(C.findCue(cues,1).text,'A'); assert.equal(C.findCue(cues,3),null); assert.equal(C.findCue(cues,6).text,'B'); assert.equal(C.findCue(cues,2).text,'A'); assert.equal(C.findCue(cues,8),null);
});
test('track choice respects language, manual tracks and selected track', () => {
  const tracks=[{baseUrl:'x',languageCode:'fr',selected:true},{baseUrl:'y',languageCode:'en',kind:'asr'},{baseUrl:'z',languageCode:'en'}];
  assert.equal(C.selectTrack(tracks,'auto').languageCode,'fr'); assert.equal(C.selectTrack(tracks,'en').baseUrl,'z');
});
test('translation mapping uses IDs and rejects missing or duplicate results', () => {
  assert.deepEqual(C.decodeTranslations('{"translations":[{"id":1,"text":"乙"},{"id":0,"text":"甲"}]}',['A','B']),['甲','乙']);
  for (const value of ['{"translations":[]}','{"translations":[{"id":0,"text":"甲"},{"id":0,"text":"乙"}]}','{"translations":[{"id":-1,"text":"甲"},{"id":1,"text":"乙"}]}']) assert.throws(()=>C.decodeTranslations(value,['A','B']));
});
function harness(fetcher) {
  const data={settings:{...C.DEFAULTS,enabled:true,apiKey:'sk-test-only'}};
  const events={}; let access=''; let calls=0; const broadcasts=[];
  const sandbox={console,crypto:webcrypto,TextEncoder,URL,Map,Set,AbortController,setTimeout,clearTimeout,fetch:async(...args)=>{calls++;return fetcher(...args);},chrome:{
    storage:{local:{setAccessLevel:async v=>{access=v.accessLevel;},get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,value),remove:async key=>{delete data[key];}}},
    runtime:{getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:fn=>events.handler=fn}},
    tabs:{query:async()=>[{id:1}],sendMessage:async(...a)=>broadcasts.push(a)}
  }};
  const context=vm.createContext(sandbox);
  sandbox.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
  const sender={url:'chrome-extension://test/popup.html'};
  const dispatch=(message,s=sender)=>new Promise(resolve=>events.handler(message.type==='TRANSLATE'&&message.texts?{...message,...packet(message.texts)}:message,s,resolve));
  return {data,dispatch,get calls(){return calls;},get access(){return access;},broadcasts};
}
function packet(texts, overrides={}) {
  return {type:'TRANSLATE',videoId:'unit-video',source:'en',mode:'timeline',items:texts.map((text,i)=>({key:`cue:${i}`,text,before:[],after:[]})),...overrides};
}
function okay(_url, options) {
  const texts=JSON.parse(options.body).messages[1].content;
  const input=JSON.parse(texts).subtitles;
  return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:input.map(x=>({id:x.id,text:'译：'+x.text}))})}}]})};
}
test('background uses official host, nonthinking JSON and never returns credentials',async()=>{
  const h=harness((url,opts)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.credentials,'omit');assert.equal(JSON.parse(opts.body).thinking.type,'disabled');return okay(url,opts);});
  const config=await h.dispatch({type:'GET_SETTINGS'},{url:'https://www.youtube.com/watch?v=test',tab:{id:1}});
  assert.equal(h.access,'TRUSTED_CONTEXTS');assert.equal(config.settings.apiKey,undefined);
  const r=await h.dispatch({type:'TRANSLATE',texts:['Hello']}); assert.equal(r.ok,true);assert.equal(r.translations[0],'译：Hello');
});
test('cache reuse, target isolation and clear',async()=>{
  const h=harness(okay);
  await h.dispatch({type:'TRANSLATE',texts:['Hello']}); await h.dispatch({type:'TRANSLATE',texts:['Hello']});assert.equal(h.calls,1);
  await h.dispatch({type:'SAVE_SETTINGS',settings:{target:'ja'}});await h.dispatch({type:'TRANSLATE',texts:['Hello']});assert.equal(h.calls,2);
  await h.dispatch({type:'CLEAR_CACHE'});await h.dispatch({type:'TRANSLATE',texts:['Hello']});assert.equal(h.calls,3);
  assert.equal(JSON.stringify(h.broadcasts).includes('sk-test-only'),false);
});
test('untrusted pages cannot access settings or change them',async()=>{
  const h=harness(okay);
  assert.equal((await h.dispatch({type:'GET_SETTINGS'},{url:'https://evil.example/',tab:{id:1}})).ok,false);
  assert.equal((await h.dispatch({type:'SAVE_SETTINGS',settings:{enabled:false}},{url:'https://www.youtube.com/watch?v=x',tab:{id:1}})).ok,false);
  assert.equal((await h.dispatch({type:'TEST_API'},{url:'https://www.youtube.com/watch?v=x',tab:{id:1}})).ok,false);
  assert.equal(h.calls,0);
});
test('disabled state, stale config and input size do not trigger a request',async()=>{
  const h=harness(okay);
  assert.equal((await h.dispatch({type:'TRANSLATE',texts:['Hello'],config:{model:'different',target:'zh-CN'}})).ok,false);
  assert.equal((await h.dispatch({type:'TRANSLATE',texts:['a'.repeat(3001)]})).ok,false);
  await h.dispatch({type:'SAVE_SETTINGS',settings:{enabled:false}});
  assert.equal((await h.dispatch({type:'TRANSLATE',texts:['Hello']})).ok,false);assert.equal(h.calls,0);
});
test('401 circuit breaker stops repeated API charges and saving a new key resets it',async()=>{
  let fail=true;const h=harness((u,o)=>fail?{ok:false,status:401}:okay(u,o));
  assert.match((await h.dispatch({type:'TRANSLATE',texts:['Hello']})).error,/Key/);
  await h.dispatch({type:'TRANSLATE',texts:['Next']});assert.equal(h.calls,1);
  fail=false;await h.dispatch({type:'SAVE_SETTINGS',settings:{apiKey:'new-key'}});
  assert.equal((await h.dispatch({type:'TRANSLATE',texts:['Next']})).ok,true);assert.equal(h.calls,2);
});
test('parallel identical batches are coalesced',async()=>{
  const h=harness(async(u,o)=>{await new Promise(r=>setTimeout(r,30));return okay(u,o);});
  const results=await Promise.all([h.dispatch({type:'TRANSLATE',texts:['Hello']}),h.dispatch({type:'TRANSLATE',texts:['Hello']})]);
  assert.equal(results.every(r=>r.ok),true);assert.equal(h.calls,1);
});
test('clearing cache during a request prevents it being restored by the old response',async()=>{
  let release,started;const begun=new Promise(r=>started=r);
  const h=harness(async(u,o)=>{started();await new Promise(r=>release=r);return okay(u,o);});
  const pending=h.dispatch({type:'TRANSLATE',texts:['Hello']});await begun;
  await h.dispatch({type:'CLEAR_CACHE'});release();assert.equal((await pending).ok,true);
  assert.equal(h.data.translationsV2.length,0);
});
test('API max concurrency is two across tabs',async()=>{
  let active=0,max=0;const h=harness(async(u,o)=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,25));active--;return okay(u,o);});
  const results=await Promise.all(Array.from({length:7},(_,i)=>h.dispatch({type:'TRANSLATE',texts:[`line ${i}`]})));
  assert.equal(results.every(r=>r.ok),true);assert.equal(max,2);
});
test('malformed API output is not stored in the cache',async()=>{
  const h=harness(()=>({ok:true,json:async()=>({choices:[{message:{content:'{"translations":[]}'}}]})}));
  assert.equal((await h.dispatch({type:'TRANSLATE',texts:['Hello']})).ok,false);assert.equal(h.data.translationsV2,undefined);
});

test('prior originals/translations and future references reach the API; only target items are output',async()=>{
  const before=[{key:'cue:0',text:'Alice is the pilot.',translation:'爱丽丝是飞行员。'}];
  const after=[{key:'cue:2',text:'Her aircraft is ready.'}];
  const h=harness((u,o)=>{
    const body=JSON.parse(o.body),input=JSON.parse(body.messages[1].content).subtitles;
    assert.equal(input.length,1);assert.equal(input[0].text,'She takes off.');
    assert.equal(input[0].before[0].translation,'爱丽丝是飞行员。');assert.equal(input[0].after[0].text,'Her aircraft is ready.');
    assert.match(body.messages[0].content,/References are context only/);return okay(u,o);
  });
  const result=await h.dispatch(packet(['She takes off.'],{items:[{key:'cue:1',text:'She takes off.',before,after}]}));
  assert.equal(result.ok,true);assert.equal(result.translations.length,1);
});
test('cache isolates video, track, occurrence and original context but reuses a stable replay',async()=>{
  const h=harness(okay),base=packet(['bank']);
  assert.equal((await h.dispatch(base)).ok,true);await h.dispatch(base);assert.equal(h.calls,1);
  await h.dispatch({...base,videoId:'another-video'});
  await h.dispatch({...base,source:'en-US'});
  await h.dispatch({...base,items:[{...base.items[0],key:'cue:20'}]});
  const withContext={...base,items:[{...base.items[0],before:[{key:'cue:earlier',text:'They were standing by the river.'}]}]};
  await h.dispatch(withContext);assert.equal(h.calls,5);
  await h.dispatch({...withContext,items:[{...withContext.items[0],before:[{...withContext.items[0].before[0],translation:'他们站在河边。'}]}]});
  assert.equal(h.calls,5);
  await h.dispatch({...base,items:[{...base.items[0],after:[{key:'cue:later',text:'I deposited money.'}]}]});assert.equal(h.calls,6);
});
test('cached items are omitted from new output targets and reused as reference translations',async()=>{
  const calls=[];const h=harness((u,o)=>{calls.push(JSON.parse(JSON.parse(o.body).messages[1].content).subtitles);return okay(u,o);});
  const a={key:'cue:a',text:'Alice is the pilot.',before:[],after:[]};
  const b={key:'cue:b',text:'She takes off.',before:[{key:a.key,text:a.text}],after:[]};
  await h.dispatch(packet([],{items:[a]}));await h.dispatch(packet([],{items:[a,b]}));
  assert.equal(calls[1].length,1);assert.equal(calls[1][0].text,b.text);
  assert.equal(calls[1][0].before[0].translation,'译：Alice is the pilot.');
});
test('context builder includes ordered neighbours, available past translations and bounded text',()=>{
  const segments=Array.from({length:7},(_,i)=>({key:`cue:${i}`,text:i===0?'x'.repeat(900):`line ${i}`}));
  const context=C.contextFor(segments,3,new Map([['cue:1','第一句']]));
  assert.deepEqual(context.before.map(r=>r.key),['cue:0','cue:1','cue:2']);
  assert.deepEqual(context.after.map(r=>r.key),['cue:4','cue:5']);
  assert.equal(context.before[0].text.length,300);assert.equal(context.before[1].translation,'第一句');
});
test('malformed or oversized reference data is rejected before an API call',async()=>{
  const h=harness(okay);const p=packet(['hello']);
  for(const extra of [{videoId:''},{mode:'other'},{source:'bad source'},{items:[{...p.items[0],before:[{key:'cue:x',text:'x'.repeat(301)}]}]},{items:[p.items[0],p.items[0]]}])assert.equal((await h.dispatch({...p,...extra})).ok,false);
  assert.equal(h.calls,0);
});
test('legacy text-only cache is retired automatically',async()=>{
  const h=harness(okay);h.data.translations=[['old-key','old translation']];
  assert.equal((await h.dispatch(packet(['Hello']))).ok,true);
  assert.equal(h.data.translations,undefined);assert.equal(h.data.translationsV2.length,1);
});
