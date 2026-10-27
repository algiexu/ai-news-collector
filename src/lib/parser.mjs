// 此函数在海外榜页面中执行；选择器来自实际表格结构。
export function parseGlobalPage() {
  const category = document.querySelector('button[data-gcat].on')?.dataset.gcat;
  if (category !== 'ai') throw new Error('海外榜当前分类不是 AI');
  const rows = [...document.querySelectorAll('#gl-tbody tr.gl2-row')];
  const entries = rows.map((row) => {
    const id = row.dataset.id;
    const account = row.querySelector('.tc-w a')?.getAttribute('href');
    const body = row.querySelector('.tc-clamp');
    if (row.dataset.cat !== 'ai' || !/^\d+$/.test(id || '') || !account || !body) {
      throw new Error('海外榜行结构不符合预期');
    }
    const clone = body.cloneNode(true);
    clone.querySelectorAll('.tc-mk').forEach((node) => node.remove());
    const text = clone.textContent.trim();
    const event = body.querySelector('.tc-ev')?.textContent.trim();
    const first = text.split(/\n|(?<=[。！？])/u).find((line) => line.trim())?.trim();
    if (!text) throw new Error(`海外榜条目 ${id} 没有正文`);
    const title = event || (first.length > 100 ? first.slice(0, 100) + '…' : first);
    const value = (selector) => row.querySelector(selector)?.textContent.trim() || '';
    return {
      id, title, titleKind: event ? '榜单事件标题' : '原帖首句节选', text,
      url: `${account.replace(/\/$/, '')}/status/${id}`,
      account: value('.tc-nm'), at: value('.gc-time'),
      likes: value('.gc-likes'), views: value('.gc-views'),
      reposts: value('.gc-rts'), bookmarks: value('.gc-bookmarks'),
    };
  });
  const next = document.querySelector('button[data-go="next"]');
  const pagination = document.body.innerText.match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
  if (!pagination) throw new Error('海外榜缺少分页信息，无法确认采集范围');
  const page = Number(pagination[1]);
  const totalPages = Number(pagination[2]);
  const hasNext = Boolean(next && !next.disabled);
  if (hasNext !== (page < totalPages)) throw new Error('海外榜分页按钮与页码不一致');
  return { entries, page, totalPages, hasNext,
    date: document.body.innerText.match(/数据日期[^\n]+/)?.[0] || '' };
}

export async function collectApiPages(fetchPage, { paginate = false } = {}) {
  const entries = [];
  const pages = [];
  const cursors = new Set();
  let cursor;
  do {
    const json = await fetchPage(cursor);
    if (json.error || json.errors) throw new Error(`接口拒绝：${JSON.stringify(json.error || json.errors)}`);
    if (!Array.isArray(json.items)) throw new Error('接口返回缺少 items 数组');
    entries.push(...json.items);
    pages.push(json.page || null);
    if (!paginate || !json.page?.hasMore) break;
    cursor = json.page.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('接口分页游标缺失或重复，采集未完成');
    cursors.add(cursor);
  } while (true);
  return { entries, pages };
}

// X snowflake ID 内含原帖 UTC 创建时间，避免把页面的月日误作完整时间。
export function recentGlobalEntries(entries, now = Date.now()) {
  const start = now - 24 * 60 * 60 * 1000;
  return entries.map((entry) => {
    const timestamp = Number((BigInt(entry.id) >> 22n) + 1288834974657n);
    return { ...entry, publishedAt: new Date(timestamp).toISOString() };
  }).filter((entry) => {
    const timestamp = Date.parse(entry.publishedAt);
    return timestamp >= start && timestamp <= now;
  });
}

export function recentFeedEntries(entries, limit, now = Date.now()) {
  const dated = entries.filter((entry) => Number.isFinite(Date.parse(entry.at)));
  const recent = dated.filter((entry) => {
    const at = Date.parse(entry.at);
    return at >= now - 86400000 && at <= now;
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const seen = new Set();
  const unique = recent.filter((entry) => {
    if (!entry.title || !/^https?:\/\//.test(entry.url) || seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
  return { entries: unique.slice(0, limit), missingDate: entries.length - dated.length,
    recentCount: unique.length };
}

export function titleList(groups) {
  const seen = new Map();
  const items = [];
  const sections = [];
  for (const { name, entries } of groups) {
    const lines = [`## ${name}（${entries.length} 条）`, ''];
    entries.forEach((entry, index) => {
      const key = entry.url || entry.id || entry.aihotUrl || entry.title;
      const previous = seen.get(key);
      const id = `${name}:${index + 1}`;
      if (!previous) seen.set(key, id);
      items.push({ ...entry, ref: id, group: name, duplicateOf: previous || null });
      const title = entry.title.replace(/\s+/g, ' ');
      lines.push(`- [${id}] ${title}${previous ? `（重复：${previous}）` : ''}`);
    });
    sections.push(lines.join('\n'));
  }
  return { markdown: sections.join('\n\n') + '\n', items };
}
