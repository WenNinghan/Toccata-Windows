'use strict';

// Versioned, physical-key layout definitions. Layout changes affect only the
// displayed keys; they never modify stored events or translate typed text.
const { mapWindowsKey } = require('./keyboard');

// Derived from renderer/layout.js Windows 104-key geometry. Keep the parity
// test in keyboard-layouts.test.js when updating either representation.
const BASE_104 = [{"code":53,"label":"Esc","x":0,"y":0,"w":1,"h":1},{"code":122,"label":"F1","x":2,"y":0,"w":1,"h":1},{"code":120,"label":"F2","x":3,"y":0,"w":1,"h":1},{"code":99,"label":"F3","x":4,"y":0,"w":1,"h":1},{"code":118,"label":"F4","x":5,"y":0,"w":1,"h":1},{"code":96,"label":"F5","x":6.5,"y":0,"w":1,"h":1},{"code":97,"label":"F6","x":7.5,"y":0,"w":1,"h":1},{"code":98,"label":"F7","x":8.5,"y":0,"w":1,"h":1},{"code":100,"label":"F8","x":9.5,"y":0,"w":1,"h":1},{"code":101,"label":"F9","x":11,"y":0,"w":1,"h":1},{"code":109,"label":"F10","x":12,"y":0,"w":1,"h":1},{"code":103,"label":"F11","x":13,"y":0,"w":1,"h":1},{"code":111,"label":"F12","x":14,"y":0,"w":1,"h":1},{"code":1311,"label":"PrtSc","x":15.5,"y":0,"w":1,"h":1},{"code":1070,"label":"Scroll","x":16.5,"y":0,"w":1,"h":1},{"code":1581,"label":"Pause","x":17.5,"y":0,"w":1,"h":1,"unavailable":true},{"code":50,"label":"`","x":0,"y":1,"w":1,"h":1},{"code":18,"label":"1","x":1,"y":1,"w":1,"h":1},{"code":19,"label":"2","x":2,"y":1,"w":1,"h":1},{"code":20,"label":"3","x":3,"y":1,"w":1,"h":1},{"code":21,"label":"4","x":4,"y":1,"w":1,"h":1},{"code":23,"label":"5","x":5,"y":1,"w":1,"h":1},{"code":22,"label":"6","x":6,"y":1,"w":1,"h":1},{"code":26,"label":"7","x":7,"y":1,"w":1,"h":1},{"code":28,"label":"8","x":8,"y":1,"w":1,"h":1},{"code":25,"label":"9","x":9,"y":1,"w":1,"h":1},{"code":29,"label":"0","x":10,"y":1,"w":1,"h":1},{"code":27,"label":"-","x":11,"y":1,"w":1,"h":1},{"code":24,"label":"=","x":12,"y":1,"w":1,"h":1},{"code":51,"label":"Backspace","x":13,"y":1,"w":2,"h":1},{"code":1338,"label":"Insert","x":15.5,"y":1,"w":1,"h":1},{"code":1327,"label":"Home","x":16.5,"y":1,"w":1,"h":1},{"code":1329,"label":"PgUp","x":17.5,"y":1,"w":1,"h":1},{"code":1069,"label":"Num","x":19,"y":1,"w":1,"h":1},{"code":1309,"label":"/","x":20,"y":1,"w":1,"h":1},{"code":1055,"label":"*","x":21,"y":1,"w":1,"h":1},{"code":1074,"label":"−","x":22,"y":1,"w":1,"h":1},{"code":48,"label":"Tab","x":0,"y":2,"w":1.5,"h":1},{"code":12,"label":"Q","x":1.5,"y":2,"w":1,"h":1},{"code":13,"label":"W","x":2.5,"y":2,"w":1,"h":1},{"code":14,"label":"E","x":3.5,"y":2,"w":1,"h":1},{"code":15,"label":"R","x":4.5,"y":2,"w":1,"h":1},{"code":17,"label":"T","x":5.5,"y":2,"w":1,"h":1},{"code":16,"label":"Y","x":6.5,"y":2,"w":1,"h":1},{"code":32,"label":"U","x":7.5,"y":2,"w":1,"h":1},{"code":34,"label":"I","x":8.5,"y":2,"w":1,"h":1},{"code":31,"label":"O","x":9.5,"y":2,"w":1,"h":1},{"code":35,"label":"P","x":10.5,"y":2,"w":1,"h":1},{"code":33,"label":"[","x":11.5,"y":2,"w":1,"h":1},{"code":30,"label":"]","x":12.5,"y":2,"w":1,"h":1},{"code":42,"label":"\\","x":13.5,"y":2,"w":1.5,"h":1},{"code":1339,"label":"Delete","x":15.5,"y":2,"w":1,"h":1},{"code":1335,"label":"End","x":16.5,"y":2,"w":1,"h":1},{"code":1337,"label":"PgDn","x":17.5,"y":2,"w":1,"h":1},{"code":1071,"label":"7","x":19,"y":2,"w":1,"h":1},{"code":1072,"label":"8","x":20,"y":2,"w":1,"h":1},{"code":1073,"label":"9","x":21,"y":2,"w":1,"h":1},{"code":1078,"label":"+","x":22,"y":2,"w":1,"h":2},{"code":57,"label":"Caps Lock","x":0,"y":3,"w":1.75,"h":1},{"code":0,"label":"A","x":1.75,"y":3,"w":1,"h":1},{"code":1,"label":"S","x":2.75,"y":3,"w":1,"h":1},{"code":2,"label":"D","x":3.75,"y":3,"w":1,"h":1},{"code":3,"label":"F","x":4.75,"y":3,"w":1,"h":1},{"code":5,"label":"G","x":5.75,"y":3,"w":1,"h":1},{"code":4,"label":"H","x":6.75,"y":3,"w":1,"h":1},{"code":38,"label":"J","x":7.75,"y":3,"w":1,"h":1},{"code":40,"label":"K","x":8.75,"y":3,"w":1,"h":1},{"code":37,"label":"L","x":9.75,"y":3,"w":1,"h":1},{"code":41,"label":";","x":10.75,"y":3,"w":1,"h":1},{"code":39,"label":"'","x":11.75,"y":3,"w":1,"h":1},{"code":36,"label":"Enter","x":12.75,"y":3,"w":2.25,"h":1},{"code":1075,"label":"4","x":19,"y":3,"w":1,"h":1},{"code":1076,"label":"5","x":20,"y":3,"w":1,"h":1},{"code":1077,"label":"6","x":21,"y":3,"w":1,"h":1},{"code":56,"label":"Shift","x":0,"y":4,"w":2.25,"h":1},{"code":6,"label":"Z","x":2.25,"y":4,"w":1,"h":1},{"code":7,"label":"X","x":3.25,"y":4,"w":1,"h":1},{"code":8,"label":"C","x":4.25,"y":4,"w":1,"h":1},{"code":9,"label":"V","x":5.25,"y":4,"w":1,"h":1},{"code":11,"label":"B","x":6.25,"y":4,"w":1,"h":1},{"code":45,"label":"N","x":7.25,"y":4,"w":1,"h":1},{"code":46,"label":"M","x":8.25,"y":4,"w":1,"h":1},{"code":43,"label":",","x":9.25,"y":4,"w":1,"h":1},{"code":47,"label":".","x":10.25,"y":4,"w":1,"h":1},{"code":44,"label":"/","x":11.25,"y":4,"w":1,"h":1},{"code":60,"label":"Shift","x":12.25,"y":4,"w":2.75,"h":1},{"code":126,"label":"↑","x":16.5,"y":4,"w":1,"h":1},{"code":1079,"label":"1","x":19,"y":4,"w":1,"h":1},{"code":1080,"label":"2","x":20,"y":4,"w":1,"h":1},{"code":1081,"label":"3","x":21,"y":4,"w":1,"h":1},{"code":1284,"label":"Enter","x":22,"y":4,"w":1,"h":2},{"code":59,"label":"Ctrl","x":0,"y":5,"w":1.25,"h":1},{"code":55,"label":"Win","x":1.25,"y":5,"w":1.25,"h":1},{"code":58,"label":"Alt","x":2.5,"y":5,"w":1.25,"h":1},{"code":49,"label":"Space","x":3.75,"y":5,"w":6.25,"h":1},{"code":61,"label":"Alt","x":10,"y":5,"w":1.25,"h":1},{"code":54,"label":"Win","x":11.25,"y":5,"w":1.25,"h":1},{"code":1349,"label":"Menu","x":12.5,"y":5,"w":1.25,"h":1},{"code":62,"label":"Ctrl","x":13.75,"y":5,"w":1.25,"h":1},{"code":123,"label":"←","x":15.5,"y":5,"w":1,"h":1},{"code":125,"label":"↓","x":16.5,"y":5,"w":1,"h":1},{"code":124,"label":"→","x":17.5,"y":5,"w":1,"h":1},{"code":1082,"label":"0","x":19,"y":5,"w":2,"h":1},{"code":1083,"label":".","x":21,"y":5,"w":1,"h":1}];
const NUMPAD = new Set([1069,1309,1055,1074,1071,1072,1073,1078,1075,1076,1077,1079,1080,1081,1284,1082,1083]);
const TOP_SPECIAL = new Set([1311,1070,1581]);
const FUNCTION_KEYS = new Set([122,120,99,118,96,97,98,100,101,109,103,111]);
const NAV = new Set([1338,1327,1329,1339,1335,1337]);
const ARROWS = new Set([123,124,125,126]);
const VALID_CODES = (() => {
  const result = new Set();
  for(let scan=0; scan<256; scan++) for(const ext of [0,2,4]) {
    const code=mapWindowsKey(scan,ext); if(code !== null) result.add(code);
  }
  // Fn and Pause can appear as physical decorations; their Windows input is
  // not mapped or inferred. Both are always rendered as unavailable.
  result.add(63);
  result.add(1581);
  return result;
})();
const copy = value => JSON.parse(JSON.stringify(value));

