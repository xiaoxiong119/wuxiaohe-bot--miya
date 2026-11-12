'use strict';
// 仅由离线检查入口预加载。所有间接依赖也只能看到固定数据，SDK 不得发起真实请求。
const Module=require('node:module'),path=require('node:path');
const fixture=require('./test-fixtures').fixtures();
const app=path.resolve(__dirname,'..');
const original=Module._load;
Module._load=function(name,parent,main){
 let resolved;
 try {resolved=Module._resolveFilename(name,parent);} catch {return original.apply(this,arguments);}
 if(resolved===path.join(app,'src/config.js')) return {ROOT:fixture.root,APP_ID:'cli_fixture',APP_SECRET:'fixture-secret',BASE:fixture.pc.base,INBOX:{},DRIVE_INBOX:{},UPLOAD:{},FLOW:{},ALLOWED_EXT:['.mp4'],DOWNLOAD_DIR:path.join(fixture.root,'downloads')};
 if(resolved===path.join(app,'src/project-context.js'))return fixture.pc;
 if(name==='@larksuiteoapi/node-sdk')return {Client:class {constructor(){throw Error('离线检查禁止使用真实SDK；请注入接口替身');}}};
 return original.apply(this,arguments);
};
