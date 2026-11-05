const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-admin-v2-'));process.env.ADMIN_TEST_ROOT=root;
const fixture={projectUrl:'https://app.mediatrack.cn/projects/123/files',scheduleSync:{people:{}},notificationPolicy:{quiet:{enabled:false,start:'22:00',end:'08:00'},features:{}}};
fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(fixture));
const policy=require('../src/notification-policy');const {patch,state}=require('./server');const operations=require('./operations');
(async()=>{try{
 // Rules and restore affect an isolated temporary configuration.
 const features=Object.fromEntries(Object.keys(policy.FEATURES).map(k=>[k,{enabled:true,mode:'business',openIds:[]}]));features.review={enabled:true,mode:'selected',openIds:['ou_allowed123']};
 const before=state();await patch({revision:before.revision,kind:'policy',policy:{quiet:fixture.notificationPolicy.quiet,features}});
 let config=JSON.parse(fs.readFileSync(path.join(root,'config.json')));assert.ok(policy.reason(config,'ou_blocked123','review'));assert.equal(policy.reason(config,'ou_allowed123','review'),'');
 await assert.rejects(patch({revision:state().revision,kind:'policy',policy:{quiet:{enabled:true,start:'99:99',end:'00:00'},features}}),/时间/);
 const backup=fs.readdirSync(path.join(root,'backups/admin'))[0];await patch({revision:state().revision,kind:'restore',name:backup});assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'config.json'))),fixture);
 assert.equal(policy.quietAt({enabled:true,start:'22:00',end:'08:00'},new Date('2026-10-29T21:59:00+08:00')),false);assert.equal(policy.quietAt({enabled:true,start:'22:00',end:'08:00'},new Date('2026-10-29T22:00:00+08:00')),true);assert.equal(policy.quietAt({enabled:true,start:'22:00',end:'08:00'},new Date('2026-10-30T08:00:00+08:00')),false);
 // SDK boundary: feature scopes reach the real interception wrapper; no actual sends.
 const calls=[];const moduleMock={exports:{}};const sandbox={module:moduleMock,__dirname:path.resolve(__dirname,'../src'),setTimeout,clearTimeout,require(n){if(n==='./config')return {ROOT:root,APP_ID:'test',APP_SECRET:'test'};if(n==='./log')return {log(){}};if(n==='./notification-policy')return policy;if(n==='@larksuiteoapi/node-sdk')return {Client:class{constructor(){this.im={v1:{message:{create:async r=>{calls.push(r);return {code:0}}}}}}}};return require(n)}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/feishu.js'),'utf8'),sandbox);config.notificationPolicy.features=features;fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));const api=moduleMock.exports;
 assert.equal(await policy.context.run('review',()=>api.sendCardTo('ou_blocked123',{})),false);assert.equal(await policy.context.run('review',()=>api.sendCardTo('ou_allowed123',{})),true);assert.equal(await api.sendInteractive('oc_group',{}),true);assert.equal(calls.length,2);
 // Retry uses a verified stored failure and refuses directory traversal and duplicate requests.
 fs.writeFileSync(path.join(root,'bot.pid'),'123');fs.writeFileSync(path.join(root,'admin-runtime.json'),JSON.stringify({pid:123,at:Date.now(),current:null,queue:[],sync:false}));fs.mkdirSync(path.join(root,'inbox/failed'),{recursive:true});fs.writeFileSync(path.join(root,'inbox/failed/a.mp4'),'fixture');await assert.rejects(operations.action({action:'retry',source:'inbox',name:'../config.json'}),/文件名/);await operations.action({action:'retry',source:'inbox',name:'a.mp4'});assert.ok(fs.existsSync(path.join(root,'inbox/a.mp4')));
 fs.writeFileSync(path.join(root,'admin-failures.json'),JSON.stringify([{id:'fake-job',at:Date.now(),status:'failed',job:{}}]));await operations.action({action:'retry',id:'fake-job'});await assert.rejects(operations.action({action:'retry',id:'fake-job'}),/EEXIST/);
 fs.writeFileSync(path.join(root,'admin-runtime.json'),JSON.stringify({pid:123,at:Date.now(),current:{name:'working.mp4'},queue:[],sync:false}));await assert.rejects(operations.action({action:'restart'}),/等待上传/);
 const {pages}=require('./directory');let page=0;assert.deepEqual(await pages(async token=>({code:0,data:page++?{items:[2],has_more:false}:{items:[1],has_more:true,page_token:'next'}})),[1,2]);await assert.rejects(pages(async()=>({code:0,data:{items:[],has_more:true,page_token:'same'}})),/分页/);
 console.log('PASS：规则保存和回退、跨日免打扰边界、真实SDK出口拦截、群聊不变、失败重试与重复拒绝、通讯录分页');
 }finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
