'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {writeJson} = require('./json-file');
function createStore(root) {
  const file = path.join(root, 'pending-uploads.json');
  function list() { try { const rows=JSON.parse(fs.readFileSync(file,'utf8')); if(!Array.isArray(rows))throw Error('上传确认台账格式错误'); return rows; } catch(e) {if(e.code==='ENOENT')return [];throw e;} }
  const active = r => ['submitting','pending','verified'].includes(r.status);
  function save(rows) {writeJson(file,rows);}
  function begin(job, localPath) {
    const id = job.confirmationId || randomUUID();
    const rows=list();
    const entry = {id,at:Date.now(),status:'submitting',name:job.outName,localPath,job:{att:job.att,outName:job.outName,projectKey:job.projectKey,uploadTarget:job.uploadTarget,by:job.by,notifyOpenId:job.notifyOpenId,chatId:job.chatId,cmdName:job.cmdName,localPath:job.localPath,inboxItem:job.inboxItem,taskBinding:job.taskBinding,driveSourceToken:job.driveSourceToken}};
    const existing=rows.find(r=>r.id===id);
    if(existing) Object.assign(existing,entry); else rows.push(entry);
    save(rows); job.confirmationId=id; return id;
  }
  function set(id,status,detail) {const rows=list(),r=rows.find(r=>r.id===id);if(!r)throw Error('上传确认记录不存在');r.status=status;r.updatedAt=Date.now();r.detail=String(detail||'').slice(0,1000);save(rows);return r;}
  function blocks(job) {const token=job.driveSourceToken||job.att?.driveToken;return list().some(r=>active(r)&&((token&&(r.job.driveSourceToken===token||r.job.att?.driveToken===token))||(job.localPath&&r.job.localPath===job.localPath)||(job.att?.messageId&&r.job.att?.messageId===job.att.messageId&&r.job.outName===job.outName&&JSON.stringify(r.job.uploadTarget)===JSON.stringify(job.uploadTarget))));}
  function blocksDrive(token) {return list().some(r=>active(r)&&(r.job.driveSourceToken===token||r.job.att?.driveToken===token));}
  return {list:()=>list().filter(active),all:list,begin,set,blocks,blocksDrive};
}
module.exports={createStore};