function make75() {
  const keys = BASE_104.filter(k => !NUMPAD.has(k.code) && !TOP_SPECIAL.has(k.code) && !NAV.has(k.code) && !ARROWS.has(k.code)).map(k=>({...k}));
  // Reflow the function row to the compact 75% form.
  const fn=[122,120,99,118,96,97,98,100,101,109,103,111];
  fn.forEach((code,i)=>{const key=keys.find(k=>k.code===code);key.x=i+1;});
  // Make room on the bottom row for the independent arrow cluster without
  // deleting right-side modifiers. This is a representative ANSI variant.
  for(const key of keys) {
    if(key.code===60) key.w=2;
    if(key.y===5 && key.x>=10) key.x-=1.75;
    if(key.code===49) key.w=4.5;
  }
  const byCode = code => ({...BASE_104.find(key=>key.code===code)});
  const navigation=[1338,1339,1327,1335,1329,1337];
  navigation.forEach((code,y)=>{const key=byCode(code);key.x=16.25;key.y=y;keys.push(key);});
  for(const [code,x,y] of [[126,14.25,4],[123,13.25,5],[125,14.25,5],[124,15.25,5]]) {
    const key=byCode(code);key.x=x;key.y=y;keys.push(key);
  }
  return { version:1, id:'windows-75-percent', name:'Windows 75% (84键)', keys };
}
function make68() {
  const compact=make75();
  const removedNav=new Set([1338,1327,1335,1337]);
  const keys=compact.keys.filter(k=>!FUNCTION_KEYS.has(k.code)&&!removedNav.has(k.code)).map(k=>({...k}));
  for(const key of keys) {
    if(key.code===53) continue;
    const isNumberRow=key.y===1 && key.x<15;
    key.y-=1;
    if(isNumberRow)key.x+=1;
  }
  return { version:1, id:'windows-65-68', name:'Windows 65% (68键)', keys };
}
function make87() { return { version:1, id:'windows-80-87', name:'Windows 80% / TKL (87键)', keys:BASE_104.filter(k=>!NUMPAD.has(k.code)).map(k=>({...k})) }; }
function make104() { return { version:1, id:'windows-100-104', name:'Windows 100% (104键)', keys:copy(BASE_104) }; }

