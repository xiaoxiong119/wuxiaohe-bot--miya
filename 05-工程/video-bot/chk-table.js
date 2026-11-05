const { getClient } = require('~/WorkBuddy/乌小河机器人/05-工程/video-bot/src/feishu');
(async () => {
  const c = getClient();
  const appToken = 'OL3WbEqoYaS6NbsV2Z4cLwDInOc';
  const tableId = 'tbl4vFgW19bZgl41';
  const f = await c.bitable.v1.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 100 } });
  const items = (f.data || f).items || [];
  console.log('字段：', items.map(x => `${x.field_name}(${x.type})`).join(' | '));
  let token = ''; const rows = [];
  for (let i = 0; i < 20; i++) {
    const r = await c.bitable.v1.appTableRecord.search({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 500, page_token: token || undefined }, data: {} });
    const d = r.data || r; rows.push(...(d.items || []));
    if (!d.has_more) break; token = d.page_token || ''; if (!token) break;
  }
  console.log('行数：', rows.length);
  const eps = rows.map(r => Number(r.fields?.['集数'])).filter(Boolean).sort((a,b)=>a-b);
  console.log('已有集数：', eps.join(','));
  console.log('样例：', JSON.stringify(rows.slice(0,2), null, 1).slice(0, 1200));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
