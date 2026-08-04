"use strict";
const http=require("node:http"),zlib=require("node:zlib"),path=require("node:path"),assert=require("node:assert/strict");
const {run,load}=require("./support/generated-worker.cjs");
function server(){return new Promise(resolve=>{const s=http.createServer((req,res)=>{if(req.url==="/echo"){const parts=[];req.on("data",c=>parts.push(c));req.on("end",()=>{const b=Buffer.concat(parts);res.end(JSON.stringify({method:req.method,length:b.length}));});return;}if(req.url==="/slow"){setTimeout(()=>res.end("late"),500);return;}if(req.url==="/read-pending"){res.writeHead(200);res.write("a");setTimeout(()=>res.end("b"),500);return;}if(req.url==="/eof"){res.end("done");return;}if(req.url==="/error"){res.writeHead(200);res.write("a");setTimeout(()=>res.destroy(),100);return;}if(req.url==="/gzip"||req.url==="/deflate"||req.url==="/br"){const plain=Buffer.alloc(4096,65),kind=req.url.slice(1),b=kind==="gzip"?zlib.gzipSync(plain):kind==="deflate"?zlib.deflateSync(plain):zlib.brotliCompressSync(plain);res.writeHead(200,{"content-encoding":kind,"content-length":b.length});res.end(b);return;}if(req.url==="/redirect"){res.writeHead(301,{location:"/ok"});res.end(Buffer.alloc(10000));return;}res.writeHead(req.url==="/empty"?204:200,{"set-cookie":["a=1","b=2"],"x-dupe":["one","two"]});res.end(req.url==="/large"?Buffer.alloc(64,7):Buffer.from("ok"));});s.listen(0,"127.0.0.1",()=>resolve(s));});}
function cancel(mode,url,delay){return new Promise((resolve,reject)=>{const Elm=load(path.join("build",`cancel-${mode}.js`)),seen=[],app=Elm.CancelWorker.init({flags:{url}}),timer=setTimeout(()=>reject(Error("cancel timeout")),5000);app.ports.report.subscribe(x=>{seen.push(x);if(x==="spawned")setTimeout(()=>app.ports.command.send("kill"),delay);if(x==="killed")setTimeout(()=>{clearTimeout(timer);try{assert.ok(!seen.includes("unexpected-completion"));resolve();}catch(e){reject(e);}},650);});});}
(async()=>{
 const s=await server(),base=`http://127.0.0.1:${s.address().port}`;
 try{
  for(const mode of ["debug","optimize"]){
   const property=await run(path.join("build",`property-${mode}.js`),"PropertyWorker",{});assert.equal(property.reports[0].cases,8192);assert.equal(property.reports[0].failures,0);
   const bodyFile=path.join("build",`body-${mode}.js`);
   for(const body of ["utf8-empty","binary-empty"]){const rejected=await run(bodyFile,"BodyWorker",{url:base+"/echo",method:"GET",body});assert.equal(rejected.reports[0].kind,"rejected");assert.equal(rejected.reports[0].reason,"method-body");}
   for(const body of ["empty","utf8-empty","binary-empty"]){const posted=await run(bodyFile,"BodyWorker",{url:base+"/echo",method:"POST",body});assert.equal(posted.reports[0].kind,"success");}
   const file=path.join("build",`http-${mode}.js`);
   let r=await run(file,"HttpWorker",{url:base+"/ok",limit:100,timeoutMs:2000,truncate:false,discardRedirectBody:false});assert.equal(JSON.stringify(r.reports[0].bytes),"[111,107]");
   r=await run(file,"HttpWorker",{url:base+"/large",limit:8,timeoutMs:2000,truncate:true,discardRedirectBody:false});assert.equal(r.reports[0].bodyKind,"truncated");assert.equal(r.reports[0].bytes.length,8);
   r=await run(file,"HttpWorker",{url:base+"/large",limit:8,timeoutMs:2000,truncate:false,discardRedirectBody:false});assert.equal(r.reports[0].error,"response-too-large");
   for(const encoding of ["gzip","deflate","br"]){r=await run(file,"HttpWorker",{url:base+"/"+encoding,limit:32,timeoutMs:2000,truncate:true,discardRedirectBody:false});assert.equal(r.reports[0].bodyKind,"truncated");assert.equal(r.reports[0].bytes.length,32);}
   r=await run(file,"HttpWorker",{url:base+"/redirect",limit:8,timeoutMs:2000,truncate:false,discardRedirectBody:true});assert.equal(r.reports[0].bodyKind,"discarded-redirect");
   const expired=await run(file,"HttpWorker",{url:base+"/slow",limit:100,timeoutMs:1,truncate:false,discardRedirectBody:false});assert.equal(expired.reports[0].error,"deadline-exceeded");
   for(const race of [{path:"/slow",delay:0,label:"immediate/pre-headers"},{path:"/slow",delay:25,label:"headers-wait"},{path:"/read-pending",delay:25,label:"read-pending"},{path:"/error",delay:25,label:"transport-error-race"},{path:"/eof",delay:100,label:"eof/callback-queued-or-settled"}])await cancel(mode,base+race.path,race.delay);
  }
  console.log("generated debug+optimize HTTP and Process.kill matrix passed");
 } finally { await new Promise(r=>s.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
