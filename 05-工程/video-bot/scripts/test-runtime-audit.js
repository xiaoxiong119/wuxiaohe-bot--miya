const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { load } = require('./test-helpers');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'bot-runtime-'));
const configPath = path.join(root,'config.json');
const destination = {projectUrl:'https://app.mediatrack.cn/projects/123/files?path=1',projectId:'123',folderId:'1'};
const config = {upload:{enabled:true}, projectUrl:destination.projectUrl};
fs.writeFileSync(configPath,JSON.stringify(config));
const cfg = {ROOT:root,STATE_FILE:path.join(root,'state.json'),UPLOAD:{},INBOX:{},DRIVE_INBOX:{},COMMAND:'/upmedia',WAIT_SECONDS:300,
  ALLOW_GROUPS:['group'],ALLOW_P2P:true,ALLOWED_EXT:['.mp4'],DOWNLOAD_DIR:path.join(root,'downloads')};
const downloads=[],sent=[],finished=[],workerFiles=[];
let workerResult={ok:true,countBefore:0,countAfter:1,url:destination.projectUrl};
const inboxFinished=[];
const messageApi = {
  safeName: require('../src/feishu').safeName,
  textContent: msg => msg.message_type==='text' ? JSON.parse(msg.content).text : '',
  parseTextCommand: (msg) => msg.message_type==='text' && /^\/upmedia(?: |$)/.test(JSON.parse(msg.content).text)
    ? {name:JSON.parse(msg.content).text.replace(/^\/upmedia\s*/, '')}:null,
  parseAttachment: msg => msg.message_type==='file' ? {messageId:msg.message_id,fileName:JSON.parse(msg.content).file_name,chatId:msg.chat_id,chatType:msg.chat_type}:null,
  downloadResource: async (att,dest)=>{downloads.push({message:att.messageId,dest});fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'video');},
  sendText: async (_id,text)=>{sent.push(text);return true}, sendCardTo:async()=>true,sendTextTo:async()=>true,
  describeError:async e=>({text:e.message})
};
const local = path.join(root,'scan.mp4'); fs.writeFileSync(local,'scan');
const overrides = {
  './config':cfg,'./log':{log(){}},'./feishu':messageApi,
  './flow':{fetchAllRecords:async()=>[]}, './drive':{parseLink:()=>null},
  './project-context':{projectForTarget:()=>({key:'legacy'})},
  './target':{getTarget:()=>destination},
  './drivefolder':{enabled:()=>true,scanOnce:async()=>({files:1,items:[{token:'scan',name:'scan.mp4',local,size:4}]}),finish:(...args)=>finished.push(args)},
  './admin-runtime':{failed(){}},
  './inbox':{clearBusy(){},markDone:item=>inboxFinished.push(item),markFailed(){throw Error('未知上传不能进入失败箱');}},
  child_process:{spawn:(_bin,args)=>{workerFiles.push(args[1]);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    setImmediate(()=>{child.stdout.end('RESULT_JSON:'+JSON.stringify(workerResult));child.emit('close',0)});return child;}}
};
const globals = {process:{...process,stdout:{write(){}},stderr:{write(){}}}};
const app=load('src/index.js',overrides,globals);
let id=0;
function post(user,type,content,messageId) { app.onMessage({sender:{sender_type:'user',sender_id:{open_id:user}},message:{
  chat_id:'group',chat_type:'group',message_type:type,message_id:messageId||'msg'+(++id),content:JSON.stringify(content)}}); }
