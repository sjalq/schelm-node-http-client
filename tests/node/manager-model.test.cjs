"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const MAX_OPERATION=9007199254740990;
const increment=operation=>operation>=MAX_OPERATION?0:operation+1;
function nextUnused(candidate,active){let operation=candidate;while(active.has(operation))operation=increment(operation);return operation;}
function initial(nextOperation=0){return{nextOperation,active:new Map()};}
function step(state,event){const active=new Map(state.active);if(event.kind==="start"){const operation=nextUnused(state.nextOperation,active);active.set(operation,true);return{state:{nextOperation:increment(operation),active},emitted:[`started:${operation}`],operation};}if(!active.has(event.operation))return{state:{...state,active},emitted:[]};active.delete(event.operation);return{state:{...state,active},emitted:event.kind==="complete"?[`finished:${event.operation}`]:[]};}

test("completion/cancel order settles absent with at most one result",()=>{let cases=0;for(const first of ["complete","cancel"])for(const second of ["complete","cancel"]){const started=step(initial(),{kind:"start"});const one=step(started.state,{kind:first,operation:started.operation});const two=step(one.state,{kind:second,operation:started.operation});assert.equal([...one.emitted,...two.emitted].filter(x=>x.startsWith("finished")).length,first==="complete"?1:0);assert.equal(two.state.active.size,0);cases++;}assert.equal(cases,4);});

test("stale and unknown scalar operation ids cannot affect active ownership",()=>{const started=step(initial(),{kind:"start"});const stale=step(started.state,{kind:"complete",operation:99});const unknown=step(stale.state,{kind:"cancel",operation:MAX_OPERATION});assert.equal(unknown.state.active.has(started.operation),true);assert.deepEqual([...stale.emitted,...unknown.emitted],[]);});

test("wrap probes occupied operation ids before minting",()=>{const active=new Map([[MAX_OPERATION,true],[0,true]]);const started=step({nextOperation:MAX_OPERATION,active},{kind:"start"});assert.equal(started.operation,1);assert.equal(started.state.nextOperation,2);assert.equal(started.state.active.size,3);});

test("200 concurrent starts and completions leave O(active) state absent",()=>{let state=initial(),operations=[],starts=0,finishes=0;for(let i=0;i<200;i++){const result=step(state,{kind:"start"});state=result.state;operations.push(result.operation);starts+=result.emitted.length;}assert.equal(state.active.size,200);for(const operation of operations){const result=step(state,{kind:"complete",operation});state=result.state;finishes+=result.emitted.length;}assert.equal(state.active.size,0);assert.equal(starts,200);assert.equal(finishes,200);assert.deepEqual(Object.keys(state).sort(),["active","nextOperation"]);});
