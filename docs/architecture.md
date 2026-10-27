# Architecture

## Pipeline

1. `src/collect.mjs` reads `config/sources.json`.
2. Enabled sources are split into RSS/API and browser-backed web sources.
3. RSS/API responses are normalized into a common item shape.
4. Browser sources use Playwright and explicit page parsers.
5. Items are deduplicated and merged into `data/store.json`.
6. The latest 24-hour view is written to `data/latest/`.
7. `src/query.mjs` can create an additional time-window view without changing the latest files.

## Source types

### RSS

The feed XML is sent to `src/parse_rss.py`, which extracts title, link, and publication time using the Python standard library.

### JSON API

The collector supports arrays, `items`, `data.items`, nested item paths, and cursor pagination. Source-specific normalization stays small and explicit.

### Web page

Playwright opens the page with a normal browser context. A source can declare a filter button, proxy mode, or a custom parser. The collector detects common verification-wall text and records the source as `blocked`.

## Deduplication

The primary key is the original article URL. If no URL exists, the collector falls back to an AIHOT URL or a source/group plus item identifier. A SHA-256-derived ID keeps the store stable across runs.

## Failure semantics

- One source failure does not discard successful results from other sources.
- The process exits non-zero if any enabled source is blocked or failed.
- `status.json` distinguishes successful, blocked, and failed sources.
- Unknown or invalid publication times are excluded from recent-window output.
- Missing or partial coverage is never treated as evidence that no news exists.

## Deliberate limits

- No database, queue, model call, or hidden retry layer.
- No bypass of authentication, CAPTCHA, or access controls.
- No generic scraping framework.
- No automatic publication of collected third-party content.
