'use strict';
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const local = new AsyncLocalStorage();
const configPath = path.join(__dirname, '../config.json');
function raw() { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
function projects() {
  const c = raw();
  return [{ key: 'legacy', name: '《逆天萌兽2》', base: c.base, projectUrl: c.legacyProjectUrl || c.projectUrl, trimPreviewUrl: c.legacyTrimPreviewUrl, enabled: true }, ...(c.sceneProjects || []).filter(p => p.enabled).map(p => ({...p, base: {...c.base, ...p.base}}))];
}
function current() { return local.getStore() || projects()[0]; }
function run(key, fn) {
  const p = projects().find(p => p.key === key);
  if (!p) throw new Error('项目未启用或不存在：' + key);
  if (!p.base?.appToken || !p.base?.tableId) throw new Error('项目表格配置不完整');
  return local.run(p, fn);
}
const routes = new Map();
function register(rec) {
  const old = routes.get(rec.recordId);
  if (old && old !== current().key) throw new Error('跨项目记录ID冲突：' + rec.recordId);
  routes.set(rec.recordId, current().key); return rec;
}
async function forRecord(id, fn, discover) {
  if (!routes.has(id)) await discover();
  const key = routes.get(id);
  if (!key) throw new Error('记录不属于已启用项目：' + id);
  return run(key, fn);
}
const base = new Proxy({}, { get: (_, k) => current().base?.[k], ownKeys: () => Object.keys(current().base || {}), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
function projectForTarget(url, explicitKey) {
  if (explicitKey) {
    const selected = projects().find(p => p.key === explicitKey);
    const legacy = projects().find(p => p.key === "legacy");
    const parse = require("./target").parseTarget;
    if (!selected) throw new Error("所选项目与上传目录不匹配");
    const pid = (u) => { try { return parse(u).projectId; } catch (e) { return ""; } };
    const got = pid(url);
    // 2026-11-10 修：原来硬校验「必须等于 legacy（第二季）项目 id」——
    // 那是第三季分秒帧链接还没给、上传目录沿用第二季时的临时约束，
    // 第三季自己的粗剪链接一绑上就会误报「所选项目与上传目录不匹配」。
    // 现在按本项目自己绑的目录判断：粗剪 / 精剪 / 共用上传目录都算，
    // 同时保留 legacy 目录（第三季链接没给前的历史目录 + /upmedia 逆天萌兽3 过渡写法）。
    const allowed = [selected.projectUrl, selected.trimPreviewUrl, selected.sharedUploadUrl, legacy && legacy.projectUrl]
      .map(pid).filter(Boolean);
    if (!got || !allowed.includes(got)) throw new Error("所选项目与上传目录不匹配");
    const kind = selected.trimPreviewUrl && url === selected.trimPreviewUrl ? "fine" : "rough";
    return { ...selected, uploadKind: kind };
  }
  const hits = projects().flatMap(p => [
    ...(p.projectUrl === url ? [{...p, uploadKind: 'rough'}] : []),
    ...(p.trimPreviewUrl === url ? [{...p, uploadKind: 'fine'}] : [])
  ]);
  if (hits.length !== 1) throw new Error('上传目录未绑定唯一制作项目，请先配置目录与项目映射');
  return hits[0];
}
module.exports = { projects, current, run, register, forRecord, base, projectForTarget };
