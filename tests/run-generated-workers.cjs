"use strict";
const http=require("node:http"),zlib=require("node:zlib"),path=require("node:path"),assert=require("node:assert/strict");
const {run,load}=require("./support/generated-worker.cjs");
function server(){return new Promise(resolve=>{const s=http.createServer((req,res)=>{if(req.url==="/slow"){setTimeout(()=>res.end("late"),500);return;}if(req.url==="/gzip"){const b=zlib.gzipSync(Buffer.alloc(4096,65));res.writeHead(200,{"content-encoding":"gzip","content-length":b.length});res.end(b);return;}if(req.url==="/redirect"){res.writeHead(301,{location:"/ok"});res.end(Buffer.alloc(10000));return;}res.writeHead(req.url==="/empty"?204:200,{"set-cookie":["a=1","b=2"],"x-dupe":["one","two"]});res.end(req.url==="/large"?Buffer.alloc(64,7):Buffer.from("ok"));});s.listen(0,"127.0.0.1",()=>resolve(s));});}
function cancel(mode,url){return new Promise((resolve,reject)=>{const Elm=load(path.join("build",`cancel-${mode}.js`)),seen=[],app=Elm.CancelWorker.init({flags:{url}}),timer=setTimeout(()=>reject(Error("cancel timeout")),5000);app.ports.report.subscribe(x=>{seen.push(x);if(x==="spawned")app.ports.command.send("kill");if(x==="killed")setTimeout(()=>{clearTimeout(timer);try{assert.ok(!seen.includes("unexpected-completion"));resolve();}catch(e){reject(e);}},650);});});}
(async()=>{
 const s=await server(),base=`http://127.0.0.1:${s.address().port}`;
 try{
  for(const mode of ["debug","optimize"]){
   const file=path.join("build",`http-${mode}.js`);
   let r=await run(file,"HttpWorker",{url:base+"/ok",limit:100,timeoutMs:2000,truncate:false,discardRedirectBody:false});assert.equal(JSON.stringify(r.reports[0].bytes),"[111,107]");
   r=await run(file,"HttpWorker",{url:base+"/large",limit:8,timeoutMs:2000,truncate:true,discardRedirectBody:false});assert.equal(r.reports[0].bodyKind,"truncated");assert.equal(r.reports[0].bytes.length,8);
   r=await run(file,"HttpWorker",{url:base+"/large",limit:8,timeoutMs:2000,truncate:false,discardRedirectBody:false});assert.equal(r.reports[0].error,"response-too-large");
   r=await run(file,"HttpWorker",{url:base+"/gzip",limit:32,timeoutMs:2000,truncate:true,discardRedirectBody:false});assert.equal(r.reports[0].bodyKind,"truncated");
   r=await run(file,"HttpWorker",{url:base+"/redirect",limit:8,timeoutMs:2000,truncate:false,discardRedirectBody:true});assert.equal(r.reports[0].bodyKind,"discarded-redirect");
   await cancel(mode,base+"/slow");
  }
  console.log("generated debug+optimize HTTP and Process.kill matrix passed");
 } finally { await new Promise(r=>s.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
