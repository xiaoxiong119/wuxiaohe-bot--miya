'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {load}=require('./test-helpers');
function fixtures() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wuxiaohe-fixture-'));
 const url='https://app.mediatrack.cn/projects/123/files?path=456';
 const config={base:{appToken:'fixture-base',tableId:'fixture-legacy'},projectUrl:url,legacyTrimPreviewUrl:url,sceneProjects:[{key:'nts3',name:'《逆天萌兽3》',sceneMode:true,notesField:'修改位置',enabled:true,projectUrl:url,trimPreviewUrl:url,base:{appToken:'fixture-base',tableId:'fixture-scene'}}]};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
 const pc=load('src/project-context.js',{'fs':{readFileSync:()=>JSON.stringify(config)}});
 process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,config,pc};
}
module.exports={fixtures};
