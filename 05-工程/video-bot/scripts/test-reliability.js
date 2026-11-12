const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),util=require('node:util');
const {EventEmitter}=require('node:events');
const {load}=require('./test-helpers');
const {allPages}=require('../src/pagination');
const {writeJson}=require('../src/json-file');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-reliability-'));
const configPath=path.join(root,'config.json');
async function testPages(){
  let calls=0;
  assert.deepEqual(await allPages(async token=>({code:0,data:token?{items:[2],has_more:false}:{items:[1],has_more:true,page_token:'next'}})),[1,2]);
  await assert.rejects(allPages(async()=>({code:1254607,msg:'Data not ready',data:{items:[]}})),/1254607/);
  await assert.rejects(allPages(async()=>({data:{items:[],has_more:true}})),/分页异常/);
  await assert.rejects(allPages(async()=>({data:{items:[],has_more:true,page_token:'same'}})),/分页异常/);
  await assert.rejects(allPages(async()=>({data:{items:[],has_more:true,page_token:String(++calls)}}),{limit:2}),/上限/);
}
async function testDrive(){
  let paused=true,fetches=0,downloads=0;
  const driveRoot=path.join(root,'drive');fs.mkdirSync(driveRoot);
  const folder=load('src/drivefolder.js',{
    './config':{ROOT:driveRoot,DRIVE_INBOX:{enabled:true,auto:false,folderToken:'fixture'},ALLOWED_EXT:['.mp4']},
    './log':{log(){}},os:{tmpdir:()=>driveRoot},
    './drive':{tenantToken:async()=> 'fixture',download:async(_token,file)=>{downloads++;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'video')}},
  },{fetch:async()=>{fetches++;return {json:async()=>({code:0,data:{files:[{type:'file',token:'item',name:'../escape.mp4'}],has_more:false}})}}});
  folder.start(()=>{},()=>paused);
  assert.equal((await folder.scanOnce()).paused,true);assert.equal(fetches,0);
  paused=false;const first=await folder.scanOnce();assert.equal(first.items.length,1);assert.equal(downloads,1);
  assert.ok(first.items[0].local.startsWith(driveRoot+path.sep));
  assert.equal((await folder.scanOnce()).items.length,0,'已下载并排队的文件不能再次下载');
  folder.finish('item',first.items[0].local,false);assert.equal(folder.isDone('item'),false);
  const retry=await folder.scanOnce();assert.equal(retry.items.length,1);
  folder.finish('item',retry.items[0].local,true);assert.equal(folder.isDone('item'),true);
  assert.equal((await folder.scanOnce()).items.length,0);
}
async function testInbox(){
  const inboxRoot=path.join(root,'inbox');fs.mkdirSync(inboxRoot);
  const inbox=load('src/inbox.js',{'./config':{ROOT:root,INBOX_DIR:inboxRoot,ALLOWED_EXT:['.mp4']},'./log':{log(){}}});
  const file=path.join(inboxRoot,'source.mp4'),sidecar=path.join(inboxRoot,'source.txt');
  fs.writeFileSync(file,'first');fs.writeFileSync(sidecar,'custom');
  const old=new Date(Date.now()-10000);fs.utimesSync(file,old,old);
  assert.equal(inbox.scan().length,0);const items=inbox.scan();assert.equal(items.length,1);assert.equal(items[0].outName,'custom.mp4');
  inbox.markDone(items[0]);assert.equal(fs.readFileSync(path.join(inbox.DONE,'source.mp4'),'utf8'),'first');
  fs.writeFileSync(file,'second');fs.writeFileSync(sidecar,'custom2');fs.utimesSync(file,old,old);inbox.scan();
  inbox.markDone(inbox.scan()[0]);
  assert.equal(fs.readFileSync(path.join(inbox.DONE,'source.mp4'),'utf8'),'first','归档不能覆盖同名原片');
  assert.equal(fs.readdirSync(inbox.DONE).filter(f=>f.endsWith('.mp4')).length,2);
}
async function testReminder(){
  const now=new Date(2026,10,12,18,15);
  class FixedDate extends Date {constructor(...args){super(...(args.length?args:[now.getTime()]))}}
  const c={enabled:false,hour:18,minute:15,chatId:'group',projectKey:'nts3'};
  fs.writeFileSync(configPath,JSON.stringify({pointsReminder:c}));
  let tick,sends=0;
  const st={pointsSent:[]};
  const r=load('src/points-reminder.js',{
    './config':{ROOT:root},'./log':{log(){}},
    './project-context':{run:async(_key,fn)=>fn(),current:()=>({base:{appToken:'fixture',tableId:'fixture'}})},
    './workday':{checkWorkday:async()=>({work:true}),ymd:()=> '2026-11-12'},
    './feishu':{getClient:()=>({bitable:{v1:{appTableRecord:{search:async()=>({data:{items:[{fields:{集数:1,场次:1,进展:'进行中',开始日期:new Date(2026,10,12).getTime(),制作师:[{id:'artist',name:'测试人员'}]}}],has_more:false}})}}}}),
      sendInteractive:async()=> ++sends>1,sendCardTo:async()=>true},
  },{Date:FixedDate,setInterval:fn=>{tick=fn;return {unref(){}}}});
  r.startScheduler(()=>st,()=>{});assert.equal(typeof tick,'function','启动时停用仍支持之后启用');
  c.enabled=true;fs.writeFileSync(configPath,JSON.stringify({pointsReminder:c}));
  await tick();assert.equal(sends,1);assert.equal(st.pointsSent.length,0,'失败不能记成已发');
  await tick();assert.equal(sends,2);assert.deepEqual(st.pointsSent,['2026-11-12']);
  await tick();assert.equal(sends,2,'成功后当天不重复发送');
}
async function testHealth(){
  fs.mkdirSync(path.join(root,'logs'),{recursive:true});
  const today=new Date().toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(root,'logs',`selftest-${today}.json`),JSON.stringify({ok:true,steps:[]}));
  const exec=()=>{};exec[util.promisify.custom]=async()=>({stdout:'{"running":false}'});
  const names=['集数','进展','素材生成进展','审阅反馈','剪辑进度','制作师','审片人','剪辑师','开始日期'];
  const h=load('src/health.js',{
    './config':{ROOT:root,INBOX:{},BASE:{appToken:'fixture',tableId:'fixture'},DOWNLOAD_DIR:path.join(root,'download'),FLOW:{tickMinutes:1}},
    './bitable':{listFields:async()=>names.map(name=>({name}))},'./flow':{getLastTick:()=>({at:Date.now(),stats:{scanned:1}})},
    './project-context':{current:()=>({name:'测试项目'})},'./log':{log(){},errorLines:()=>[]},
    './target':{getTarget:()=>({projectUrl:'bad-url',projectId:''})},
    './feishu':{withTimeout:p=>p,getClient:()=>({bitable:{v1:{appTableRecord:{search:async()=>({data:{total:1}})}}}})},
    child_process:{execFile:exec},
  });
  const result=await h.probe({lastUpload:{at:Date.now(),file:'test.mp4',ok:false}});
  assert.equal(result.checks.find(x=>x.name==='浏览器服务 bsk').ok,false);
  assert.equal(result.checks.find(x=>x.name==='分秒帧目标').ok,false);
  assert.equal(result.checks.find(x=>x.name==='最近一次上传').ok,false);
}
async function testPartialComments(){
  const conf={reviewSync:{appToken:'fixture',tableId:'fixture',mediatrackUrl:'https://app.mediatrack.cn/projects/123/files',lastSyncAt:Date.now()}};
  fs.writeFileSync(configPath,JSON.stringify(conf));
  let drain,writes=0,badge=0,changeTarget=false;
  const api={appTableField:{list:async()=>({data:{items:[]}})},appTableRecord:{search:async()=>({data:{items:[],has_more:false}}),create:async()=>{writes++;if(changeTarget){const current=JSON.parse(fs.readFileSync(configPath));current.reviewSync.tableId='changed-target';fs.writeFileSync(configPath,JSON.stringify(current));}return {code:0}}}};
  const sync=load('src/reviewsync.js',{
    './config':{ROOT:root},'./log':{log(){}},'./feishu':{getClient:()=>({bitable:{v1:api}}),withTimeout:p=>p},
    child_process:{spawn:(_cmd,args)=>{const child=new EventEmitter();
      const line=JSON.stringify({file:'71.mp4',count:badge,comments:[{timeline:'00:21',content:'补充批注',dateText:'2026-11-12 10:00'}]});
      fs.writeFileSync(args[2],line.slice(0,15));
      setImmediate(async()=>{drain();await new Promise(resolve=>setImmediate(resolve));fs.appendFileSync(args[2],line.slice(15)+'\n');child.emit('close',0)});return child;}},
  },{setInterval:(fn,ms)=>{if(ms===20000)drain=fn;return {unref(){}}},clearInterval(){}});
  const at=Date.parse('2026-11-12T12:00:00+08:00');
  assert.equal(sync.dateToMs('2026-11-10 09:01',at),Date.parse('2026-11-10T09:01:00+08:00'));
  assert.equal(sync.dateToMs('前天 09:01',at),Date.parse('2026-11-10T09:01:00+08:00'));
  assert.equal(sync.dateToMs('12-31 09:01',Date.parse('2027-01-02T10:00:00+08:00')),Date.parse('2026-12-31T09:01:00+08:00'));
  assert.equal(sync.dateToMs('2026-02-30',at),0);
  const result=await sync.run();assert.equal(result.videos,1);assert.equal(writes,1,'分两次落盘的一条批注必须保留');
  badge=2;const partial=await sync.run({dryRun:true});assert.equal(partial.cacheComplete,false,'角标显示有未读批注时不能推水位');
  badge=0;changeTarget=true;const last=JSON.parse(fs.readFileSync(configPath)).reviewSync.lastSyncAt;
  await assert.rejects(sync.run(),/目标已变更/);assert.equal(JSON.parse(fs.readFileSync(configPath)).reviewSync.lastSyncAt,last);
}
async function testJsonAndLog(){
  writeJson(configPath,{valid:true});assert.deepEqual(JSON.parse(fs.readFileSync(configPath)),{valid:true});
  const circular={};circular.self=circular;assert.throws(()=>writeJson(configPath,circular));
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)),{valid:true},'失败不能破坏旧配置');
  let bytes=0;const wrapped={...fs,readSync(...args){bytes+=args[3];return fs.readSync(...args)}};
  fs.writeFileSync(path.join(root,'logs/bot.log'),'x'.repeat(4*1024*1024)+'\n第一行\n第二行\n');
  const log=load('src/log.js',{fs:wrapped},{__dirname:path.join(root,'src')});
  assert.equal(log.tailLines(2).join('|'),'第一行|第二行');assert.equal(log.tailLines(0).length,0);assert.ok(bytes<32768,'读末尾日志不应读全文件');
}
(async()=>{try{await testPages();await testDrive();await testInbox();await testReminder();await testHealth();await testPartialComments();await testJsonAndLog();
  console.log('PASS: 分页/业务错误、暂停与恢复、失败重试、提醒去重、体检真实状态、批注半行与日期、原子配置、日志限量读取');
}finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
