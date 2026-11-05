const {AsyncLocalStorage}=require('node:async_hooks');
const context=new AsyncLocalStorage();
const FEATURES={review:'一审通知',revision:'修改与素材通知',editing:'精剪通知',finalReview:'终审通知',health:'体检通知',receipt:'上传与系统回执'};
function quietAt(q,now=new Date()){
 if(!q?.enabled)return false;const h=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);const n=h=>Number(h.slice(0,2))*60+Number(h.slice(3));const t=n(h),a=n(q.start),b=n(q.end);return a===b|| (a<b?t>=a&&t<b:t>=a||t<b);
}
function reason(config,id,feature,now){
 const excluded=(config.privateNotificationOptOut||[]).find(p=>p.openId===id);if(excluded)return '已按免通知设置跳过 '+excluded.name+' 的私聊消息/卡片';
 const policy=config.notificationPolicy||{};if(quietAt(policy.quiet,now))return '当前为免打扰时段（不补发）';
 const rule=policy.features?.[feature];if(rule?.enabled===false)return FEATURES[feature]+'已关闭';if(rule?.mode==='selected'&&!(rule.openIds||[]).includes(id))return '该人员未获此功能通知许可';return '';
}
function featureForLabel(label){return /^一审/.test(label)?'review':/终审|成片/.test(label)?'finalReview':/精剪|剪辑/.test(label)?'editing':'revision';}
module.exports={FEATURES,reason,quietAt,context,featureForLabel};
