const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = process.env.ADMIN_TEST_ROOT || path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const PORT = Number(process.env.ADMIN_PORT || 18765);
const directory = require('./directory');
const operations = require('./operations');
const FEATURES = require('../src/notification-policy').FEATURES;
const TOKEN = crypto.randomBytes(32).toString('hex');
const read = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const revision = s => crypto.createHash('sha256').update(s).digest('hex');
const fields = [
 ['projectUrl','视频上传目标','media','立即生效'],
 ['base.previewUrl','审阅卡片中的预览链接','media','重启机器人后生效'],
 ['reviewSyncNts3.mediatrackUrl','第三季粗剪 · 分秒帧批注来源','media','下次同步生效'],
 ['reviewSyncNts3.bitableUrl','第三季粗剪 · 批注写入表','base','下次同步生效'],
 ['reviewSyncNts3FineCut.mediatrackUrl','第三季精剪 · 分秒帧批注来源','media','下次同步生效'],
 ['reviewSyncNts3FineCut.bitableUrl','第三季精剪 · 批注写入表','base','下次同步生效'],
 ['reviewSync.mediatrackUrl','第二季粗剪 · 分秒帧批注来源','media','下次同步生效'],
 ['reviewSync.bitableUrl','粗剪 · 批注写入表','base','下次同步生效'],
 ['reviewSyncFineCut.mediatrackUrl','精剪 · 分秒帧批注来源','media','下次同步生效'],
 ['reviewSyncFineCut.bitableUrl','精剪 · 批注写入表','base','下次同步生效'],
 ['driveInbox.folderUrl','云盘收件文件夹','folder','重启机器人后生效'],
 ['scheduleSync.sourceUrl','排期同步来源','sheet','下次同步生效'],
 ['scheduleSync.targetUrl','排期同步目标表','base','下次同步生效'],
];
function get(c,k){return k.split('.').reduce((o,p)=>o?.[p],c)||'';}
function put(c,k,v){const parts=k.split('.'); const last=parts.pop(); let o=c;for(const p of parts)o=o[p]??={};o[last]=v;}
function redact(s){return String(s).replace(/((?:app_secret|access_token|authorization|password)["'\s:=]+)[^\s,"']+/ig,'$1[已隐藏]').replace(/Bearer\s+\S+/ig,'Bearer [已隐藏]');}
function tail(file){if(!fs.existsSync(file))return '';const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size;const start=Math.max(0,size-256*1024);const b=Buffer.alloc(size-start);fs.readSync(fd,b,0,b.length,start);const s=b.toString('utf8');return start?s.slice(s.indexOf('\n')+1):s;}finally{fs.closeSync(fd);}}
function people(c){const m=new Map();for(const p of Object.values(c.scheduleSync?.people||{}))m.set(p.id,{name:p.name,openId:p.id});for(const p of directory.read().people)m.set(p.openId,p);for(const p of c.adminPeople||[])m.set(p.openId,{...m.get(p.openId),...p});for(const p of c.privateNotificationOptOut||[])m.set(p.openId,{...m.get(p.openId),...p});const deps=directory.read().departments;return [...m.values()].map(p=>({...p,departments:(p.departmentIds||[]).map(id=>deps.find(d=>d.id===id)?.name||id),enabled:!(c.privateNotificationOptOut||[]).some(b=>b.openId===p.openId)}));}
function audit(event){fs.mkdirSync(path.join(ROOT,'logs'),{recursive:true});fs.appendFileSync(path.join(ROOT,'logs/admin-audit.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600});}
let busy=false;
async function patch(input){
 if(busy)throw new Error('有一项保存正在进行，请稍后重试');busy=true;
 try{
 const before=fs.readFileSync(CONFIG,'utf8');if(input.revision!==revision(before))throw new Error('配置已被其他操作修改，请刷新后重新保存');
 const c=JSON.parse(before); let message='';
 if(input.kind==='person'){
 const {openId,name,enabled}=input;if(!/^ou_[a-zA-Z0-9]{8,80}$/.test(openId)||typeof name!=='string'||!name.trim()||name.length>80||typeof enabled!=='boolean')throw new Error('请填写姓名与有效的飞书 open_id');
 c.adminPeople=[...(c.adminPeople||[]).filter(p=>p.openId!==openId),{openId,name:name.trim()}];
 c.privateNotificationOptOut=(c.privateNotificationOptOut||[]).filter(p=>p.openId!==openId);
 if(!enabled)c.privateNotificationOptOut.push({openId,name:name.trim(),reason:'本机管理台设置'});
 message='私聊通知设置已保存，立即生效。开启表示允许现有业务规则发送，不会主动发消息。';
 }else if(input.kind==='policy'){
 const p=input.policy;if(!p||typeof p!=='object'||!p.quiet||typeof p.quiet.enabled!=='boolean')throw Error('通知规则格式不正确');
 for(const time of [p.quiet.start,p.quiet.end])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('时间应为 HH:MM');
 const features={};for(const key of Object.keys(FEATURES)){const f=p.features?.[key];if(!f||typeof f.enabled!=='boolean'||!['business','selected'].includes(f.mode)||!Array.isArray(f.openIds)||f.openIds.some(id=>!/^ou_[a-zA-Z0-9]{8,80}$/.test(id)))throw Error('功能规则无效');features[key]={enabled:f.enabled,mode:f.mode,openIds:[...new Set(f.openIds)]};}
 c.notificationPolicy={quiet:p.quiet,features};message='规则已保存。新代码加载后即时生效；免打扰期间跳过通知，结束后不补发。功能名单只限制原业务接收人。';
 }else if(input.kind==='restore'){
 if(typeof input.name!=='string'||!/^\d+-[a-f0-9]+\.json$/.test(input.name))throw Error('备份名无效');
 const restored=JSON.parse(fs.readFileSync(path.join(ROOT,'backups/admin',input.name),'utf8'));if(!restored.projectUrl||typeof restored.projectUrl!=='string')throw Error('备份配置不完整');
 for(const k of Object.keys(c))delete c[k];Object.assign(c,restored);message='已恢复备份，恢复前的配置也已自动备份；启动时加载的配置需要重启机器人。';
 }else if(input.kind==='link'){
 const field=fields.find(f=>f[0]===input.key);if(!field)throw new Error('不支持的配置项');
 const u=new URL(input.value);if(u.protocol!=='https:'||u.username||u.password)throw new Error('请使用 HTTPS 链接');
 if(field[2]==='media'){
 // 两种来源都收：项目文件页 /projects/<id>/files(?path=<目录id>)，以及受邀审片空间 /reviews/<id>?fileId=…
 // 采集脚本只认列表卡片（div.item + img[alt]），这两种页面都有，2026-11-02 实测 reviews 空间可正常采集。
 const projectFiles=/^\/projects\/\d+\/files\/?$/.test(u.pathname)&&(!u.searchParams.has('path')||/^\d+$/.test(u.searchParams.get('path')));
 const reviewSpace=/^\/reviews\/\d+\/?$/.test(u.pathname);
 if(input.key==='projectUrl'&&!projectFiles)throw new Error('视频上传目标必须是分秒帧项目 files 链接');
 if(u.hostname!=='app.mediatrack.cn'||!(projectFiles||reviewSpace))throw new Error('需要分秒帧项目 files 链接或审片空间 reviews 链接');
 }else{
 if(!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(u.hostname))throw new Error('需要飞书链接');
 const section=input.key.split('.')[0];
 if(field[2]==='base'){
 if(!/^tbl[a-zA-Z0-9]+$/.test(u.searchParams.get('table')||''))throw new Error('表格链接必须包含 table 参数');
 const parsed=await require('../src/reviewsync').parseBitableUrl(u.href);
 if(!parsed.appToken)throw new Error('无法解析表格真实标识');Object.assign(c[section]??={},parsed);
 }else if(field[2]==='folder'){
 const m=/^\/drive\/folder\/([a-zA-Z0-9]+)$/.exec(u.pathname);if(!m)throw new Error('需要云盘文件夹链接');c.driveInbox.folderToken=m[1];
 }else{
 const m=/^\/(sheets|wiki)\/([a-zA-Z0-9]+)$/.exec(u.pathname);if(!m||!u.searchParams.get('sheet'))throw new Error('需要包含 sheet 参数的电子表格链接');
 let token=m[2];if(m[1]==='wiki'){const r=await require('../src/feishu').getClient().wiki.v2.space.getNode({params:{token}});if(r.code!==0||r.data?.node?.obj_type!=='sheet')throw new Error('无法解析电子表格节点');token=r.data.node.obj_token;}
 Object.assign(c.scheduleSync,{spreadsheetToken:token,sheetId:u.searchParams.get('sheet')});
 }
 }
 put(c,input.key,u.href);message=field[3]+'。关联的表格或文件夹标识已同步更新；请确认新目标内容与字段匹配。';
 }else throw new Error('不支持的操作');
 if(fs.readFileSync(CONFIG,'utf8')!==before)throw new Error('保存期间配置发生变化，请刷新后重试');
 const dir=path.join(ROOT,'backups','admin');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const backup=Date.now()+'-'+crypto.randomBytes(4).toString('hex')+'.json';fs.writeFileSync(path.join(dir,backup),before,{mode:0o600});
 const tmp=CONFIG+'.admin.tmp';fs.writeFileSync(tmp,JSON.stringify(c,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,CONFIG);
 audit({kind:input.kind,key:input.key||input.openId,backup});return {message};
 }finally{busy=false;}
}
function state(){
 const raw=fs.readFileSync(CONFIG,'utf8'),c=JSON.parse(raw);let running=false,pid=null,started='';
 // 判活三条路，任一条成立即算在跑（2026-11-02 修：原实现只靠 ps，ps 被系统拒绝时一律显示“未运行”）
 // 1) pid 存活：kill(pid,0)，EPERM 说明进程在、只是没权限发信号
 // 2) 机器人每 2 秒写 admin-runtime.json，12 秒内有心跳且 pid 对得上
 // 3) 能读到 ps 命令行时再核一次真实身份（防止 pid 被别的进程复用）
 try{
  pid=Number(fs.readFileSync(path.join(ROOT,'bot.pid'),'utf8'));
  if(!Number.isInteger(pid)||pid<2)throw Error();
  try{process.kill(pid,0);running=true;}catch(e){running=e&&e.code==='EPERM';}
  if(!running){try{const rt=JSON.parse(fs.readFileSync(path.join(ROOT,'admin-runtime.json'),'utf8'));if(Number(rt.pid)===pid&&Date.now()-Number(rt.at||0)<12000)running=true;}catch{}}
  if(running){try{
    const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    if(command)running=/src[\/\\]index\.js/.test(command);
    if(running)started=execFileSync('/bin/ps',['-p',String(pid),'-o','etime='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  }catch{}}
 }catch{running=false;pid=null;}
 const log=path.join(ROOT,'logs/bot.log');let report=null;const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());try{report=JSON.parse(fs.readFileSync(path.join(ROOT,'logs',`selftest-${date}.json`),'utf8'));}catch{}
 return {revision:revision(raw),people:people(c),directory:directory.read(),features:FEATURES,policy:c.notificationPolicy||{},operations:operations.state(),fields:fields.map(([key,label,type,effect])=>({key,label,type,effect,value:get(c,key)})),status:{running,pid:running?pid:null,uptime:started,lastLog:fs.existsSync(log)?fs.statSync(log).mtime.toISOString():null,selftest:report?{ok:report.ok,skipped:report.skipped}:null},audit:tail(path.join(ROOT,'logs/admin-audit.jsonl')).trim().split('\n').filter(Boolean).slice(-30).reverse()};
}
const server=http.createServer(async(req,res)=>{
 const host=`127.0.0.1:${PORT}`;res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
 const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 if(req.headers.host!==host){send(403,{error:'仅支持本机访问'});return;}
 const url=new URL(req.url,'http://'+host);
 if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'index.html'),'utf8').replace('__TOKEN__',TOKEN));return;}
 if(req.headers['x-admin-token']!==TOKEN || (req.headers.origin&&req.headers.origin!=='http://'+host)){send(403,{error:'请从本机管理台打开'});return;}
 try{
 if(req.method==='GET'&&url.pathname==='/api/state')return send(200,state());
 if(req.method==='GET'&&url.pathname==='/api/logs'){
 const name=url.searchParams.get('file')||'bot.log';if(!['bot.log','bsk.log','restart.log','admin-audit.jsonl'].includes(name))throw Error('未知日志');
 let lines=redact(tail(path.join(ROOT,'logs',name))).split('\n');const q=url.searchParams.get('q')||'';
 if(q)lines=lines.filter(l=>l.toLowerCase().includes(q.toLowerCase()));if(url.searchParams.get('errors')==='1')lines=lines.filter(l=>/error|失败|错误|超时|refused|✗/i.test(l));return send(200,{text:lines.slice(-600).join('\n')});
 }
 if(req.method==='POST'&&url.pathname==='/api/directory'){return send(200,{directory:await directory.sync()});}
 if(req.method==='POST'&&url.pathname==='/api/action'){let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('请求过大');}const c=JSON.parse(body);const message=await operations.action(c);audit({kind:'operation',key:c.action});return send(200,{message});}
 if(req.method==='POST'&&url.pathname==='/api/config'){
 let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('请求过大');}return send(200,await patch(JSON.parse(body)));
 }
 send(404,{error:'不存在的接口'});
 }catch(e){send(400,{error:redact(e.message)});}
});
if(require.main===module)server.listen(PORT,'127.0.0.1',()=>console.log(`管理台：http://127.0.0.1:${PORT}`));
module.exports={patch,state,fields,server};
