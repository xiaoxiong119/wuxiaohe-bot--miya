const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {acquire,release}=require('../src/lock');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bot-lock-'));
const lockModule=require.resolve('../src/lock');
(async()=>{try{
  fs.mkdirSync(path.join(root,'src'));
  const script=path.join(root,'src/index.js');
  fs.writeFileSync(script,`const fs=require('node:fs'),path=require('node:path');const root=process.argv[2];
const lock=require(${JSON.stringify(lockModule)});fs.writeFileSync(path.join(root,'ready-'+process.pid),'1');
const poll=setInterval(()=>{if(!fs.existsSync(path.join(root,'gate')))return;clearInterval(poll);
const result=lock.acquire(root);console.log(JSON.stringify(result));if(result.ok)setTimeout(()=>{lock.release(root)},500);},5);`);
  for (const stale of [false,true]) {
    for(const name of fs.readdirSync(root).filter(x=>x==='gate'||x.startsWith('ready-')))fs.unlinkSync(path.join(root,name));
    if(stale)fs.writeFileSync(path.join(root,'.bot.lock'),JSON.stringify({pid:99999999}));
    const results=Array.from({length:8},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,root]);let out='';child.stdout.on('data',d=>out+=d);child.on('error',reject);child.on('close',code=>{if(code)reject(new Error(out));else resolve(JSON.parse(out.trim().split('\n').at(-1)))})}));
  const deadline=Date.now()+10000;
  while(fs.readdirSync(root).filter(f=>f.startsWith('ready-')).length<8){if(Date.now()>deadline)throw Error('测试子进程准备超时');await new Promise(r=>setTimeout(r,10))}
  fs.writeFileSync(path.join(root,'gate'),'1');const done=await Promise.all(results);
  assert.equal(done.filter(x=>x.ok).length,1,'同时启动只能有一个实例取得锁');
  }
  fs.writeFileSync(path.join(root,'.bot.lock'),JSON.stringify({pid:99999999}));assert.equal(acquire(root).ok,true);release(root);
  fs.writeFileSync(path.join(root,'.bot.lock'),'');assert.equal(acquire(root).ok,false,'刚创建尚未写入的锁不能抢占');
  fs.unlinkSync(path.join(root,'.bot.lock'));fs.mkdirSync(path.join(root,'.bot.lock'));
  assert.equal(acquire(root).ok,false,'无法建立锁时不能继续启动');
  console.log('PASS: 八进程同时抢锁、陈旧锁接管、新建空锁保护、锁写入失败拒绝启动');
}finally{fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
