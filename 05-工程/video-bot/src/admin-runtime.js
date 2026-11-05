const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=require('./config').ROOT;
function read(name,fallback){try{return JSON.parse(fs.readFileSync(path.join(ROOT,name),'utf8'))}catch{return fallback}}
function write(name,data){const p=path.join(ROOT,name);fs.writeFileSync(p+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(p+'.tmp',p)}
function failed(job,error){
 // 飞书消息任务保留重试描述，本地投递箱任务由 failed/ 直接恢复。
 if(!job.att?.messageId||job.localPath||job.att.driveToken)return;
 const list=read('admin-failures.json',[]);list.push({id:crypto.randomUUID(),at:Date.now(),name:job.outName,error:String(error).slice(0,1000),status:'failed',job:{att:job.att,outName:job.outName,projectKey:job.projectKey,uploadTarget:job.uploadTarget,by:job.by,notifyOpenId:job.notifyOpenId,cmdName:job.cmdName}});write('admin-failures.json',list.slice(-100));
}
function tick(snapshot,enqueue){
 write('admin-runtime.json',{...snapshot,pid:process.pid,at:Date.now()});
 const dir=path.join(ROOT,'admin-commands');fs.mkdirSync(dir,{recursive:true});
 for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))){const file=path.join(dir,name);const claim=file+'.working';try{fs.renameSync(file,claim);const c=JSON.parse(fs.readFileSync(claim));const list=read('admin-failures.json',[]);const f=list.find(x=>x.id===c.id&&x.status==='failed');if(f){if(Date.now()-f.at>12*3600000)throw Error('超过12小时，请重新提交文件');enqueue({...f.job,retried:true,queuedAt:Date.now()});f.status='queued';write('admin-failures.json',list);}fs.unlinkSync(claim);}catch(e){console.error('管理台任务处理失败',e.message);try{fs.renameSync(claim,claim+'.error')}catch{}}}
}
module.exports={failed,tick};
