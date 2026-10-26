# Changelog

## 1.0.2 — 2026-10-26

### Added

- Page palettes grouped by use, with counts, sorting, matching-element navigation and direct color comparisons with explicit transparency handling.
- Font overviews by usage, with sortable sizes and style variants, matching-element controls and notices when color or font inventory limits omit entries.
- Audits of the whole page, initial visible area or selected section, with duration and limits; optional result grouping and filtering missing values by cause.
- Compare two complete manual audits of the same document and scope: new, resolved, persistent or unassessed findings. Removed text never counts as repaired.
- Temporary-analysis overview with measurement times, approximate sizes and confirmed deletion for individual tabs.
- Optional diagnostic copies, off by default, and comparisons between an audit finding and a later inspection of that text area.

### Fixed

- Clipped counter digits and fully masked text no longer create spurious findings; partly visible wide text is checked for overlays within the visible area.
- Supported offscreen labels retain labeled CSS color-pair results. Uncertain masks remain unverified, and scoped audits preserve differences in measured coverage.
- Differently styled first lines/letters and text outside painted backgrounds no longer produce false passes. Uncertain coverage stays unverified.
- Rejected scans retain previous results and release pending controls, even after another selection. Interrupted inspections and storage failures recover without mixing selections or losing settings.
- Reports preserve scope and contrast-minimum labels; font findings use readability terminology. Bounded previews keep full copying/saving, and audit filters and font loading preserve keyboard focus.
- Page-value exports include measured overview colors and fonts, with an explicit raw-CSS alternative and frozen draft data.

### Changed

- Page and element results now refresh only on request. Page changes mark results stale and stop ongoing observation to reduce background work.
- Audits, inspections and hover previews yield during large text measurements and cancel obsolete work. Long font lists and variants load progressively.
- Analyses remain only in memory and reset on page reload or browser/background restart; settings persist. Eviction also releases page-side results and references, with older comparison baselines released first.
