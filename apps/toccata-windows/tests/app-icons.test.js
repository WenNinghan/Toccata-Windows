'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AppIconRefresh,validPng}=require('../data/app-icons');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU4AAAAASUVORK5CYII=','base64');
const drain=async q=>{for(let i=0;i<100&&(q.active||q.queue.length);i++)await new Promise(r=>setTimeout(r,5));assert.equal(q.active,0);assert.equal(q.queue.length,0);};
function fixture(options={}){let count=0;const records=new Map([['one',{id:'one',icon_png:PNG}],['two',{id:'two',icon_png:null}]]);const store={closed:false,get:id=>records.get(id),setIcon(id,bytes){count++;const record={id,icon_png:bytes};records.set(id,record);return record;}};const queue=new AppIconRefresh({load:async()=>PNG,...options});return{queue,store,records,writes:()=>count};}
test('refreshes an existing icon once, coalesces repeated events, then stays cached',async()=>{
 let reads=0;const f=fixture({load:async()=>{reads++;return PNG;}});
 for(let i=0;i<100;i++)f.queue.request(f.records.get('one'),'G:\\one.exe',f.store);
 await drain(f.queue);assert.equal(reads,1);assert.equal(f.writes(),1);
 f.queue.request(f.records.get('one'),'G:\\one.exe',f.store);await drain(f.queue);assert.equal(reads,1);
});
test('failure preserves previous PNG and retries only after cooldown',async()=>{
 let now=0,reads=0;const f=fixture({now:()=>now,load:async()=>{reads++;return reads===1?null:PNG;}});
 f.queue.request(f.records.get('one'),'G:\\one.exe',f.store);await drain(f.queue);
 assert.equal(f.writes(),0);assert.deepEqual(f.records.get('one').icon_png,PNG);
 now=59999;f.queue.request(f.records.get('one'),'G:\\one.exe',f.store);assert.equal(reads,1);
 now=60000;f.queue.request(f.records.get('one'),'G:\\one.exe',f.store);await drain(f.queue);assert.equal(reads,2);assert.equal(f.writes(),1);
});
test('different identities with the same basename stay independent, extraction concurrency is bounded',async()=>{
 let running=0,peak=0;const paths=[];const f=fixture({concurrency:1,load:async p=>{paths.push(p);running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,10));running--;return PNG;}});
 f.queue.request(f.records.get('one'),'G:\\a\\same.exe',f.store);f.queue.request(f.records.get('two'),'G:\\b\\same.exe',f.store);
 await drain(f.queue);assert.equal(peak,1);assert.deepEqual(paths,['G:\\a\\same.exe','G:\\b\\same.exe']);assert.equal(f.writes(),2);
});
test('late completion after shutdown or store close never writes',async()=>{
 for(const condition of ['closed','store','quitting']){
 let resolve,allowed=true;const f=fixture({canWrite:()=>allowed,load:()=>new Promise(r=>{resolve=r;})});
 f.queue.request(f.records.get('one'),'G:\\one.exe',f.store);
 if(condition==='closed')f.queue.close();else if(condition==='store')f.store.closed=true;else allowed=false;
 resolve(PNG);await drain(f.queue);assert.equal(f.writes(),0);
 }
});
test('invalid or lower resolution replacement never erases a cached higher resolution image',async()=>{
 const larger=Buffer.from(PNG);larger.writeUInt32BE(64,16);larger.writeUInt32BE(64,20);
 const f=fixture();f.records.get('one').icon_png=larger;
 f.queue.request(f.records.get('one'),'G:\\one.exe',f.store);await drain(f.queue);assert.equal(f.writes(),0);assert.deepEqual(f.records.get('one').icon_png,larger);
 assert.equal(validPng(Buffer.from('bad')),false);assert.equal(validPng(null),false);
});
