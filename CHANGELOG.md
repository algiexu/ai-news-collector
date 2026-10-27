# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-10-28

### Added

- Public, sanitized release of the script-based news collector.
- RSS, JSON API, and Playwright web-source support.
- Stable URL-based deduplication and source-level status reporting.
- Time-window queries over the local historical store.
- CI, manual collection workflow, tests, documentation, and example data.

### Changed

- Replaced machine-specific browser discovery with the bundled Playwright runtime.
- Moved source configuration to `config/sources.json`.
- Removed production data and local proxy configuration from the public project.
