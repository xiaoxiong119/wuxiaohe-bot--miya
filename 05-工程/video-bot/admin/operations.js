const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(execFile);
const ROOT=process.env.ADMIN_TEST_ROOT||path.resolve(__dirname,'..');
function read(n,f){try{return JSON.parse(fs.readFileSync(path.join(ROOT,n),'utf8'))}catch{return f}}
function runtime(){const r=read('admin-runtime.json',null);let pid;try{pid=Number(fs.readFileSync(path.join(ROOT,'bot.pid')))}catch{};return r&&r.pid===pid&&Date.now()-r.at<12000?r:null}
function files(dir){try{return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&!e.isSymbolicLink()).map(e=>{const s=fs.lstatSync(path.join(dir,e.name));return {name:e.name,bytes:s.size,mtime:s.mtimeMs}})}catch{return []}}
function inboxRoot(){return path.resolve(ROOT,read('config.json',{}).inbox?.dir||'inbox')}
function state(){let alert='';try{const p=path.join(ROOT,'logs/bot.log');const size=fs.statSync(p).size;const fd=fs.openSync(p,'r');const buf=Buffer.alloc(Math.min(size,256*1024));try{fs.readSync(fd,buf,0,buf.length,Math.max(0,size-buf.length));}finally{fs.closeSync(fd)}const text=buf.toString();if(text.lastIndexOf('分秒帧登录已过期')>Math.max(text.lastIndexOf('✅ 上传成功'),text.lastIndexOf('✅ 版本更新完成')))alert='最近的上传报告登录已过期，请在 Chrome 中重新登录；尚未确认恢复。';}catch{}const failed=files(path.join(inboxRoot(),'failed')).filter(f=>/\.(mp4|mov|mkv|avi|m4v|webm|flv|ts)$/i.test(f.name));return {alert,commandResults:read('admin-command-results.json',[]),pendingUploads:require('../src/pending-uploads').createStore(ROOT).list().map(({job,localPath,...r})=>r),notifications:read('notification-outbox.json',[]).map(e=>({id:e.id,label:e.label,at:e.at,recipients:e.recipients.map(({id,status,error,attempts,sentAt})=>({id,status,error,attempts,sentAt}))})),runtime:runtime(),failures:read('admin-failures.json',[]).map(({job,...r})=>r),inboxFailed:failed,backups:files(path.join(ROOT,'backups/admin')).filter(f=>f.name.endsWith('.json')).sort((a,b)=>b.mtime-a.mtime).slice(0,50),disk:{downloads:files(path.join(ROOT,'downloads')),done:files(path.join(inboxRoot(),'done'))},browser:read('admin-browser.json',{status:'unknown',detail:'尚未检测'})};}
function safeName(s){if(typeof s!=='string'||!s||path.basename(s)!==s||s.startsWith('.'))throw Error('文件名无效');return s}
async function action(c){
 if(['confirmed-uploaded','confirmed-uploaded-no-backwrite','confirmed-missing-retry','notification-retry'].includes(c.action)){
 if(!runtime())throw Error('机器人未连接管理台');
 const type=c.action==='notification-retry'?'notification-retry':'upload-confirm';
 if(type==='upload-confirm'&&!require('../src/pending-uploads').createStore(ROOT).list().some(r=>r.id===c.id))throw Error('待确认记录不存在');
 if(type==='notification-retry'&&!read('notification-outbox.json',[]).some(r=>r.id===c.id))throw Error('通知记录不存在');
 const dir=path.join(ROOT,'admin-commands');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,require('node:crypto').randomUUID()+'.json'),JSON.stringify({type,id:c.id,action:c.action}),{flag:'wx',mode:0o600});
 return '核对请求已提交，请刷新查看处理结果；通知补发不会重复业务动作。';
 }
 if(c.action==='retry'){
 const r=runtime();if(!r)throw Error('机器人未连接管理台，请先启动或更新机器人');
 if(c.source==='inbox'){
 const name=safeName(c.name);const src=path.join(inboxRoot(),'failed',name),dest=path.join(inboxRoot(),name);if(!state().inboxFailed.some(x=>x.name===name))throw Error('失败文件不存在');if(fs.existsSync(dest))throw Error('投递箱已有同名文件');if(fs.lstatSync(src).isSymbolicLink())throw Error('不允许符号链接');
 const sidecar=[src+'.txt',src.replace(/\.[^.]+$/,'.txt')].find(p=>fs.existsSync(p));
 const destSidecar=dest.replace(/\.[^.]+$/,'.txt');
 if(sidecar&&(fs.lstatSync(sidecar).isSymbolicLink()||fs.existsSync(destSidecar)))throw Error('改名说明存在冲突，请先核对投递箱');
 fs.renameSync(src,dest);if(sidecar)fs.renameSync(sidecar,destSidecar);
 }else{const f=read('admin-failures.json',[]).find(x=>x.id===c.id&&x.status==='failed');if(!f||Date.now()-f.at>12*3600000)throw Error('任务不存在或已超过12小时，请重新提交');const dir=path.join(ROOT,'admin-commands');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,f.id+'.json');fs.writeFileSync(file,JSON.stringify({id:f.id}),{flag:'wx',mode:0o600});}
 return '已请求重试，将沿用机器人原有上传和通知流程；上传可能创建新版本。';
 }
 if(['start','stop','restart','archive'].includes(c.action)){
 const r=runtime();if(c.action!=='start'&&(!r||r.current||r.queue?.length||r.sync))throw Error('请等待上传、排队和同步任务结束，且机器人状态在线后操作');
 if(c.action==='archive'){
 const trash=path.join(ROOT,'backups','quarantine',String(Date.now()));let count=0;for(const dir of [path.join(ROOT,'downloads'),path.join(inboxRoot(),'done')])for(const f of files(dir)){if(Date.now()-f.mtime<7*86400000)continue;const src=path.join(dir,f.name);if(fs.lstatSync(src).isSymbolicLink())continue;const dest=path.join(trash,path.basename(dir));fs.mkdirSync(dest,{recursive:true});fs.renameSync(src,path.join(dest,f.name));count++;}return '已将 '+count+' 个超过7天的文件移入 backups/quarantine，可手动恢复。此操作不释放磁盘空间。';
 }
 const env={...process.env};delete env.NODE_OPTIONS;for(const k of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[k];
 if(c.action==='stop'||c.action==='restart')await exec('/bin/bash',[path.join(ROOT,'stop.sh')],{cwd:ROOT,timeout:20000,env});
 if(c.action==='start'||c.action==='restart')await exec('/bin/bash',[path.join(ROOT,'start.sh')],{cwd:ROOT,timeout:30000,env});
 return '机器人'+({start:'启动',stop:'停止',restart:'重启'}[c.action])+'命令已完成，请刷新状态确认';
 }
 if(c.action==='browser'){
 const p=path.join(ROOT,'logs/bot.log');let log='';if(fs.existsSync(p)){const fd=fs.openSync(p,'r');try{const size=fs.fstatSync(fd).size,b=Buffer.alloc(Math.min(size,256*1024));fs.readSync(fd,b,0,b.length,size-b.length);log=b.toString('utf8');}finally{fs.closeSync(fd);}}const expired=log.lastIndexOf('分秒帧登录已过期'),success=Math.max(log.lastIndexOf('✅ 上传成功'),log.lastIndexOf('✅ 版本更新完成'));
 let result;try{const r=await exec(path.join(process.env.HOME,'.local/bin/bsk'),['status','--json'],{timeout:8000,env:{...process.env,BSK_AUTO_START:'0'}});const s=JSON.parse(r.stdout);result={status:s.running===false?'offline':expired>success?'expired':'unknown',detail:s.running===false?'浏览器服务未运行':expired>success?'最近一次上传检测到登录过期，请在 Chrome 中重新登录':'浏览器服务可用；登录态尚未重新验证，下一次真实上传将验证'};}catch(e){result={status:'offline',detail:'浏览器服务不可用：'+e.message.slice(0,150)}}result.at=new Date().toISOString();fs.writeFileSync(path.join(ROOT,'admin-browser.json'),JSON.stringify(result),{mode:0o600});return result.detail;
 }
 throw Error('未知操作');
}
module.exports={state,action,runtime};
