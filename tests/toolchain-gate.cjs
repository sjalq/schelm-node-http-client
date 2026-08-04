"use strict";
const fs=require("node:fs"),crypto=require("node:crypto"),cp=require("node:child_process"),path=require("node:path");const tool=JSON.parse(fs.readFileSync("toolchain.json","utf8"));
function sha(p){return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");}
const elm="vendor/toolchain/elm-76bbe44424106c96f915cb24cd7f50d69f5cee0e-linux-x64",nodeArchive="vendor/toolchain/node-v24.4.1-linux-x64.xz",seed="vendor/toolchain/public-packages-0.19.2.tar.gz";
if(sha(elm)!==tool.elmCompilerBinarySha256)throw Error("compiler hash mismatch");if(sha(seed)!==tool.publicPackageSeedSha256)throw Error("seed hash mismatch");if(cp.execFileSync(elm,["--version"],{encoding:"utf8"}).trim()!==tool.elmLanguageVersion)throw Error("compiler version mismatch");if(process.version!==`v${tool.nodeVersion}`)throw Error(`run tests with Node ${tool.nodeVersion}, got ${process.version}`);const unpackHash=cp.execFileSync("sh",["-c",`xz -dc '${nodeArchive}' | sha256sum`],{encoding:"utf8"}).trim().split(/\s+/)[0];if(unpackHash!==tool.nodeBinarySha256)throw Error("Node archive payload hash mismatch");
const text=fs.readFileSync("scripts/prepare-overlay.cjs","utf8");if(text.includes(".elm/"))throw Error("ambient Elm cache reference");
console.log("offline toolchain provenance passed: Elm 0.19.2 and Node 24.4.1 hashes verified");
