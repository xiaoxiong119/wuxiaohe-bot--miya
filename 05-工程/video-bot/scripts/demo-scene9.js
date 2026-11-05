'use strict';
// 只发送静态示例；按钮全部替换为无业务动作，绝不读写多维表格。
const C=require('../src/cards'),{getClient}=require('../src/feishu');
const recipient='[已脱敏]';
const base={project:'【模拟演示】《逆天萌兽3》',episode:'9',projectKey:'nts3',sceneMode:true,reviewers:[{name:'陈俊杰（示例审片人）'}],editors:[{name:'模拟剪辑师'}],progress:'进行中',trimStage:'待开始',review:'未审阅',stage:'生成中'};
const one={...base,recordId:'DEMO_SCENE_9_1',scene:'1',artist:[{name:'模拟制作师甲'}]};
const two={...base,recordId:'DEMO_SCENE_9_2',scene:'2',artist:[{name:'模拟制作师乙'}]};
const snapshot=(title,lines)=>C.settledCard('【模拟演示】'+title,lines,'blue');
const cards=[
 snapshot('第9集两场 · 演示说明',[
 '所有卡片仅发送给陈俊杰。这是一组按顺序展示的静态示例，未上传真实视频、未修改真实表格、未通知实际制作师。',
 '9-1 → 模拟制作师甲；9-2 → 模拟制作师乙。每场独立记录、独立审阅。',
 '示例按钮仅展示外观，点击不执行业务。后续结果由下一张示例卡展示。']),
 snapshot('① 甲上传 9-1.mp4 后的表格',[
 '**9-1｜模拟制作师甲**：素材生成进展=已粗剪待一审；审阅反馈=未审阅；剪辑进度=待开始。',
 '**9-2｜模拟制作师乙**：素材生成进展=生成中；审阅反馈=未审阅；剪辑进度=待开始。',
 '乌小河只回写9-1，随后向审片人发送下一张一审卡。']),
 C.reviewCard({...one,stage:'已粗剪待一审'}),
 snapshot('② 乙上传 9-2.mp4 后的表格',[
 '**9-1**：仍是已粗剪待一审／未审阅。',
 '**9-2**：从生成中变为已粗剪待一审／未审阅。',
 '两场都待审，互不覆盖。随后发送9-2的一审卡。']),
 C.reviewCard({...two,stage:'已粗剪待一审'}),
 snapshot('③ 审片人通过9-1、退回9-2',[
 '**9-1**：审阅反馈=通过；剪辑进度=可剪辑；素材生成进展仍为已粗剪待一审，等待制作师上传素材。',
 '**9-2**：审阅反馈=有修改；素材生成进展=修改中；修改位置=对白音量太小，请调整后重新提交。',
 '接下来分别展示给甲的素材上传卡和给乙的修改卡。演示仍全部只发给陈俊杰。']),
 C.uploadCard({...one,stage:'已粗剪待一审',review:'通过',trimStage:'可剪辑'}),
 C.editCard({...two,stage:'修改中',review:'有修改'},'对白音量太小，请调整后重新提交。'),
 snapshot('④ 甲完成素材上传，乙重传修改版',[
 '**9-1**：甲确认素材已上传 → 素材生成进展=已完成并上传；审阅反馈=通过；剪辑进度=可剪辑。乌小河发9-1开始精剪卡。',
 '**9-2**：乙上传9-2-修改版.mp4 → 只回写9-2为已粗剪待一审／未审阅，重新发9-2一审卡。',
 '**9-1已通过的状态保持不变。** 当前实现支持各场独立进入剪辑；这里不表示第9集整集终审通过。']),
 C.trimCard({...one,stage:'已完成并上传',review:'通过',trimStage:'可剪辑'}),
 C.reviewCard({...two,stage:'已粗剪待一审',review:'未审阅'}),
 snapshot('⑤ 9-2复审通过并上传素材后',[
 '**9-1｜甲**：已完成并上传／通过／可剪辑。',
 '**9-2｜乙**：已完成并上传／通过／可剪辑。',
 '9-2复审通过后先给乙素材上传卡；乙确认素材上传后，才向剪辑师发下一张9-2精剪卡。',
 '两场后续仍分别更新“剪辑中→待审片→已定剪”；某场操作不会改另一场。',
 '**批注表保持第9集一行**，各场意见汇总在该行需求简述中，不新增场次行。']),
 C.trimCard({...two,stage:'已完成并上传',review:'通过',trimStage:'可剪辑'})
];
function safe(node){
 if(!node||typeof node!=='object')return;
 if(node.tag==='button'){
   delete node.url;delete node.multi_url;delete node.confirm;
   if(node.behaviors)node.behaviors=[{type:'callback',value:{a:'demo_only'}}];
   else node.value={a:'demo_only'};
 }
 for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(safe);else if(value&&typeof value==='object')safe(value);}
}
(async()=>{
 let count=0;
 for(const card of cards){
  safe(card);
  const elements=card.body?.elements||card.elements;
  elements.unshift(card.schema==='2.0'?{tag:'markdown',content:'🧪 静态演示｜仅陈俊杰收取｜不操作真实表格'}:{tag:'div',text:{tag:'lark_md',content:'🧪 **静态演示｜仅陈俊杰收取｜不操作真实表格**'}});
  const result=await getClient().im.v1.message.create({params:{receive_id_type:'open_id'},data:{receive_id:recipient,msg_type:'interactive',content:JSON.stringify(card)}});
  if(result.code)throw Error(`第${count+1}张发送失败：${result.msg}`);
  count++;console.log('已发送示例卡 '+count+'/'+cards.length);
  await new Promise(r=>setTimeout(r,200));
 }
 console.log('完成：'+count+'张，唯一收件人为陈俊杰。');
})().catch(e=>{console.error(e.message);process.exitCode=1});
