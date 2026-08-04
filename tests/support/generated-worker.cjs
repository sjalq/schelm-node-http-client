"use strict";
const fs=require("node:fs"),vm=require("node:vm");
function load(file){const source=fs.readFileSync(file,"utf8"),sandbox={console,require,process,Buffer,URL,Headers,AbortController,fetch,performance,setTimeout,clearTimeout,setImmediate,clearImmediate,module:{exports:{}},exports:{}};sandbox.global=sandbox;sandbox.globalThis=sandbox;vm.runInNewContext(source,sandbox,{filename:file});return sandbox.Elm||sandbox.module.exports.Elm;}
function run(file,moduleName,flags,timeout=10000){return new Promise((resolve,reject)=>{const Elm=load(file),reports=[],timer=setTimeout(()=>reject(Error(`${moduleName} timeout`)),timeout),app=Elm[moduleName].init({flags});app.ports.report.subscribe(x=>{reports.push(x);clearTimeout(timer);resolve({app,reports});});});}
module.exports={load,run};
