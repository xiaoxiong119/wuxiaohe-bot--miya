const assert = require('node:assert/strict');
const { parseSource, plan, date } = require('../src/schedulesync');
const columns = ['A', 'B', 'C', 'D', 'E'];
const cell = (value, bg) => ({ value, cell_styles: { background_color: bg } });
const data = { revision: 1, has_more: false, ranges: [{ truncated: false, actual_range: 'A2:E5', col_indices: columns,
  row_indices: [2, 3, 4, 5], cells: [
    [cell('场景事件'), cell('集数/制作人员'), cell(''), cell('调整修改/围读'), cell('')],
    [cell(''), cell('集数'), cell('10月15日'), cell('10月16日'), cell('10月19日')],
    [cell('庭院'), cell('第23集-1'), cell('', '#8ee085'), cell('', '#fbbfbc'), cell('')],
    [cell(''), cell('第23集-2'), cell(''), cell('', '#fbbfbc'), cell('昕', '#ad82f7')],
  ] }] };
const conf = { year: 2026, people: { '#8ee085': { id: 'p1', name: '测试制作师甲' }, '#ad82f7': { id: 'p2', name: '测试制作师乙' }, '#fbbfbc': { id: 'p3', name: '测试制作师丙' } }, ignoredColors: ['#ffffff'], sceneAliases: {}, verifiedScenes: {} };
const layout = { merged_cells: [{ range: 'A4:A5' }] };
const result = parseSource(data, layout, conf);
assert.equal(result.items.length, 2);
assert.equal(result.items[0].fields['开始日期'], Date.parse('2026-10-15T00:00:00+08:00'));
assert.equal(result.items[1].fields['预计完成日期'], Date.parse('2026-10-19T00:00:00+08:00'));
assert.deepEqual(result.items.map(i => i.fields['制作师']), [[{ id: 'p1' }], [{ id: 'p2' }]]);
assert.deepEqual(result.items[1].fields['场景'], ['庭院']);
assert.equal(result.items[1].fields['排期分段'], '第23集-2');
const records = result.items.map((i, n) => ({ record_id: 'r' + n, fields: { ...i.fields, '审阅反馈': '通过', '进展': '已完成' } }));
records.forEach(r => { r.fields['集数'] = String(r.fields['集数']); });
assert.deepEqual(plan(result.items, records), { create: [], update: [], unchanged: 2, remove: [] });
records[1].fields['制作师'] = [{ id: 'wrong' }];
assert.deepEqual(plan(result.items, records).update, [{ record_id: 'r1', fields: { '制作师': [{ id: 'p2' }] } }]);
assert.throws(() => plan(result.items, [records[0], records[0]]), /分段重复/);
assert.throws(() => plan(result.items, [{ record_id: 'old', fields: { '集数': 23 } }]), /不能安全匹配/);
assert.throws(() => parseSource({ ...data, has_more: true }, layout, conf), /读取不完整/);
const unknown = JSON.parse(JSON.stringify(data)); unknown.ranges[0].cells[2][2].cell_styles.background_color = '#123456';
assert.throws(() => parseSource(unknown, layout, conf), /未配置人员/);
const missing = parseSource(data, { merged_cells: [] }, conf);
assert.equal(missing.warnings.length, 1);
assert.equal(missing.items[1].fields['场景'], undefined);
assert.throws(() => date('2月30日', 2026), /无效排期日期/);
assert.throws(() => date('未知', 2026), /无法确定日期/);
console.log('PASS：颜色、特殊日排除、分段、真实合并场景、上海日期、重复同步、最小更新与异常拦截');
const { missingOptions, ensureOptions } = require('../src/schedulesync');
const optionFields = [{ field_id: 'f', field_name: '场景', type: 4, property: { options: [{ id: 'o', name: '庭院', color: 2 }] } }, { field_name: '状态', type: 3, property: { options: [] } }];
const optionItems = [{ fields: { 场景: ['庭院', '新场景', '新场景'], 状态: '待开始' } }];
assert.deepEqual(missingOptions(optionItems, optionFields).map(e => e.names), [['新场景'], ['待开始']]);
(async () => {
  let current = JSON.parse(JSON.stringify(optionFields)), writes = 0;
  const client = { bitable: { v1: { appTableField: {
    list: async () => ({ code: 0, data: { items: current } }),
    update: async ({path, data}) => { writes++; const field = current.find(f => f.field_id === path.field_id); Object.assign(field, data); return { code: 0 }; },
  } } } };
  await assert.rejects(ensureOptions(client, {}, [{fields:{场景:['新场景']}}]), /单独配置选项/);
  await ensureOptions(client, {}, [{fields:{场景:['庭院']}}]);
  assert.equal(writes, 0);
  console.log('PASS：日常同步不修改表结构或选项');
})().catch(e => { console.error(e); process.exitCode = 1; });

const legacy = result.items.map((item, n) => ({record_id:'legacy'+n, fields:{集数:String(item.fields['集数']),场次:String(item.fields['场次'])}}));
assert.equal(plan(result.items, legacy).create.length, 0);
assert.equal(plan(result.items, legacy).update.length, 2);
assert.throws(() => plan(result.items, [...legacy, legacy[0]]), /集数与场次重复/);
assert.deepEqual(result.items.map(i => i.fields['场次']), [1,2]);
console.log('PASS：集数与场次安全匹配、重复拦截、分段场次');

const defaultPlan = plan(result.items, result.items.map((item,n)=>({record_id:'d'+n,fields:{...item.fields,进展:n?'已完成':''}})), {进展:'待开始'});
assert.deepEqual(defaultPlan.update, []);
assert.equal(defaultPlan.unchanged,2);
assert.equal(plan(result.items, [], {进展:'待开始'}).create[0].fields.进展,'待开始');
console.log('PASS：旧记录不写业务状态、新增携带默认值');

const points = require('../src/points-sync');
const pointsItems = [{fields:{集数:9,场次:1}}, {fields:{集数:9,场次:2}}, {fields:{集数:10,场次:1}}];
const existingPoints = [{fields:{集数:'9',场次:1,单集制作积分:50,'《项目名》':'既有项目'}}];
const pointsPlan = points.plan(pointsItems, existingPoints, '《逆天萌兽3》');
assert.deepEqual(pointsPlan.create, [
  {fields:{集数:9,场次:2,'《项目名》':'《逆天萌兽3》'}},
  {fields:{集数:10,场次:1,'《项目名》':'《逆天萌兽3》'}},
]);
assert.equal(pointsPlan.unchanged, 1);
assert.equal(points.plan(pointsItems, [...existingPoints, ...pointsPlan.create], '《逆天萌兽3》').create.length, 0);
assert.throws(() => points.plan(pointsItems, [existingPoints[0], existingPoints[0]]), /重复/);
console.log('PASS：积分按集数场次补齐、第三季名称、保留已有积分和重复执行');

const {preserveExistingSegments} = require('../src/schedulesync');
const merged = {...result.items[0], key:'第23集', mergedKeys:result.items.map(x=>x.key), segments:result.items};
const preserved = preserveExistingSegments([merged], records);
assert.equal(preserved.length,2);
assert.equal(plan([merged], records).remove.length,0);
assert.equal(plan([merged], records).create.length,0);
assert.ok(plan([merged], records).update.every(x=>!('审阅反馈' in x.fields)&&!('进展' in x.fields)));
assert.throws(()=>plan([{...merged,segments:undefined}],records),/缺少原始分段/);
console.log('PASS：保留原分段、记录ID和业务字段，禁止删除');
