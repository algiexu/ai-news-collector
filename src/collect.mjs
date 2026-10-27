#!/usr/bin/env node
/**
 * 选题发现工具 —— 把「查各榜 → 找原始报道」这一步收成命令。
 *
 *   node src/collect.mjs list
 *   node src/collect.mjs add --name 量子位 --url https://www.qbitai.com/
 *   node src/collect.mjs pull
 *   node src/collect.mjs pull --source X榜单_海外
 *
 * 信息源全部写在 config/sources.json 里，**可以随时增删**，不用改代码。
 * 每个源能单独声明：要不要走代理、要不要先点某个筛选按钮、用什么 UA。
 *
 * 支持两种源类型：
 *   网页  抓页面（榜单、媒体站）
 *   接口  调 JSON 接口（AIHOT 这类提供官方匿名接口的站，数据质量远好于抓页面）
 *
 * 各源的网络需求不一样，所以代理必须是**每源单独**的：
 *   xbangdan.com  直连 403 / 代理 200   → 必须走代理
 *   aihot.news    直连 200 / 代理 403   → 必须直连
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseGlobalPage,
  collectApiPages,
  titleList,
  recentGlobalEntries,
  recentFeedEntries,
} from './lib/parser.mjs';
import {
  PROJECT,
  launchFor,
  request,
  settle,
  dismissOverlays,
  looksBlocked,
  REAL_UA,
} from './browser.mjs';

const HERE = path.join(PROJECT, 'src');
const CONFIG = process.env.NEWS_CONFIG
  ? path.resolve(process.env.NEWS_CONFIG)
  : path.join(PROJECT, 'config', 'sources.json');
const PYTHON = process.env.NEWS_PYTHON || 'python';

const log = (...a) => console.error(...a);
const out = (o) => console.log(JSON.stringify(o, null, 2));

/* ================================================================== *
 * 配置：信息源清单（可增删）
 * ================================================================== */

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(cfg.sources)) cfg.sources = [];
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 每源代理解析：true = 用全局代理，字符串 = 该地址，其余 = 直连 */
function resolveProxy(src, cfg) {
  if (src.proxy === true) return cfg.proxy || process.env.NEWS_PROXY || null;
  if (typeof src.proxy === 'string' && src.proxy) return src.proxy;
  return null;
}

/* ================================================================== *
 * 小工具
 * ================================================================== */

/** 按点号路径取值：dig({a:{b:1}}, 'a.b') === 1 */
function dig(obj, dotted) {
  return String(dotted)
    .split('.')
    .reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);
}

/** 把接口条目归一成 {title,url,summary,source,at}，字段名尽量兼容 */
function normalizeItem(it) {
  const pick = (...names) => {
    for (const n of names) {
      const v = dig(it, n);
      if (v !== undefined && v !== null && String(v).trim()) return v;
    }
    return '';
  };
  return {
    id: String(pick('id')),
    title: String(pick('title', 'name', 'headline')),
    originalTitle: String(pick('originalTitle', 'titleEn')),
    url: String(pick('links.original', 'originalUrl', 'url', 'link', 'sourceUrl')),
    aihotUrl: String(pick('links.aihot', 'aihotUrl')),
    summary: String(pick('summary', 'description', 'desc', 'text')),
    source: String(pick('source.name', 'source', 'site')),
    at: String(pick('publishedAt', 'date', 'time')),
    discoveredAt: String(pick('discoveredAt')),
    category: String(pick('category', 'tag')),
    score: Number(pick('score')) || null,
  };
}

/* ================================================================== *
 * 命令：源 / 加 / 停 / 启 / 删
 * ================================================================== */