function validate(layout) {
  if(!layout || typeof layout!=='object' || Array.isArray(layout) || layout.version!==1) throw new TypeError('Unsupported layout version');
  if(typeof layout.id!=='string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(layout.id)) throw new TypeError('Invalid layout id');
  if(typeof layout.name!=='string' || !layout.name.trim() || layout.name.length>80 || /[\x00-\x1f\x7f]/.test(layout.name)) throw new TypeError('Invalid layout name');
  if(!Array.isArray(layout.keys) || !layout.keys.length || layout.keys.length>128) throw new RangeError('Invalid number of keys');
  const codes = new Set(); const keys=[];
  for(const key of layout.keys) {
    if(!key || typeof key!=='object' || Array.isArray(key) || !Number.isSafeInteger(key.code) || !VALID_CODES.has(key.code))
      throw new TypeError('Unsupported physical key code');
    if(codes.has(key.code)) throw new TypeError('Duplicate physical key code');
    codes.add(key.code);
    if(typeof key.label!=='string' || key.label.length>24 || /[\x00-\x1f\x7f]/.test(key.label)) throw new TypeError('Invalid key label');
    const label=key.label.trim();
    if((/^fn$/i.test(label) && key.code!==63) || (/^pause$/i.test(label) && key.code!==1581)) throw new TypeError('Fn or Pause cannot be assigned to another key');
    if(![key.x,key.y,key.w,key.h].every(Number.isFinite) || key.x<0 || key.y<0 || key.w<.25 || key.h<.25 || key.w>8 || key.h>3 || key.x+key.w>32 || key.y+key.h>10) throw new RangeError('Invalid key geometry');
    if(key.unavailable!==undefined && typeof key.unavailable!=='boolean') throw new TypeError('Invalid availability flag');
    // Never allow reserved Fn/Pause codes to pretend a successful mapping.
    const item={code:key.code,label:key.label,x:key.x,y:key.y,w:key.w,h:key.h};
    if(key.unavailable===true || key.code===63 || key.code===1581)item.unavailable=true;
    for(const other of keys) if(item.x < other.x+other.w-1e-9 && item.x+item.w > other.x+1e-9 && item.y < other.y+other.h-1e-9 && item.y+item.h > other.y+1e-9) throw new RangeError('Overlapping keys');
    keys.push(item);
  }
  return {version:1,id:layout.id,name:layout.name.trim(),keys};
}
const PRESETS = Object.freeze([make68(),make75(),make87(),make104()].map(validate));
function presets() { return PRESETS.map(({id,name,keys})=>({id,name,key_count:keys.length})); }
function getPreset(id) { const result=PRESETS.find(p=>p.id===id); if(!result)throw new RangeError('Unknown keyboard layout preset');return copy(result); }
function catalog() {
  const result=BASE_104.map(({code,label,unavailable})=>({code,label,...(unavailable?{unavailable:true}:{})}));
  result.push({code:63,label:'Fn',unavailable:true});
  return result;
}
function serialize(layout) { return JSON.stringify(validate(layout)); }
function deserialize(json) {
  if(typeof json!=='string' || json.length>128*1024) throw new TypeError('Invalid keyboard layout JSON');
  let value;try{value=JSON.parse(json)}catch{throw new TypeError('Invalid keyboard layout JSON');}
  return validate(value);
}
function toRendererLayout(layout) {
  const safe=validate(layout);
  // Existing renderer and share card use relative x, offsets y and rowStep.
  // Group by floor(y) and pad empty rows to retain the total bounding height.
  const height=Math.ceil(Math.max(...safe.keys.map(k=>k.y+k.h)));
  const rows=Array.from({length:height},()=>[]);
  for(const key of safe.keys) rows[Math.floor(key.y)].push(key);
  for(let i=0;i<rows.length;i++) {
    let cursor=0;
    rows[i]=rows[i].sort((a,b)=>a.x-b.x||a.y-b.y||a.code-b.code).map(key=>{
      const item={code:key.code,label:key.label,x:key.x-cursor,y:key.y-i,w:key.w,h:key.h};
      if(key.unavailable)item.unavailable=true;
      cursor=key.x+key.w;return item;
    });
  }
  return {id:safe.id,name:safe.name,unit:54,keyGap:6,rowStep:1,rows};
}
module.exports={presets,getPreset,catalog,validate,serialize,deserialize,toRendererLayout};
