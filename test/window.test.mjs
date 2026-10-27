import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWindow, selectWindow, writeWindow } from '../src/query.mjs';

test('按发布时间筛选8/24/48小时，排除未知与未来时间并保持原始条目', () => {
  const now = Date.parse('2026-10-24T08:00:00Z');
  const entries = [0, 8, 9, 24, 25, 48, 49].map((age) => ({
    title: `${age}小时前`, url: `https://example.org/${age}`, group: '测试',
    at: new Date(now - age * 3600000).toISOString(),
  }));
  entries.push({ title: '无时间', firstCollectedAt: new Date(now).toISOString() },
    { title: '未来', at: new Date(now + 1).toISOString() });
  assert.deepEqual(selectWindow(entries, 8, now).map((e) => e.title), ['0小时前', '8小时前']);
  assert.equal(selectWindow(entries, 24, now).length, 4);
  assert.equal(selectWindow(entries, 48, now).length, 6);
  assert.equal(entries.length, 9);
  for (const invalid of ['0h', '-1h', 'NaN', '8d', '', '1.5h']) {
    assert.throws(() => parseWindow(invalid));
  }
});

test('生成的范围清单与编号索引一致，保留原始库和默认24小时最新清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'news-window-'));
  try {
    const latest = path.join(root, 'data/latest');
    fs.mkdirSync(latest, { recursive: true });
    const now = Date.parse('2026-10-24T08:00:00Z');
    const item = { title: '历史条目', group: '测试', url: 'https://example.org/old', at: '2026-10-22T20:00:00Z' };
    const stored = JSON.stringify({ old: item });
    fs.writeFileSync(path.join(root, 'data/store.json'), stored);
    fs.writeFileSync(path.join(latest, 'status.json'), JSON.stringify({ collectedAt: new Date(now).toISOString() }));
    fs.writeFileSync(path.join(latest, 'titles.md'), '默认24小时不改变');
    const result = writeWindow({ root, window: '48h', now });
    assert.equal(result.count, 1);
    const [entry] = JSON.parse(fs.readFileSync(result.index, 'utf8'));
    assert.match(fs.readFileSync(result.titles, 'utf8'), new RegExp(entry.ref));
    assert.equal(entry.url, item.url);
    assert.equal(fs.readFileSync(path.join(latest, 'titles.md'), 'utf8'), '默认24小时不改变');
    assert.equal(fs.readFileSync(path.join(root, 'data/store.json'), 'utf8'), stored);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('news-window-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
