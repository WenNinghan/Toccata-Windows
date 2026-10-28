/* Local calendar-date selection rules shared by the range picker and tests. */
(function(root){
 'use strict';
 function dateParts(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new TypeError('Invalid local calendar date');
  const [year,month,day]=value.split('-').map(Number), d=new Date(year,month-1,day,12);
  if(d.getFullYear()!==year||d.getMonth()!==month-1||d.getDate()!==day)throw new RangeError('Invalid local calendar date');
  return {year,month,day};
 }
 function min(a,b){return a<b?a:b}function max(a,b){return a>b?a:b}
 function create(initialStart,initialEnd,today,single=false){
  dateParts(initialStart);dateParts(initialEnd);dateParts(today);
  const a=min(initialStart,initialEnd),b=max(initialStart,initialEnd),end=min(b,today);
  return {start:single?end:min(a,today),end,today,single:!!single};
 }
 function select(draft,day){
  dateParts(day);if(day>draft.today)return draft;
  if(draft.single)return {...draft,start:day,end:day};
  if(draft.end!==null)return {...draft,start:day,end:null};
  return {...draft,start:min(draft.start,day),end:max(draft.start,day)};
 }
 function countDays(draft){
  if(draft.end===null)return null;
  const a=dateParts(draft.start),b=dateParts(draft.end);
  return Math.round((Date.UTC(b.year,b.month-1,b.day)-Date.UTC(a.year,a.month-1,a.day))/86400000)+1;
 }
 const api=Object.freeze({create,select,countDays});
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ToccataDatePicker=api;
})(typeof window==='undefined'?globalThis:window);
