#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT = path.resolve(HERE, '..');
export { chromium, request };

export const BOT_WALL =
  /Just a moment|Access Denied|安全验证|Checking your browser|Attention Required|请开启JavaScript|人机验证|访问暂时受限|我不是机器人|Verify you are human|Are you a robot|unusual activity|not a robot|Block reference ID|cf-browser-verification|Enable JavaScript and cookies|请稍候再试|系统检测到异常/i;

export function looksBlocked(title, text) {
  const hay = `${title || ''} ${String(text || '').slice(0, 400)}`;
  const match = hay.match(BOT_WALL);
  return match
    ? `疑似验证墙（命中「${match[0]}」）：${String(title || '').slice(0, 60)}`
    : null;
}

export async function settle(page, { timeout = 12000, quiet = 700 } = {}) {
  const deadline = Date.now() + timeout;
  let last = -1;
  let stableAt = Date.now();
  while (Date.now() < deadline) {
    const length = await page
      .evaluate(() => (document.body ? document.body.innerText.length : 0))
      .catch(() => 0);
    if (length !== last) {
      last = length;
      stableAt = Date.now();
    } else if (Date.now() - stableAt >= quiet) {
      return length;
    }
    await page.waitForTimeout(150);
  }
  return last;
}

export async function dismissOverlays(page) {
  const patterns =
    /^(Reject all|Reject|拒绝全部|拒绝|Continue without accepting|Accept all|同意|知道了|I agree|Don't show today|Don't show again|Close|关闭|以后再说|稍后再说|跳过)$/i;
  for (let index = 0; index < 4; index += 1) {
    const button = page.getByRole('button', { name: patterns }).first();
    if (!(await button.count().catch(() => 0))) break;
    if (!(await button.isVisible().catch(() => false))) break;
    await button.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(200);
  }

  await page
    .evaluate(() => {
      const width = innerWidth;
      const height = innerHeight;
      for (const element of document.querySelectorAll('div,section,aside,dialog')) {
        const style = getComputedStyle(element);
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (Number(style.opacity) < 0.5 || Number(style.zIndex) < 10) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width * rect.height < width * height * 0.25) continue;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        if (centerX < width * 0.25 || centerX > width * 0.75) continue;
        if (centerY < height * 0.25 || centerY > height * 0.75) continue;
        element.style.display = 'none';
      }
    })
    .catch(() => {});
}

export async function warmLazyImages(page) {
  await page.evaluate(() => window.scrollTo(0, 1200)).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await settle(page, { timeout: 4000, quiet: 500 });
}

export const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

export async function launchFor(
  source,
  {
    viewport = { width: 1600, height: 1000 },
    locale = 'zh-CN',
    userAgent = REAL_UA,
    wantApi = true,
  } = {}
) {
  const launch = {
    headless: process.env.HEADFUL !== '1',
    args: ['--no-first-run'],
  };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  if (source?.proxy) launch.proxy = { server: source.proxy };

  const browser = await chromium.launch(launch);
  const context = await browser.newContext({
    viewport,
    locale,
    ...(userAgent ? { userAgent } : {}),
  });
  const api = wantApi
    ? await request.newContext(
        source?.proxy ? { proxy: { server: source.proxy } } : {}
      )
    : null;
  return { browser, context, api, chromium, request };
}
