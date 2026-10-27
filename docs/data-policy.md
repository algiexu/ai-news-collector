# Data and third-party content policy

This repository publishes code, not a news archive.

## What stays local

The collector writes generated files under `data/`, including:

- source batches
- the historical store
- latest titles, index, and status
- query results

`data/` is excluded by `.gitignore`. Production data belongs in a private repository or another private store.

## Third-party content

Source feeds and pages may contain copyrighted titles, summaries, images, or other material. The MIT license for this repository does not grant rights to that content.

Before storing, republishing, or redistributing material from a source:

1. Check the source's terms, robots policy, API documentation, and applicable law.
2. Prefer storing a URL, source name, and minimal metadata.
3. Attribute the original source.
4. Do not reproduce full articles unless you have permission.
5. Respect rate limits and do not bypass access controls.

## Public examples

Files under `examples/` are synthetic and use reserved `example.com` URLs. They demonstrate the data shape without redistributing real article content.