async function settle() {for(let i=0;i<35;i++)await new Promise(resolve=>setTimeout(resolve,3));}
(async()=>{try{
  post('alice','file',{file_name:'alice.mp4'});post('bob','file',{file_name:'bob.mp4'});
  post('bob','text',{text:'/upmedia Bob'});post('alice','text',{text:'/upmedia Alice'});await settle();
  assert.equal(path.basename(downloads[0].dest),'Bob.mp4');assert.equal(downloads[0].message,'msg2');
  assert.equal(path.basename(downloads[1].dest),'Alice.mp4');assert.equal(downloads[1].message,'msg1');
  const n=downloads.length;
  post('alice','text',{text:'/upmedia AliceNext'},'repeat-command');post('alice','text',{text:'/upmedia AliceNext'},'repeat-command');
  post('bob','file',{file_name:'bob-next.mp4'});await settle();assert.equal(downloads.length,n,'Bob不能消费Alice的等待命令');
  post('alice','file',{file_name:'alice-next.mp4'});await settle();assert.equal(downloads.length,n+1);
  post('alice','text',{text:'/drive'});await settle();assert.equal(finished.length,1);assert.equal(finished[0][2],true,'手动扫描必须进入上传队列');
  const state=JSON.parse(fs.readFileSync(cfg.STATE_FILE));const key=app.uploadKey('Bob.mp4',destination,'');
  const digest=state.recentUploads[key].sha256;
  assert.ok(app.dupUpload('Bob.mp4',5,'Bob.mp4',destination,'',digest));
  assert.equal(app.dupUpload('Bob.mp4',5,'Bob.mp4',destination,'','different-content'),null,'同大小不同内容不跳过');
  assert.equal(app.dupUpload('Bob.mp4',5,'Bob.mp4',{...destination,folderId:'2'},'',digest),null,'不同目录不跳过');
  assert.equal(app.dupUpload('Bob.mp4',5,'Bob-改.mp4',destination,'',digest),null,'显式改版可重传');
  const disabled=load('src/index.js',{...overrides,'./config':{...cfg,UPLOAD:{dupWindowMinutes:0}}},globals);
  assert.equal(disabled.dupUpload('Bob.mp4',5,'Bob.mp4',destination,'',digest),null);
  const original=path.join(root,'original.mp4');fs.writeFileSync(original,'renamed content');
  await app.runJob({att:{fileName:'original.mp4'},outName:'Sidecar.mp4',localPath:original,uploadTarget:destination});
  assert.equal(path.basename(workerFiles.at(-1)),'Sidecar.mp4','本机投递改名应传递到实际文件');
  assert.equal(fs.existsSync(original),true,'上传副本不能删除原始投递文件');
  workerResult={ok:false,countBefore:1,countAfter:1,url:destination.projectUrl};
  const uncertain=path.join(root,'unknown.mp4');fs.writeFileSync(uncertain,'unknown video');
  let doneCalled=0;
  await app.runJob({att:{messageId:'unknown-source',fileName:'unknown.mp4'},outName:'unknown.mp4',localPath:uncertain,inboxItem:{path:uncertain},uploadTarget:destination,onDone:()=>doneCalled++});
  assert.equal(doneCalled,0,'未知结果不能释放原片或云盘标记');
  const held=require('../src/pending-uploads').createStore(root).list();assert.equal(held.length,1);
  const runs=workerFiles.length;
  await app.resolvePendingUpload({id:held[0].id,action:'confirmed-uploaded'});
  assert.equal(workerFiles.length,runs,'确认已上传只能收尾，禁止再次启动上传');
  assert.equal(inboxFinished.length,1);
  assert.equal(require('../src/pending-uploads').createStore(root).list().length,0);
  await assert.rejects(app.resolvePendingUpload({id:held[0].id,action:'confirmed-uploaded'}),/已处理/);
  // 独立的消息/本地任务在上传期间重启，必须留在待确认台账。
  fs.writeFileSync(path.join(root,'.queue.json'),JSON.stringify([{att:{messageId:'interrupted',fileName:'old.mp4'},outName:'old.mp4',localPath:uncertain,uploadTarget:destination,queuedAt:Date.now(),started:true}]));
  app.restoreQueue();await settle();assert.equal(workerFiles.length,runs);
  assert.equal(require('../src/pending-uploads').createStore(root).list().length,1);
  console.log('PASS: 群内文件与命令按人隔离、命令重投去重、手动云盘扫描入队、内容及目录去重、关闭去重');
}finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
