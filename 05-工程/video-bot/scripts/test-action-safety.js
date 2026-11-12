const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {load}=require('./test-helpers');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-actions-'));
fs.writeFileSync(path.join(root,'config.json'),'{}');
const base={appToken:'fixture',tableId:'fixture'};
const row=id=>({record_id:id,fields:{集数:1,场次:1,进展:'进行中',素材生成进展:'已粗剪待一审',审阅反馈:'未审阅',剪辑进度:'待开始',实际完成日期:123,
  制作师:[{id:'artist',name:'制作师'}],审片人:[{id:'reviewer',name:'审片人'}],剪辑师:[{id:'editor',name:'剪辑师'}]}});
const rows={r1:row('r1'),r2:row('r2'),r3:row('r3'),r4:row('r4')};
const writes=[];let cardCount=0;
const pc={current:()=>({key:'legacy',base,projectUrl:'https://app.mediatrack.cn/projects/123/files'}),
  forRecord:async(_id,fn)=>fn(),run:async(_key,fn)=>fn(),register:x=>x,projects:()=>[]};
const f=load('src/flow.js',{
  './config':{ROOT:root,BASE:base,INBOX:{notifyOpenId:'owner'}},'./log':{log(){}},'./project-context':pc,
  './status-vocab':{has:()=>true},
  './feishu':{withTimeout:p=>p,sendTextTo:async()=>true,getClient:()=>({bitable:{v1:{appTableRecord:{
    get:async({path:p})=>({data:{record:structuredClone(rows[p.record_id])}}),
    update:async({path:p,data})=>{writes.push({id:p.record_id,fields:data.fields});Object.assign(rows[p.record_id].fields,data.fields);return {code:0}},
  }}},im:{v1:{message:{create:async()=>{cardCount++;return {code:0}},patch:async()=>({code:0})}}}})},
});
(async()=>{try{
  const denied=await f.handleCardAction({a:'review_fail',r:'r1'},'stranger','m0');
  assert.equal(denied.toast.type,'error');assert.equal(writes.length,0);
  await f.handleCardAction({a:'review_pass',r:'r1'},'reviewer','m1');
  rows.r1.fields.素材生成进展='已完成并上传';
  const undo=await f.handleCardAction({a:'undo',r:'r1',m:'m1'},'reviewer','m1');
  assert.equal(undo.toast.type,'success');assert.equal(rows.r1.fields.审阅反馈,'未审阅');
  assert.equal(rows.r1.fields.素材生成进展,'已完成并上传','撤回不覆盖随后改变的无关字段');
  await f.handleCardAction({a:'review_pass',r:'r1'},'reviewer','m2');
  const cross=await f.handleCardAction({a:'undo',r:'r2',m:'m2'},'reviewer','m2');assert.equal(cross.toast.type,'error');
  rows.r1.fields.审阅反馈='有修改';
  const stale=await f.handleCardAction({a:'undo',r:'r1',m:'m2'},'reviewer','m2');
  assert.equal(stale.toast.type,'error');assert.equal(rows.r1.fields.审阅反馈,'有修改');
  const before=writes.length;
  const result=await Promise.all([f.handleCardAction({a:'review_pass',r:'r3'},'reviewer','m3'),f.handleCardAction({a:'review_fail',r:'r3'},'reviewer','m4')]);
  assert.equal(writes.length,before+1,'同一任务相反的并发动作只能执行一个');assert.equal(result[1].toast.type,'info');
  await f.handleCardAction({a:'final_pass',r:'r3'},'reviewer','m5');
  assert.notEqual(rows.r3.fields.实际完成日期,123);
  await f.handleCardAction({a:'undo',r:'r3',m:'m5'},'reviewer','m5');
  assert.equal(rows.r3.fields.实际完成日期,123,'撤回定剪恢复原日期');
  const pending=await f.getRecord('r2');
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({privateNotificationOptOut:[{openId:'reviewer',name:'审片人'}]}));
  const count=cardCount;for(let i=0;i<4;i++)assert.equal(await f.autoReview(pending),false);
  assert.equal(cardCount,count,'免通知人员不调用消息接口');
  fs.writeFileSync(path.join(root,'config.json'),'{}');assert.equal(await f.autoReview(pending),true,'恢复通知后仍可补发');
  const quietRecord=await f.getRecord('r4');
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({notificationPolicy:{quiet:{enabled:true,start:'00:00',end:'00:00'}}}));
  assert.equal(await f.autoReview(quietRecord),false);
  fs.writeFileSync(path.join(root,'config.json'),'{}');assert.equal(await f.autoReview(quietRecord),false,'免打扰结束后不补发旧通知');
  console.log('PASS: 单卡负责人权限、同任务互斥、撤回仅改自身字段、拒绝跨记录与过期撤回、恢复原完成日期');
}finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