function cmdList() {
  const cfg = loadConfig();
  log(`配置：${path.relative(PROJECT, CONFIG)}（全局代理 ${cfg.proxy || '未设'}）\n`);
  for (const s of cfg.sources) {
    const flag = s.enabled === false ? '停用' : '启用';
    const px = resolveProxy(s, cfg);
    log(`  [${flag}] ${s.name}  (${s.kind || '网页'})`);
    log(`         ${s.url}`);
    log(`         代理 ${px || '直连'}${s.filter ? ` · 先点「${s.filter}」` : ''}${s.api ? ' · 官方接口' : ''}`);
    if (s.note) log(`         ${s.note}`);
  }
  const summary = {
    config: CONFIG,
    proxy: cfg.proxy || null,
    total: cfg.sources.length,
    enabled: cfg.sources.filter((s) => s.enabled !== false).length,
    sources: cfg.sources.map((s) => ({
      name: s.name,
      kind: s.kind || '网页',
      url: s.url,
      enabled: s.enabled !== false,
      proxy: resolveProxy(s, cfg),
      filter: s.filter || null,
    })),
  };
  out(summary);
  return summary;
}

function cmdAdd(o) {
  if (!o.name) throw new Error('缺少 --名 <信息源名称>');
  if (!o.url) throw new Error('缺少 --网址 <url>');
  const cfg = loadConfig();
  if (cfg.sources.some((s) => s.name === o.name)) {
    throw new Error(`已存在同名信息源：${o.name}（要改的话先 删，或手工编辑 ${path.relative(PROJECT, CONFIG)}）`);
  }
  const src = { name: o.name, kind: o.kind || '网页', url: o.url, enabled: true };
  if (o.proxy) src.proxy = o.proxy === 'true' ? true : o.proxy;
  if (o.filter) src.filter = o.filter;
  if (o.note) src.note = o.note;
  cfg.sources.push(src);
  saveConfig(cfg);
  log(`✓ 已加入信息源「${o.name}」（${src.kind}）→ ${path.relative(PROJECT, CONFIG)}`);
  out({ added: src, total: cfg.sources.length });
}

function cmdToggle(o, enabled) {
  if (!o.name) throw new Error('缺少 --名 <信息源名称>');
  const cfg = loadConfig();
  const hit = cfg.sources.find((s) => s.name === o.name);
  if (!hit) throw new Error(`没有这个信息源：${o.name}`);
  hit.enabled = enabled;
  saveConfig(cfg);
  log(`✓ 「${hit.name}」已${enabled ? '启用' : '停用'}`);
  out({ name: hit.name, enabled });
}

function cmdRemove(o) {
  if (!o.name) throw new Error('缺少 --名 <信息源名称>');
  const cfg = loadConfig();
  const i = cfg.sources.findIndex((s) => s.name === o.name);
  if (i < 0) throw new Error(`没有这个信息源：${o.name}`);
  const [removed] = cfg.sources.splice(i, 1);
  saveConfig(cfg);
  log(`✓ 已删除信息源「${removed.name}」（只影响 ${path.relative(PROJECT, CONFIG)}，已拉取的历史文件不动）`);
  out({ removed: removed.name, total: cfg.sources.length });
}

/* ================================================================== *
 * 拉取：网页源
 * ================================================================== */

