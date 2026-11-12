'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { writeJson } = require('./json-file');

// 一个业务事件有独立的逐人记录；重试仅发送卡片，不重做业务变更。
function createOutbox(file, deps) {
  let events;
  const inflight = new Set();
  function read() {
    if (!events) {
      try { events = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; events = []; }
      if (!Array.isArray(events)) throw Error('通知台账格式错误，暂停发送以免重复');
    }
    return events;
  }
  function save() { writeJson(file, read()); }
  async function deliver(event, force = false) {
    if (inflight.has(event.id)) return {sent:0, complete:false};
    inflight.add(event.id);
    let sent = 0;
    try {
      let valid;
      try { valid = await deps.valid(event); } catch (e) {
        for(const r of event.recipients) if(!['sent','skipped','stale'].includes(r.status)){r.status='pending';r.error='等待核对当前业务状态：'+e.message;r.nextAt=Date.now()+30000;}
        save(); return {sent:0,complete:false,deliveredIds:event.recipients.filter(r=>r.status==='sent').map(r=>r.id)};
      }
      if (!valid) {
        for (const r of event.recipients) if (!['sent','skipped'].includes(r.status)) r.status = 'stale';
        save(); return {sent:0, complete:true};
      }
      for (const r of event.recipients) {
        if (['sent','skipped','stale'].includes(r.status)) continue;
        const reason = deps.block(r.id, event);
        if (reason) {
          r.status = /免打扰/.test(reason) ? 'skipped' : 'paused'; r.error = reason; save(); continue;
        }
        if (!force && (r.nextAt || 0) > Date.now()) continue;
        r.status = 'sending'; r.attempts = (r.attempts || 0) + 1; save();
        try {
          if (!(await deps.send(r.id, event.card, r.uuid, event))) throw Error('接口未返回成功');
          r.status = 'sent'; r.sentAt = Date.now(); r.error = ''; sent++;
        } catch (e) {
          r.status = 'pending'; r.error = String(e.message || e).slice(0,500);
          r.nextAt = Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(r.attempts, 9));
        }
        save();
      }
      return {sent, deliveredIds:event.recipients.filter(r=>r.status==='sent').map(r=>r.id), complete:event.recipients.every(r => ['sent','skipped','stale'].includes(r.status))};
    } finally { inflight.delete(event.id); }
  }
  async function enqueue({key, family, people, card, label, binding}) {
    let event = read().find(e => e.key === key);
    if (!event) {
      if (family) for (const old of read().filter(e => e.family === family)) for (const r of old.recipients) if (!['sent','skipped'].includes(r.status)) r.status = 'stale';
      event = {id:randomUUID(), key, family, label, binding, card, at:Date.now(), recipients:[...new Set(people.map(p=>p.id).filter(Boolean))].map(id=>({id, uuid:randomUUID(), status:'pending', attempts:0}))};
      read().push(event); save();
    }
    return deliver(event);
  }
  async function drain(id) {
    for (const e of read()) {
      if (id && e.id !== id) continue;
      if (e.recipients.some(r=>['pending','sending','paused'].includes(r.status))) {
        try { await deliver(e, !!id); } catch (err) { deps.log?.(err.message); }
      }
    }
  }
  function retry(id) { if (!read().some(e=>e.id===id)) throw Error('通知记录不存在'); return drain(id); }
  return {enqueue, drain, retry, list:()=>JSON.parse(JSON.stringify(read()))};
}
module.exports = {createOutbox};
