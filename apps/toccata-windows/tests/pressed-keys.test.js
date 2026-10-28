'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PressedKeys}=require('../data/pressed-keys');
const event=(overrides={})=>({device:'device-1',scan:30,ext:0,vkey:65,keycode:0,kind:'down',...overrides});
test('multiple devices keep the same code active until both release',()=>{
 const keys=new PressedKeys();assert.deepEqual(keys.update(event()),[0]);assert.deepEqual(keys.update(event({device:'device-2'})),[0]);
 assert.deepEqual(keys.update(event({kind:'up'})),[0]);assert.deepEqual(keys.update(event({device:'device-2',kind:'up'})),[]);
});
test('duplicate down and orphan up are idempotent, release uses saved code',()=>{
 const keys=new PressedKeys();keys.update(event());keys.update(event());keys.update(event({device:'device-2',kind:'up'}));
 assert.deepEqual(keys.active(),[0]);assert.deepEqual(keys.update(event({kind:'up',keycode:null})),[]);assert.deepEqual(keys.update(event({kind:'up'})),[]);
});
test('reset of one device preserves other devices and all reset clears',()=>{
 const keys=new PressedKeys();keys.update(event());keys.update(event({device:'device-2'}));keys.update(event({device:'device-2',scan:29,keycode:59}));
 assert.deepEqual(keys.reset('device-1'),[0,59]);assert.deepEqual(keys.reset('missing'),[0,59]);assert.deepEqual(keys.reset('device-2'),[]);
 keys.update(event());assert.deepEqual(keys.reset(),[]);keys.update(event());assert.deepEqual(keys.reset(null),[]);
});
test('unknown keys remain tracked, scan zero uses vkey and extended keys are distinct',()=>{
 const keys=new PressedKeys();keys.update(event({scan:0,vkey:65,keycode:null}));keys.update(event({scan:0,vkey:66,keycode:7}));keys.update(event({scan:29,ext:0,keycode:59}));keys.update(event({scan:29,ext:2,keycode:62}));
 assert.deepEqual(keys.active(),[7,59,62]);assert.deepEqual(keys.update(event({scan:0,vkey:65,keycode:null,kind:'up'})),[7,59,62]);
 assert.deepEqual(keys.update(event({scan:29,ext:0,keycode:59,kind:'up'})),[7,62]);assert.deepEqual(keys.reset('device-1'),[]);
});
test('two physical inputs mapping to one code are counted independently',()=>{
 const keys=new PressedKeys();keys.update(event({scan:55,ext:2,keycode:1311}));keys.update(event({scan:84,ext:0,keycode:1311}));
 assert.deepEqual(keys.update(event({scan:55,ext:2,keycode:1311,kind:'up'})),[1311]);assert.deepEqual(keys.update(event({scan:84,ext:0,keycode:1311,kind:'up'})),[]);
});
test('invalid event cannot mutate state',()=>{
 const keys=new PressedKeys();keys.update(event());assert.throws(()=>keys.update(event({scan:-1})),/invalid/);assert.throws(()=>keys.update(event({kind:'repeat'})),/invalid/);assert.deepEqual(keys.active(),[0]);assert.throws(()=>keys.reset(''),/invalid/);assert.deepEqual(keys.active(),[0]);
});