async function fetchWeb(src, cfg, outDir, shared) {
  const page = await shared.context.newPage();
  const rec = { name: src.name, kind: '网页', url: src.url, proxy: shared.proxy, status: 'ok' };
  try {
    await page.goto(src.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page, { timeout: 20000 });
    await dismissOverlays(page);

    if (src.name === 'X榜单_海外') {
      const end = Date.now();
      const latestPeriod = await page.evaluate(() => document.body.innerText.match(/数据日期[^\n]+/)?.[0] || '');
      await page.locator('button[data-gcat="ai"]').click({ timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('button[data-gcat="ai"].on'));
      await settle(page, { timeout: 10000, quiet: 600 });
      const entries = [];
      const ids = new Set();
      let pages = 0;
      let date = '';
      // 近7天按热度展示，不能替代最新日榜；两份并集避免漏掉较新的低排名帖。
      for (const range of ['latest', '7d']) {
        await page.locator(`button[data-grange="${range}"]`).click();
        await settle(page, { timeout: 10000, quiet: 600 });
        let rangePages = 0;
        const rangeIds = new Set();
        while (true) {
          const part = await page.evaluate(parseGlobalPage);
          if (!part.entries.length) throw new Error('海外 AI 榜为空，无法确认是否加载完成');
          if (part.page !== rangePages + 1) throw new Error('海外榜页码不连续，采集未完成');
          rangePages += 1;
          pages += 1;
          date = part.date;
          for (const entry of part.entries) {
            if (rangeIds.has(entry.id)) throw new Error(`海外榜翻页出现重复条目 ${entry.id}`);
            rangeIds.add(entry.id);
            if (ids.has(entry.id)) continue;
            ids.add(entry.id);
            entries.push(entry);
          }
          if (!part.hasNext) break;
          const firstId = part.entries[0].id;
          await page.locator('button[data-go="next"]').click();
          await page.waitForFunction((old) => {
            const id = document.querySelector('#gl-tbody tr.gl2-row')?.dataset.id;
            return id && id !== old;
          }, firstId, { timeout: 10000 });
        }
      }
      const safe = src.name.replace(/[\\/:*?"<>|]/g, '_');
      const file = path.join(outDir, `${safe}.json`);
      const recent = recentGlobalEntries(entries, end);
      const window = { start: new Date(end - 86400000).toISOString(), end: new Date(end).toISOString() };
      const coverage = `最新日榜与近7天AI榜合并去重后，按原帖发布时间筛选近24小时；不包含榜单尚未收录的内容。最新日榜范围：${latestPeriod || '页面未标明'}`;
      fs.writeFileSync(file, JSON.stringify({ date, pages, fetchedCount: entries.length, count: recent.length,
        complete: true, window, coverage, entries: recent }, null, 2), 'utf8');
      Object.assign(rec, { count: recent.length, withUrl: recent.length, pages, coverage, window, filterClicked: true,
        files: { json: file } });
      log(`  ✓ ${src.name} AI板块 ${pages} 页 · ${entries.length} 条中近24小时 ${recent.length} 条`);
      return rec;
    }

    // 筛选按钮按前缀匹配：实测海外榜那个按钮文字是「AI100+」不是「AI」
    if (src.filter) {
      const clicked = await page.evaluate((label) => {
        const all = [...document.querySelectorAll('button, a, div, span')];
        const hit = all.find((e) => {
          const t = (e.innerText || '').trim();
          return e.offsetHeight > 0 && t.length <= label.length + 6 && t.startsWith(label);
        });
        if (!hit) return false;
        hit.click();
        return true;
      }, src.filter);
      rec.filterClicked = clicked;
      if (clicked) await settle(page, { timeout: 10000, quiet: 600 });
      else throw new Error(`${src.name} 没找到筛选按钮「${src.filter}」，停止采集，避免混入其他板块`);
    }

    const info = await page.evaluate(() => ({
      title: document.title,
      landed: location.href,
      text: (document.body ? document.body.innerText : '').slice(0, 40000),
      links: [...document.querySelectorAll('a[href]')]
        .filter((e) => e.offsetHeight || e.offsetWidth)
        .map((e) => ({ text: (e.innerText || '').trim().slice(0, 140), url: e.href }))
        .filter((e) => /^https?:/.test(e.url))
        .slice(0, 600),
    }));

    const wall = looksBlocked(info.title, info.text);
    if (wall) {
      rec.status = 'blocked';
      rec.error = wall;
      log(`  ✗ ${src.name} ${wall}`);
      return rec;
    }

    const safe = src.name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(outDir, `${safe}.json`), JSON.stringify(info, null, 2), 'utf8');
    await page.screenshot({ path: path.join(outDir, `${safe}.png`) });

    rec.chars = info.text.length;
    rec.links = info.links.length;
    rec.xlinks = info.links.filter((l) => /x\.com|twitter\.com/.test(l.url)).length;
    rec.files = { json: path.join(outDir, `${safe}.json`), screenshot: path.join(outDir, `${safe}.png`) };
    log(`  ✓ ${src.name}  正文 ${rec.chars} 字 · 链接 ${rec.links}（X ${rec.xlinks}）`);
  } catch (err) {
    rec.status = 'failed';
    rec.error = String(err.message || err).slice(0, 200);
    log(`  ✗ ${src.name} ${rec.error}`);
  } finally {
    await page.close();
  }
  return rec;
}

/* ================================================================== *
 * 拉取：接口源
 * ================================================================== */

async function fetchApi(src, cfg, outDir, shared) {
  const proxy = resolveProxy(src, cfg);
  const rec = { name: src.name, kind: src.kind, url: src.url, proxy, status: 'ok' };
  try {
    let url = src.url;
    if (shared.window) url = url.replace(/([?&]window=)[^&]*/, `$1${shared.window}`);
    if (shared.limit) url = url.replace(/([?&]limit=)[^&]*/, `$1${shared.limit}`);

    const headers = {};
    if (src.kind === 'RSS' || src.name === 'Readhub') headers['User-Agent'] = REAL_UA;
    if (src.api?.ua) headers['User-Agent'] = src.api.ua;
    if (src.api?.headers) Object.assign(headers, src.api.headers);

    const result = await collectApiPages(async (cursor) => {
      const pageUrl = new URL(url);
      if (cursor) pageUrl.searchParams.set('cursor', cursor);
      const resp = await shared.api.get(pageUrl.href, { headers, timeout: 30000 });
      if (!resp.ok()) throw new Error(`HTTP ${resp.status()}：${(await resp.text()).slice(0, 160)}`);
      if (src.kind === 'RSS') {
        const parsed = spawnSync(PYTHON, [path.join(HERE, 'parse_rss.py')], {
          input: await resp.body(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        });
        if (parsed.error) throw parsed.error;
        if (parsed.status !== 0) throw new Error(parsed.stderr.trim());
        return JSON.parse(parsed.stdout);
      }
      const json = await resp.json();
      if (src.name === 'Readhub') {
        if (!Array.isArray(json.data?.items)) throw new Error('Readhub 缺少 data.items');
        return { items: json.data.items.map((item) => ({
          id: item.uid, title: item.title, summary: item.summary,
          url: item.newsAggList?.[0]?.url || '', source: item.siteNameDisplay,
          publishedAt: item.publishDate,
        })) };
      }
      if (Array.isArray(json)) return { items: json };
      if (src.api?.items) json.items = dig(json, src.api.items);
      return json;
    }, { paginate: src.api?.paginate === true });
    let entries = result.entries.map(normalizeItem);
    let feed;
    if (src.recent24h) {
      feed = recentFeedEntries(entries, src.limit);
      entries = feed.entries;
      rec.coverage = `仅从来源当前返回的最新条目筛选近24小时，最多${src.limit}条，不保证覆盖完整24小时；${feed.missingDate}条因缺少有效时间未采用`;
    }
    const safe = src.name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(
      path.join(outDir, `${safe}.json`),
      JSON.stringify({ url, pages: result.pages, count: entries.length,
        coverage: rec.coverage, fetchedCount: result.entries.length, entries }, null, 2),
      'utf8'
    );

    rec.count = entries.length;
    rec.pages = result.pages.length;
    rec.withUrl = entries.filter((e) => e.url).length;
    rec.files = { json: path.join(outDir, `${safe}.json`) };
    log(`  ✓ ${src.name}  ${entries.length} 条（${rec.withUrl} 条带原始链接）`);
  } catch (err) {
    rec.status = 'failed';
    rec.error = String(err.message || err).slice(0, 200);
    log(`  ✗ ${src.name} ${rec.error}`);
  }
  return rec;
}

/* ================================================================== *
 * 命令：拉
 * ================================================================== */

async function cmdPull(o) {
  const cfg = loadConfig();
  let list = cfg.sources.filter((s) => s.enabled !== false);
  if (o.name) {
    list = list.filter((s) => s.name === o.name || (o.name === 'AIHOT' && s.name.startsWith('AIHOT_')));
    if (!list.length) throw new Error(`没有启用的信息源叫「${o.name}」（用 源 看列表）`);
  }
  if (!list.length) throw new Error('没有启用的信息源，用 加 添加或 启 打开');

  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const outDir = o.out ? path.resolve(o.out) : path.join(PROJECT, 'data', 'batches', today.toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  log(`拉到 ${path.relative(PROJECT, outDir)}（${list.length} 个源）`);

  // 按代理分组复用浏览器：网页源才需要浏览器，接口源不用
  const webSources = list.filter((s) => !['接口', 'RSS'].includes(s.kind));
  const apiSources = list.filter((s) => ['接口', 'RSS'].includes(s.kind));
  const groups = new Map();
  for (const s of webSources) {
    const px = resolveProxy(s, cfg);
    if (!groups.has(px)) groups.set(px, []);
    groups.get(px).push(s);
  }

  // 按源名合并进已有记录，而不是整份覆盖：
  // 否则「拉 --源 AIHOT」会把上一轮其它源的记录冲掉，回头看不出当天到底拉过什么。
  // mine = 本轮结果（用于屏幕汇总），records = 当天档案（写文件，含往轮）。
  const recFile = path.join(outDir, 'collection-records.json');
  const records = [];
  if (fs.existsSync(recFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(recFile, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(old)) records.push(...old.filter((r) => r && r.name && !list.some((s) => s.name === r.name)));
    } catch { /* 旧记录坏了就重来，不阻断本次拉取 */ }
  }
  const mine = [];
  const flush = () => fs.writeFileSync(recFile, JSON.stringify(records, null, 2), 'utf8');
  const keep = (rec) => { mine.push(rec); records.push(rec); flush(); };

  // 接口源：不需要浏览器，用 playwright 的 request（它支持代理）
  if (apiSources.length) {
    for (const s of apiSources) {
      const px = resolveProxy(s, cfg);
      const api = await request.newContext(px ? { proxy: { server: px } } : {});
      keep(await fetchApi(s, cfg, outDir, { api, window: o.window, limit: o.limit }));
      await api.dispose();
    }
  }

  // 网页源：同一代理的源共用一个浏览器
  for (const [proxy, sources] of groups) {
    const { browser, context } = await launchFor({ proxy }, { userAgent: o.ua || REAL_UA, wantApi: false });
    try {
      for (const s of sources) {
        keep(await fetchWeb(s, cfg, outDir, { context, proxy }));
      }
    } finally {
      await browser.close();
    }
  }

  const enabled = new Set(cfg.sources.filter((s) => s.enabled !== false).map((s) => s.name));
  const titleGroups = records.filter((r) => enabled.has(r.name) && r.status === 'ok').map((r) => ({
    name: r.name,
    coverage: r.coverage,
    entries: JSON.parse(fs.readFileSync(r.files.json, 'utf8')).entries || [],
  }));
  const titles = titleList(titleGroups);
  const problems = records.filter((r) => enabled.has(r.name) && r.status !== 'ok');
  const notice = problems.length ? `未完成来源：${problems.map((r) => r.name).join('、')}。\n\n` : '';
  const coverageNotice = titleGroups.filter((g) => g.coverage).map((g) => `${g.name}：${g.coverage}\n\n`).join('');
  fs.writeFileSync(path.join(outDir, 'titles.md'), notice + coverageNotice + titles.markdown, 'utf8');
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(titles.items, null, 2), 'utf8');

  const summary = {
    dir: outDir,
    total: mine.length,
    ok: mine.filter((r) => r.status === 'ok').length,
    blocked: mine.filter((r) => r.status === 'blocked').length,
    failed: mine.filter((r) => r.status === 'failed').length,
    records: mine.map((r) => ({
      name: r.name,
      kind: r.kind,
      status: r.status,
      chars: r.chars || 0,
      count: r.count || 0,
      withUrl: r.withUrl || 0,
      links: r.links || 0,
      error: r.error,
    })),
    // 当天档案里累计了几个源（含往轮拉的），方便一眼看出是不是拉全了
    inDayFile: records.length,
    titles: path.join(outDir, 'titles.md'),
    index: path.join(outDir, 'index.json'),
  };
  publishLatest(titles.items, summary);
  out(summary);
  if (summary.failed || summary.blocked) process.exitCode = 1;
  return summary;
}

export function publishLatest(items, summary, dataDir = path.join(PROJECT, 'data')) {
  fs.mkdirSync(dataDir, { recursive: true });
  const storeFile = path.join(dataDir, 'store.json');
  const store = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : {};
  const now = new Date().toISOString();
  for (const item of items) {
    const key = item.url || item.aihotUrl || `${item.group}:${item.id || item.title}`;
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
    const previous = store[id];
    store[id] = { ...previous, ...item, id, firstCollectedAt: previous?.firstCollectedAt || now,
      lastCollectedAt: now, groups: [...new Set([...(previous?.groups || []), item.group])] };
  }
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));
  const recent = Object.values(store).filter((item) => {
    const at = Date.parse(item.publishedAt || item.at);
    return at >= Date.now() - 86400000 && at <= Date.now();
  }).sort((a, b) => Date.parse(b.publishedAt || b.at) - Date.parse(a.publishedAt || a.at));
  const latest = path.join(dataDir, 'latest');
  fs.mkdirSync(latest, { recursive: true });
  const groups = [...new Set(recent.map((item) => item.group))].map((name) => ({ name, entries: recent.filter((item) => item.group === name) }));
  const titles = titleList(groups);
  fs.writeFileSync(path.join(latest, 'index.json'), JSON.stringify(titles.items, null, 2));
  const failed = summary.records.filter((r) => r.status !== 'ok');
  fs.writeFileSync(path.join(latest, 'titles.md'), `采集时间：${now}；滚动近24小时。\n${failed.length ? '本轮未完成来源：' + failed.map((r) => r.name).join('、') + '。历史条目不代表本轮采集成功。\n' : ''}\n` + titles.markdown);
  fs.writeFileSync(path.join(latest, 'status.json'), JSON.stringify({ ...summary, collectedAt: now, windowHours: 24, latestCount: titles.items.length, callsAI: false }, null, 2));
}

/* ================================================================== *
 * 命令行
 * ================================================================== */

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--名' || a === '--name') o.name = argv[++i];
    else if (a === '--网址' || a === '--url') o.url = argv[++i];
    else if (a === '--代理' || a === '--proxy') o.proxy = argv[++i];
    else if (a === '--筛选' || a === '--filter') o.filter = argv[++i];
    else if (a === '--类' || a === '--kind') o.kind = argv[++i];
    else if (a === '--备注' || a === '--note') o.note = argv[++i];
    else if (a === '--源' || a === '--source') o.name = argv[++i];
    else if (a === '--输出' || a === '--out') o.out = argv[++i];
    else if (a === '--窗口' || a === '--window') o.window = argv[++i];
    else if (a === '--条数' || a === '--limit') o.limit = argv[++i];
    else if (a === '--批' || a === '--batch') o.batch = argv[++i];
    else if (a === '--条') o.count = argv[++i];
    else if (a === '--并发' || a === '--concurrency') o.concurrency = argv[++i];
    else if (a === '--ua') o.ua = argv[++i];
    else o._.push(a);
  }
  return o;
}

const USAGE = `资讯库纯脚本采集（不调用 AI）
  node src/collect.mjs pull [--source <名>] [--out <目录>]
  node src/collect.mjs list|add|disable|enable|remove
  信息源唯一配置：config/sources.json
  最新输出：data/latest/；历史批次：data/batches/；去重：data/store.json
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const o = parseArgs(argv);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }

  if (cmd === '源' || cmd === 'list') return cmdList();
  if (cmd === '加' || cmd === 'add') return cmdAdd(o);
  if (cmd === '停' || cmd === 'disable') return cmdToggle(o, false);
  if (cmd === '启' || cmd === 'enable') return cmdToggle(o, true);
  if (cmd === '删' || cmd === 'remove') return cmdRemove(o);
  if (cmd === '拉' || cmd === 'pull') return cmdPull(o);
  throw new Error(`不认识的命令：${cmd}\n\n${USAGE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => {
  log(`\n✗ ${err.message}`);
  process.exit(1);
});
