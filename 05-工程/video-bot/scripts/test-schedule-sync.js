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
const conf = { year: 2026, people: { '#8ee085': { id: 'p1', name: '韩欣蓓' }, '#ad82f7': { id: 'p2', name: '殷紫昕' }, '#fbbfbc': { id: 'p3', name: '陈俊杰' } }, ignoredColors: ['#ffffff'], sceneAliases: {}, verifiedScenes: {} };
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
assert.deepEqual(plan(result.items, records), { create: [], update: [], unchanged: 2 });
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
