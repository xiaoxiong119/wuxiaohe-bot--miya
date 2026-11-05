'use strict';
function key(f){const e=Number(f?.['集数']),s=Number(f?.['场次']);return Number.isInteger(e)&&e>0&&Number.isInteger(s)&&s>0?`${e}:${s}`:null;}
function plan(items,records,projectName){
 const seen=new Set(),wanted=new Set(),create=[];
 for(const r of records){if(r.fields?.['集数']==null)continue;const k=key(r.fields);if(!k)throw Error('积分统计存在已填集数但缺少有效场次的记录，请先补齐场次');if(seen.has(k))throw Error('积分统计集数＋场次重复：'+k);seen.add(k);}
 for(const i of items){const k=key(i.fields);if(!k||wanted.has(k))throw Error('同步源场次无效或重复');wanted.add(k);if(!seen.has(k))create.push({fields:{集数:Number(i.fields['集数']),场次:Number(i.fields['场次']),...(projectName?{'《项目名》':projectName}:{})}});}
 return{create,unchanged:wanted.size-create.length};
}
async function prepare(client,target,items,listAll,projectName){const fields=await listAll(a=>client.bitable.v1.appTableField.list(a),target);for(const n of ['集数','场次'])if(!fields.some(f=>f.field_name===n&&f.type===2))throw Error('积分统计需要数字字段：'+n+'；本次未写表');if(projectName&&!fields.some(f=>f.field_name==='《项目名》'&&f.type===1))throw Error('积分统计需要文本字段：《项目名》；本次未写表');return{target,...plan(items,await listAll(a=>client.bitable.v1.appTableRecord.list(a),target),projectName)};}
async function apply(client,p,items,listAll,check,timeout){for(let i=0;i<p.create.length;i+=100){const batch=p.create.slice(i,i+100);const d=check(await timeout(client.bitable.v1.appTableRecord.batchCreate({path:p.target,data:{records:batch}}),30000,'补齐积分行'));if(d.records?.length!==batch.length)throw Error('积分写入回执不完整，请预览后重试');}const actual=await listAll(a=>client.bitable.v1.appTableRecord.list(a),p.target);if(plan(items,actual).create.length)throw Error('积分统计回读不一致');const byKey=new Map(actual.map(r=>[key(r.fields),r.fields]));for(const row of p.create){const expected=row.fields['《项目名》'];if(!expected)continue;const value=byKey.get(key(row.fields))?.['《项目名》'];const name=Array.isArray(value)?value.map(v=>v.text||'').join(''):value;if(name!==expected)throw Error('积分统计项目名称回读不一致：'+key(row.fields));}}
module.exports={plan,prepare,apply};
