'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { presets,getPreset,catalog,validate,serialize,deserialize,toRendererLayout } = require('../data/keyboard-layouts');
const { mapWindowsKey } = require('../data/keyboard');
const { computeStats } = require('../data/stats');

function coords(rendered) {
  const result=[]; let rowY=0;
  for(const row of rendered.rows) {
    let x=0;
    for(const key of row) { x+=key.x||0; result.push({code:key.code,label:key.label,x,y:rowY+(key.y||0),w:key.w||1,h:key.h||1,...(key.unavailable?{unavailable:true}:{})}); x+=key.w||1; }
    rowY+=rendered.rowStep||1;
  }
  return result.sort((a,b)=>a.code-b.code);
}
const custom=()=>({version:1,id:'custom-layout',name:'My keyboard',keys:[
  {code:0,label:'A',x:0,y:0,w:1,h:1},
  {code:1,label:'S',x:1,y:0,w:1,h:1},
  {code:1078,label:'+',x:2,y:0,w:1,h:2},
  {code:2,label:'D',x:0,y:1,w:1,h:1},
]});

test('four clearly named ANSI preset variants have expected counts and unique IDs',()=>{
  assert.deepEqual(presets().map(x=>x.key_count),[68,84,87,104]);
  for(const preset of presets()) {
    const layout=getPreset(preset.id), codes=layout.keys.map(k=>k.code);
    assert.equal(new Set(codes).size,codes.length);
    assert.equal(validate(layout).keys.length,preset.key_count);
    assert.ok(!codes.includes(63));
    assert.ok(layout.keys.every(k=>k.code!==1581||k.unavailable===true));
  }
  assert.throws(()=>getPreset('nonexistent'),RangeError);
});

test('100% preset matches the existing 104-key Windows renderer geometry',()=>{
  const file=path.join(__dirname,'../renderer/layout.js'),context={window:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  const upstream=coords(context.window.TOCCATA_LAYOUT);
  const generated=coords(toRendererLayout(getPreset('windows-100-104')));
  assert.deepEqual(generated,upstream);
});

test('presets map to actual known physical keys; Pause is visibly unavailable',()=>{
  const physical=new Set();
  for(let scan=0;scan<256;scan++)for(const ext of [0,2,4]){
    const code=mapWindowsKey(scan,ext);if(code!==null)physical.add(code);
  }
  for(const p of presets())for(const key of getPreset(p.id).keys){
    if(key.code===1581||key.code===63)assert.equal(key.unavailable,true);
    else assert.ok(physical.has(key.code),`unmapped key ${key.code}`);
  }
  assert.equal(mapWindowsKey(0x1d,4),null);
  assert.equal(mapWindowsKey(0x45,4),null);
});

test('editor catalog includes all known physical keys and disabled Fn/Pause',()=>{
  const entries=catalog(), codes=new Set(entries.map(x=>x.code));
  assert.equal(codes.size,entries.length);
  for(let scan=0;scan<256;scan++)for(const ext of [0,2,4]){
    const code=mapWindowsKey(scan,ext);if(code!==null)assert.ok(codes.has(code));
  }
  assert.equal(entries.find(x=>x.code===63).unavailable,true);
  assert.equal(entries.find(x=>x.code===1581).unavailable,true);
  const altered=entries.find(x=>x.code===63);altered.label='changed';
  assert.equal(catalog().find(x=>x.code===63).label,'Fn');
});

test('custom layouts serialize and deserialize without changing caller objects',()=>{
  const source=custom(), frozen=JSON.stringify(source), text=serialize(source), result=deserialize(text);
  assert.equal(JSON.stringify(source),frozen);assert.deepEqual(result,source);
  result.keys[0].x=20;assert.equal(source.keys[0].x,0);
  const preset=getPreset('windows-65-68');preset.keys[0].label='changed';
  assert.notEqual(getPreset('windows-65-68').keys[0].label,'changed');
});

test('renderer conversion preserves position, size, custom label and vertical double key',()=>{
  const layout=custom();layout.keys.push({code:3,label:'Custom F',x:0,y:2.25,w:1.5,h:0.5});
  const expected=validate(layout).keys.sort((a,b)=>a.code-b.code);
  const converted=toRendererLayout(layout);
  assert.equal(converted.rowStep,1);assert.deepEqual(coords(converted),expected);
  assert.equal(converted.rows.length,3);
});

test('rejects duplicate key identity, unknown code, false Fn and overlapping geometry',()=>{
  const duplicate=custom();duplicate.keys[1].code=0;assert.throws(()=>validate(duplicate),/Duplicate/);
  const unknown=custom();unknown.keys[0].code=999999;assert.throws(()=>validate(unknown),/Unsupported/);
  const fnLabel=custom();fnLabel.keys[0].label='Fn';assert.throws(()=>validate(fnLabel),/Fn/);
  const fakePause=custom();fakePause.keys[0].label='Pause';assert.throws(()=>validate(fakePause),/Pause/);
  const overlap=custom();overlap.keys[1].x=.5;assert.throws(()=>validate(overlap),/Overlapping/);
  const touching=custom();assert.doesNotThrow(()=>validate(touching));
  const reserved={version:1,id:'pause',name:'Pause',keys:[{code:1581,label:'Pause',x:0,y:0,w:1,h:1,unavailable:false}]};
  assert.equal(validate(reserved).keys[0].unavailable,true);
  const fn={version:1,id:'laptop',name:'Laptop',keys:[{code:63,label:'Fn',x:0,y:0,w:1,h:1,unavailable:false}]};
  assert.equal(validate(fn).keys[0].unavailable,true);
  assert.equal(toRendererLayout(fn).rows[0][0].unavailable,true);
  for(let scan=0;scan<256;scan++)for(const ext of [0,2,4])assert.notEqual(mapWindowsKey(scan,ext),63);
});

test('rejects nonfinite or extreme values, malformed data, and invalid names',()=>{
  for(const [property,value] of [['x',NaN],['y',Infinity],['x',-1],['x',33],['w',0],['h',.1],['w',9],['h',4]]){
    const bad=custom();bad.keys[0][property]=value;assert.throws(()=>validate(bad));
  }
  assert.throws(()=>validate({...custom(),version:2}),/version/);
  assert.throws(()=>validate({...custom(),id:'../bad'}),/id/);
  assert.throws(()=>validate({...custom(),name:'bad\nname'}),/name/);
  assert.throws(()=>deserialize('{bad json'),/JSON/);
  assert.throws(()=>deserialize(' '.repeat(128*1024+1)),/JSON/);
  const badStep=custom();assert.throws(()=>validate({...badStep,keys:[]}),/number/);
});

test('hiding an absent key changes only the layout, not its stored statistics',()=>{
  const keyboard=custom();keyboard.keys=keyboard.keys.filter(k=>k.code!==1078);
  const snapshot=computeStats([{event_id:'1',ts_ms:10000,keycode:0,kind:0},{event_id:'2',ts_ms:11000,keycode:1078,kind:0}],{start_ms:0,end_ms:20000,now_ms:20000});
  assert.equal(validate(keyboard).keys.some(k=>k.code===1078),false);
  assert.equal(snapshot.key_count,2);assert.equal(snapshot.keys[1078],1);
});
