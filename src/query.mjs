import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleList } from './lib/parser.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function parseWindow(value = '24h') {
  const text = String(value);
  if (!/^\d+h?$/.test(text)) throw new Error('时间窗口须为正整数小时，例如 8h、24h、48h');
  const hours = Number(text.replace(/h$/, ''));
  if (!Number.isSafeInteger(hours) || hours <= 0 || !Number.isSafeInteger(hours * 3600000)) {
    throw new Error('时间窗口须为正整数小时');
  }
  return hours;
}

export function selectWindow(items, hours, now = Date.now()) {
  parseWindow(hours);
  return items.filter((item) => {
    const at = Date.parse(item.publishedAt || item.at);
    return at >= now - hours * 3600000 && at <= now;
  }).sort((a, b) => Date.parse(b.publishedAt || b.at) - Date.parse(a.publishedAt || a.at));
}

export function writeWindow({ window = '24h', root = ROOT, now = Date.now() } = {}) {
  const hours = parseWindow(window);
  const store = JSON.parse(fs.readFileSync(path.join(root, 'data/store.json'), 'utf8').replace(/^\uFEFF/, ''));
  const all = Object.values(store);
  const selected = selectWindow(all, hours, now);
  const groups = [...new Set(selected.map((item) => item.group))].map((name) => ({
    name, entries: selected.filter((item) => item.group === name),
  }));
  const titles = titleList(groups);
  const dir = path.join(root, 'data/queries', `${hours}h`);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'data/latest/status.json'), 'utf8').replace(/^\uFEFF/, ''));
  const summary = {
    windowHours: hours, start: new Date(now - hours * 3600000).toISOString(),
    end: new Date(now).toISOString(), queriedAt: new Date(now).toISOString(),
    collectedAt: state.collectedAt, count: titles.items.length, storedCount: all.length,
    unknownDateCount: all.filter((item) => !Number.isFinite(Date.parse(item.publishedAt || item.at))).length,
    coverage: '只筛选实际入库且有有效发布时间的条目；未采集或漏采的内容不能补齐。',
    titles: path.join(dir, 'titles.md'), index: path.join(dir, 'index.json'),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(summary.titles, `查询过去${hours}小时：${summary.start} 至 ${summary.end}\n最近采集：${state.collectedAt}\n${summary.coverage}\n\n${titles.markdown}`);
  fs.writeFileSync(summary.index, JSON.stringify(titles.items, null, 2));
  fs.writeFileSync(path.join(dir, 'query.json'), JSON.stringify(summary, null, 2));
  return summary;
}

export function queryOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--窗口' || argv[i] === '--window') {
      if (!argv[i + 1]) throw new Error('--窗口 缺少值');
      options.window = `${parseWindow(argv[++i])}h`;
    } else throw new Error(`不认识的参数：${argv[i]}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(writeWindow(queryOptions(process.argv.slice(2))), null, 2));
}
