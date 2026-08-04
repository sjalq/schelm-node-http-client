"use strict";
const { runBufferedHttp } = require("../../kernel-src/http-transaction.js");
function bytes(xs){return Uint8Array.from(xs);}
function harness(script={}){
 const events=[],deliveries=[];let now=script.now??0,timerFn=null,readIndex=0,aborts=0,cancels=0,releases=0,reads=0,copies=0;
 const chunks=script.chunks||[];const repeatedChunk=script.repeatedChunk||null,repeatedCount=script.repeatedCount||0;
 const facts={status:script.status??200,statusText:"OK",headers:[],setCookies:[],url:{},body:script.noBody?null:{},hasLocation:!!script.hasLocation};
 const ops={
  observe:(event,facts)=>events.push({event,facts}),nowMonotonic:()=>now,setTimer:(fn)=>{timerFn=fn;return 1;},clearTimer:()=>{},
  makeAbortController:()=>({signal:{}}),abort:()=>{aborts++;if(script.abortThrows)throw Error("secret-abort");},
  fetchManual:()=>script.fetchPending?new Promise(()=>{}):script.fetchReject?Promise.reject(Object.assign(Error("secret-fetch"),{code:script.code})):Promise.resolve({}),
  responseFacts:()=>facts,acquireReader:()=>({read(){}}),read:async()=>{reads++;if(repeatedChunk&&readIndex<repeatedCount){readIndex++;return{done:false,value:repeatedChunk};}if(readIndex<chunks.length)return{done:false,value:chunks[readIndex++]};return{done:true};},
  cancelBody:()=>{cancels++;},cancelReader:()=>{cancels++;},releaseReader:()=>{releases++;},copyChunk:(c,s,n)=>{copies++;return c.slice(s,s+n);},chunkLength:c=>c.length,
  concatChunks:(cs,total)=>{const out=new Uint8Array(total);let o=0;for(const c of cs){out.set(c,o);o+=c.length;}return out;},emptyBytes:()=>bytes([]),
  makeResponse:(f,bodyKind,body,lower)=>({status:f.status,bodyKind,body:[...body],lower}),deliverSuccess:v=>deliveries.push({ok:true,value:v}),deliverFailure:e=>deliveries.push({ok:false,error:e})
 };
 const request={method:script.method||"GET",responseLimit:script.limit??8,truncate:!!script.truncate,discardRedirectBody:!!script.discardRedirectBody};
 const operation=runBufferedHttp({ops,request,deadline:script.deadline??100});
 return{operation,events,deliveries,fireTimer:()=>timerFn&&timerFn(),counts:()=>({aborts,cancels,releases,reads,copies})};
}
async function settle(){for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));}
module.exports={harness,bytes,settle};
