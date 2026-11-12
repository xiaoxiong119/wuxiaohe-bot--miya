const fs=require('node:fs'),path=require('node:path');
const ROOT=process.env.ADMIN_TEST_ROOT||path.resolve(__dirname,'..');
const FILE=path.join(ROOT,'admin-directory.json');
const {withTimeout}=require('../src/feishu');
function read(){try{return JSON.parse(fs.readFileSync(FILE,'utf8'))}catch{return {people:[],departments:[],complete:false,warning:'尚未同步公司通讯录'}}}
function persist(d){fs.writeFileSync(FILE+'.tmp',JSON.stringify(d,null,2),{mode:0o600});fs.renameSync(FILE+'.tmp',FILE);return d;}
function check(r){if(r.code!==0)throw Error(`飞书 ${r.code}：${r.msg}`);return r.data||{};}
async function pages(call){let token;const out=[];const seen=new Set();do{const d=check(await withTimeout(call(token),15000,'读通讯录'));out.push(...d.items||[]);if(!d.has_more)break;if(!d.page_token||seen.has(d.page_token))throw Error('通讯录分页异常，未标记完整');token=d.page_token;seen.add(token);}while(true);return out;}
async function sync(){
 const client=require('../src/feishu').getClient();const old=read();const byId=new Map(old.people.map(p=>[p.openId,p]));let businessWarning='';
 try{const records=await require('../src/flow').fetchAllRecords();for(const r of records)for(const role of ['artist','reviewers','editors'])for(const p of r[role]||[])if(p.id?.startsWith('ou_')){const prev=byId.get(p.id)||{};byId.set(p.id,{...prev,name:p.name,openId:p.id,source:'正式任务表',roles:[...new Set([...(prev.roles||[]),{artist:'制作师',reviewers:'审片人',editors:'剪辑师'}[role]])]});}}catch(e){businessWarning='业务人员补齐失败：'+e.message;}
 const d={people:[...byId.values()],departments:old.departments||[],complete:false,at:new Date().toISOString(),warning:businessWarning};
 try{
 const departments=await pages(token=>client.contact.v3.department.children({path:{department_id:'0'},params:{department_id_type:'open_department_id',user_id_type:'open_id',fetch_child:true,page_size:50,page_token:token}}));
 if(departments.some(p=>!p.name))throw Error('缺少读取部门名称的权限，部门归类未完成');
 const members=new Map();const all=[{open_department_id:'0',name:'公司直属',parent_department_id:''},...departments];
 for(const dep of all){const list=await pages(token=>client.contact.v3.user.findByDepartment({params:{department_id:dep.open_department_id,department_id_type:'open_department_id',user_id_type:'open_id',page_size:50,page_token:token}}));for(const p of list){if(!p.open_id||!p.name)throw Error('成员缺少 open_id 或姓名，请核对基本信息读取权限');const prev=members.get(p.open_id)||{};members.set(p.open_id,{name:p.name||p.open_id,openId:p.open_id,departmentIds:[...new Set([...(prev.departmentIds||[]),dep.open_department_id,...(p.department_ids||[])])],source:'飞书组织通讯录',roles:byId.get(p.open_id)?.roles||[]});}}
 d.departments=all.map(p=>({id:p.open_department_id,name:p.name||p.open_department_id,parentId:p.parent_department_id}));
 d.people=[...members.values(),...[...byId.values()].filter(p=>!members.has(p.openId)).map(p=>({...p,departmentIds:[]}))];d.complete=!businessWarning;d.orgAt=d.at;
 }catch(e){const detail=e.response?.data;const message=detail?.code===99991672?'缺少通讯录读取权限，请在飞书后台开通并将数据范围设为全部成员':detail?.msg||e.message;d.warning=[businessWarning,'组织通讯录未完整同步：'+message].filter(Boolean).join('；');}
 return persist(d);
}
module.exports={read,sync,pages};
