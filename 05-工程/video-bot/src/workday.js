/**
 * 法定工作日判断（含调休补班日）
 *
 * 数据源：NateScarlet/holiday-cn（按国务院公告整理，一年更新几次）。
 * 本地缓存 7 天放 logs/holiday-cn-<年份>.json；三个源都不通就退回「周一到周五」。
 *
 * 数据格式：{ year, days: [{ name, date: 'YYYY-MM-DD', isOffDay: true|false }] }
 * days 里只放节假日和调休补班日，普通日子不在列表里 → 按周末判断。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_MAX_AGE = 7 * 864e5;

const SOURCES = [
  (y) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`,
  (y) => `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`,
  (y) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`,
];

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cachePath(year) {
  return path.join(ROOT, 'logs', `holiday-cn-${year}.json`);
}

async function loadHolidays(year) {
  try {
    const st = fs.statSync(cachePath(year));
    if (Date.now() - st.mtimeMs < CACHE_MAX_AGE) return JSON.parse(fs.readFileSync(cachePath(year), 'utf8'));
  } catch (e) {
    /* 没缓存 */
  }
  for (const src of SOURCES) {
    try {
      const res = await fetch(src(year), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && Array.isArray(j.days)) {
        try {
          fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
          fs.writeFileSync(cachePath(year), JSON.stringify(j, null, 1));
        } catch (e) {
          /* 写不进缓存不影响本次判断 */
        }
        return j;
      }
    } catch (e) {
      /* 换下一个源 */
    }
  }
  return null;
}

/** @returns {Promise<{work:boolean, note:string, from:string, date:string}>} */
async function checkWorkday(d = new Date()) {
  const date = ymd(d);
  const cal = await loadHolidays(d.getFullYear());
  const dow = d.getDay();
  const weekend = dow === 0 || dow === 6;
  if (cal) {
    const hit = (cal.days || []).find((x) => x.date === date);
    if (hit) {
      return {
        work: !hit.isOffDay,
        note: `${hit.name || '法定假日'}${hit.isOffDay ? '放假' : '调休补班（要上班）'}`,
        from: 'holiday-cn',
        date,
      };
    }
    return { work: !weekend, note: weekend ? '周末' : '正常工作日', from: 'holiday-cn', date };
  }
  return {
    work: !weekend,
    note: '节假日数据拿不到（三个源都不通），按周一至周五判断',
    from: 'fallback',
    date,
  };
}

module.exports = { checkWorkday, loadHolidays, ymd };
