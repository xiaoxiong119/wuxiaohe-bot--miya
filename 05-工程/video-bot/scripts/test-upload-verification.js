const assert=require('node:assert/strict');
const {load}=require('./test-helpers');
const url='https://app.mediatrack.cn/projects/123/files';
async function run(afterVersion){
  let uploaded=false,versionReads=0;
  const media=load('src/mediatrack.js',{
    './target':{getTarget:()=>({projectUrl:url})},'./log':{log(){}},
    child_process:{execFileSync:(_bin,args)=>{
      if(args[0]==='session')return args[1]==='start'?'{"session_id":"fixture"}':'';
      if(args[0]==='upload'){uploaded=true;return '';}
      if(args[0]!=='evaluate')return '';
      const js=args.at(-1);
      if(js==='location.href')return url;
      if(js.includes('const alts = cards'))return JSON.stringify({st:'OK',alts:['71.mp4']});
      if(js.includes('const want =')){versionReads++;return JSON.stringify({'71.mp4':String(uploaded?afterVersion:2)})}
      if(js.includes('hasPanel:'))return '{"hasPanel":true,"done":true,"hasError":false}';
      if(js.includes("return m ? m[1] : '0'"))return '5';
      return 'OK';
    }},
  },{setTimeout:fn=>setImmediate(fn)});
  const result=await media.uploadToMediatrack('/fixture/71.mp4');
  assert.ok(versionReads>=2);
  return result;
}
(async()=>{
  assert.equal((await run(2)).ok,false,'旧版本仍在不能当作本次更新成功');
  const done=await run(3);assert.equal(done.ok,true);assert.equal(done.version,'v3');
  console.log('PASS: 上传版本必须确实增加，旧版本号不再造成成功误报');
})().catch(e=>{console.error(e);process.exitCode=1});
