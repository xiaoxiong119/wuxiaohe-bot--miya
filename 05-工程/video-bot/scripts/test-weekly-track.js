const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {load}=require('./test-helpers');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-weekly-'));
fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({sceneProjects:[{key:'nts3',base:{appToken:'configured-base',tableId:'configured-table'}}],scheduleSync:{targetUrl:'https://example.test/tasks'}}));
let target;
const report=load('scripts/weekly-track.js',{
  '../src/config':{ROOT:root,INBOX:{}},'../src/log':{log(){}},
  '../src/feishu':{getClient:()=>({bitable:{v1:{appTableRecord:{search:async request=>{target=request.path;return {code:0,data:{items:[],has_more:false}}}}}}})},
});
(async()=>{try{
  const r={id:'r1',ep:'1',scene:'1',sceneName:'庭院',artists:['测试人员'],editors:[],stage:'已完成并上传',progress:'进行中',review:'通过'};
  const old={records:{r1:{...r,stage:'生成中'}}};
  const events=report.diffRecords(old,new Map([['r1',r]]),'2026-11-11T17:00:00.000Z');
  assert.equal(events[0].date,'2026-11-12','凌晨事件按北京时间归入当天');
  await report.readAll();assert.equal(target.app_token,'configured-base');assert.equal(target.table_id,'configured-table');
  console.log('PASS: 周报读取配置中的第三季表，跨UTC日界的事件按北京时间归档');
}finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
