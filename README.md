# Style Inspector Lite

<img src="assets/logo-source.png" alt="Style Inspector Lite" width="260">

A local CSS inspector in Firefox's native sidebar. Inspect an element, check text contrast and small text, compare color suggestions, and export measured styles. Version **1.0.2** is dated **2026-10-26**; see the [changelog](CHANGELOG.md) for its changes.

Licensed under the [Mozilla Public License 2.0](LICENSE). Third-party model notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

[Installation](#installation) · [Features](#features) · [Getting started](#getting-started) · [Settings](#settings) · [Exports](#exports) · [Things to know](#things-to-know) · [Development and testing](#development-and-testing)

## Installation

**Install from [Mozilla Add-ons](https://addons.mozilla.org/de/firefox/addon/style-inspector-lite/).** The listing will become available after the first release is published.

### Local development

For local development, run `npm ci` and `npm run build` from the source directory. Open `about:debugging`, choose **This Firefox → Load Temporary Add-on**, and select **`../Style-Inspector-Lite-artifacts/dist/manifest.json`**. A temporary installation lasts until Firefox restarts.

The `manifest.json` in the repository root is a **source file**, not a loadable build. Its generated JavaScript and icons live beside the built manifest in the external `dist` directory. Loading the root manifest can therefore produce a missing icon and a nonfunctional toolbar button. Remove that temporary installation and load the built manifest instead.

The installable package is created one directory above the repository as **`../style-inspector-lite-1.0.2.zip`**. It is **unsigned**, despite having no `-unsigned` filename suffix. It is a review/development artifact; regular Firefox installation requires Mozilla signing. After publication, install through the Mozilla Add-ons listing above or use the signed XPI supplied by the maintainer.

## Features

- **Page audit:** explicitly scan the loaded main document, the initial visible area or a selected section for text contrast and text smaller than 12 CSS pixels. Separate rule summaries show passing results, confirmed failures, results that are not assessable, and cases where the rule does not apply. Results show the chosen scope, elapsed time and any reached scan limits; JSON reports retain this context.
- **Page style overview:** after an audit, open Colors for a palette grouped by use, with optional frequency or hue sorting. Typography lists CSS font-family stacks by measured usage, with each observed CSS font size on its own row and expandable weight/line-height variants. Sizes and variants show the most frequent entries first; use the sorting control for smallest or largest sizes first. Open the compact, highlighted **Show occurrences** control on a color, family, size or variant to locate and inspect its measured elements. A notice identifies an inventory limit only when further distinct entries were omitted. Counts refer to measured text elements, not painted area; font stacks include fallbacks and do not identify the actual rendered font face.
- **Grouped results:** optionally collapse identical audit results into expandable groups, with the original element actions and unchanged totals. Measured contrast, CSS-only comparisons and missing values remain separate.
- **Troubleshooting:** filter missing measurements by their cause. A later inspection of the same text area can be compared with its original audit result and measurement time, without rewriting the earlier result or treating a CSS-only comparison as verified page contrast.
- **Compare manual audits:** compare the current complete audit with the preceding complete audit of the same document and scope. Filter newly observed, resolved, persistent and unassessed findings, with both measurement times and values. Removed or unmeasurable text never counts as a resolved failure.
- **Manage retained analyses:** open the analysis overview in Settings to see retained tabs, their measurement times and approximate analysis sizes. Clear one tab's analysis without clearing other tabs or changing preferences.
- **Element inspection:** inspect via the context menu or an explicit picker. Contrast, colors, typography, and layout share one persistent sidebar. Hover previews remain separate from confirmed selections.
- **Manual contrast:** enter text/background HEX or numeric RGB colors, use the inline color pickers, or send a page-palette color directly to the calculator. Transparent backgrounds require an explicit opaque underlay. The live preview and separate normal/large-text AA/AAA ratings describe this local color comparison.
- **Targeted diagnostics:** enable the diagnostic button in Settings (off by default), then explicitly copy a bounded diagnostic JSON report for an uncertain audit result or selected text area. It includes measurement reasons and sanitized background-layer information for troubleshooting.
- **Contrast suggestions:** compare verified changes to one color at a time. Original and suggested colors have labeled swatches and prominent color codes with individual copy buttons. The suggested color is shown and copied as HEX regardless of the general color-format preference. Suggestions are recommendations; the extension does not apply them to the website.
- **Color vision comparison:** local protanopia, deuteranopia, tritanopia and grayscale previews, alongside original measured colors.
- **Color values:** compact square swatches beside measured colors, suggestions and HEX values in export previews. Transparent colors use a checkerboard; unavailable colors show a question mark. Swatches do not change copied or exported text.
- **Local exports:** CSS, SCSS, structured JSON, and Tailwind CSS v4, with code previews and an optional browser save dialog.
- English by default, complete German interface, and English fallback for other browser languages.

Measured color labels and their individual copy buttons honor the selected format.
HEX uses uppercase six-digit values, or eight digits with alpha, rounded to byte
precision. Hover over a rounded label for its precise RGB value. Measurements,
previews, verified suggestions and code exports retain their original precision;
exports may use RGB when HEX cannot represent the value exactly.

## Requirements

The declared compatibility target is Firefox Desktop **142.0 or later**, with a normal HTTP or HTTPS page loaded for webpage inspection. The manual calculator also works without an inspectable webpage. See the [validation record](internal/VALIDATION.md) for the versions actually verified and current test gaps. Analysis is limited to the main document. Browser-protected pages and frame targets cannot be inspected. Development requires Node.js 22 or later and npm; the recorded build environment is **Windows 24H2 x64, build 26100.9445, with Node.js 22.23.3 and npm 10.9.9**. Compilers and test tools are development dependencies only.

## Getting started

1. Click the extension's toolbar button to open and activate the sidebar. A newly opened sidebar starts on **Page audit** without running a scan or picker. Clicking again keeps an open sidebar open.
2. Choose the audit scope, then **Check page**. Selecting a different scope does not start a measurement. **Visible area** uses the viewport at scan start and does not scroll the page; select an element first to audit its section. Scans yield between small batches, including within large individual text elements, and can be cancelled; partial results and reached limits are marked. Open **Colors** or **Typography** for the palette and CSS font-family overview of that audit scope. Once **Check again** starts successfully, it clears the element selection and temporary analysis views while retaining the preceding complete audit for comparison. If the new scan cannot start, the previous result and selection remain available. A section audit retains its root for an explicit rescan; a removed root requires a new selection.
3. Choose **Select element**, hover a page element, then click to confirm. Escape or **Stop selecting** restores the previous selection. Alternatively, right-click an element and choose **Inspect with Style Inspector** to inspect it directly.
4. Use the four element tabs. Audit results offer **Show on page** and **Inspect**, including uncertain or older results. **Show on page** scrolls to the element and marks it for eight seconds; Escape dismisses the mark. **Inspect** measures only that element. If its result contradicts the audit, the original audit is marked stale; its rows, totals and timestamp stay together until you choose **Check again**. Use **Measure again** to refresh the selected element. Page changes, scrolling, resizing and reopening the sidebar never start another measurement automatically. A removed element is reported instead of choosing a replacement.

Fresh measurements of the same selected element retain the chosen text node,
even if other text nodes move or disappear. If the requested text area is no
longer measured, its contrast is not replaced by the first available area:
choose another area explicitly. These transient identities contain no page text
and do not change the generated references in exported reports. Confirming a new
picker selection explicitly starts with its first available text area; cancelling
preserves the earlier choice. A superseded audit action cannot change that choice.
5. After navigation, reload or switching to another website, choose **Check page** or **Check again** directly in the open sidebar. If needed, Firefox asks for optional website access before starting the requested scan. The toolbar button or enabled context menu can still activate the current document without this optional permission.

The optional website permission covers **all HTTP and HTTPS websites**, not just the current website. Firefox retains the grant until you revoke it in the extension's permissions, so later scans on other websites need no renewed grant. It is requested only from an explicit **Check page** or **Check again** click when document access is missing; declining leaves the toolbar/context-menu workflow available. No website permission is required at installation. Protected browser pages remain inaccessible.

Closing the sidebar ends its picker. Page audits belong to the document and can continue with the sidebar closed. A new document invalidates previous results. Opening the sidebar or navigating never starts analysis automatically; navigation alone does not inject the inspector, even with website access granted.

The picker highlights immediately and waits briefly for the pointer to settle
before measuring a hover preview. Large typography lists show twelve families
or sizes at a time; use **More font families** or **More sizes** for the next
entries and expand a font family's variant list to load its variants. Recent
analyses share a bounded in-memory cache. Older analysis payloads may be released
when the cache fills; explicitly scan that tab again
if its results are no longer available. This cache limit is not a limit on the
browser's total memory usage. Each retained tab can keep the current audit and
one preceding complete audit; the older comparison baseline is released first
when space is tight. The Settings overview reports an estimate of analysis data,
not Firefox's total memory or an exact storage quota measurement. Analysis results
are never written to extension storage. Reloading the page, restarting Firefox
or restarting the extension's background context discards them; start a new
measurement explicitly. Lightweight document authorization metadata may remain
in browser session storage; it contains no measurements. Preferences remain saved.

Audit comparison requires two completed measurements of the same document,
scope and viewport size. Section audits must share the same root; visible-area
audits must also share their initial scroll position. A reload, changed scope,
partial scan or stale current result cannot establish that comparison. Both
snapshots are assessed under the currently selected AA/AAA target. Counts refer
to individual contrast or small-text findings, so one text area can contribute
twice. **New** means newly observed as failing, including newly measurable text;
it does not establish when the problem was introduced. **Resolved** requires a
previous failure and a current measured pass. Removed, hidden or unassessed text
is not proof of a repair. The comparison remains local and does not trigger scans.

**Not assessable** means the automatic check cannot give a reliable verdict. It counts as neither pass nor fail and is not a confirmed problem. Its reason helps you decide what to inspect manually. Contrast results and the small-text readability threshold have separate counts; **Not applicable** is also shown separately.

Contrast values are green when the selected AA/AAA target passes and red when it fails. Each audit finding and the Contrast tab show **AA and AAA separately**, with the applicable text-size thresholds and labelled outcomes. Changing the target changes the value color and audit filters, while both level assessments remain visible. If known CSS colors cannot establish the painted contrast, **CSS color contrast** assesses only that color pair and clearly labels **Page rendering unverified**. These CSS-only comparisons have their own filter. **No values** shows unassessed text contrast with neither a measured ratio nor a CSS color-pair ratio; a displayed gradient minimum is also excluded from this filter. Each audit filter shows its total in parentheses, including results beyond the currently displayed page. All comparisons use the unrounded ratio. Hover over the value for additional precision.

## Settings

The gear opens settings inside the same sidebar. Changes are saved immediately.

| Setting | Default | Effect |
| --- | --- | --- |
| Appearance | System | Follow the browser's light/dark preference, or choose Light/Dark. |
| Color format | HEX | Display/copy supported colors as uppercase HEX, RGB or HSL without changing measurements. |
| Contrast target | AA | Reassess measured contrast at AA or AAA without rescanning. |
| Live selection preview | On | Temporarily show hovered element measurements while selecting. |
| Context menu entry | On | Show or remove the single page inspection menu item. |
| Show diagnostic button | Off | Enable **Copy diagnostics** in audit results and element inspection for troubleshooting. |

**Clear analysis data** requires confirmation and clears this extension's temporary snapshots across sidebars, stopping ongoing analysis and invalidating pending exports. It preserves settings, previously copied text, and files already saved by the user. **Reset settings** requires confirmation and resets only preferences. Browser shortcut assignments and optional permissions remain unchanged.

The retained-analysis overview can be refreshed explicitly and supports clearing
one tab after confirmation. This removes that tab's selected element, current
audit and comparison baseline, and stops its pending analysis. Other tabs remain
available. Tab titles are read only to label this overview; they are not added to
stored analysis or standard exports.

The inspector declares an opening command without assigning a potentially conflicting shortcut. Assign it in Firefox's Add-ons Manager, under the gear menu's **Manage Extension Shortcuts**. The settings page shows the actual assignment.

## Exports

The left footer button copies the current tab's data: a readable audit/contrast report, generated color variables, or curated typography/layout CSS. In the Colors or Typography page overview without an element selection, Copy produces generated page color and font variables, and Export opens the page-values source. Selecting an element restores that element's copy/export scope. Unconfirmed preview values cannot be copied or exported.

The manual calculator accepts `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` and numeric
RGB/RGBA colors. It normalizes values without reducing precision and hides
results for invalid input. A transparent background requires an explicitly chosen
opaque underlay; no page background is guessed. Text alpha is composed over the
resolved background. Page-palette actions retain precise measured channels even
when the palette's displayed HEX value is rounded.
The color picker opens beside each field. Clicking or dragging its saturation/brightness field selects an opaque color, including when starting from black. Hue, saturation and brightness also have keyboard-accessible sliders. Opening a picker leaves the current input unchanged; changing hue from black, white or gray starts a visible saturated color. Escape closes the picker.
Its draft stays in the open sidebar across tabs and webpage navigation; **Clear
data** resets it. **Copy** produces a clearly labeled manual report. File export
is unavailable because these colors are not webpage measurements.
Opening the calculator from a palette preserves the selected element and offers
a return action. Merely viewing a calculated pair does not update audit verdicts.

**Export…** opens an exact, frozen preview. Select an element, scanned page values, or an audit report; choose the scope and format. Original element exports always contain original measurements. **Export suggestion…** explicitly selects a separate, unapplied correction to one color. Viewing recommendations never replaces original data.

| Format | Element | Page values | Audit |
| --- | --- | --- | --- |
| CSS | Generated `.sil-inspected-element` rule | `:root` custom properties | Not available |
| SCSS | Generated Sass variables and rule | Generated Sass variables | Not available |
| JSON | Measured properties and analysis | Palette and CSS font families | Complete structured report |
| Tailwind v4 | Exact arbitrary-property utilities in `.tailwind.txt` | `@theme static` in `.theme.css` | Not available |

Generated names such as `--sil-color-001`, `$sil-color-001`, and `--color-sil-001` are new export names, not recovered source design tokens. CSS dimensions and visual bounding rectangles are distinct. Unsupported or unsafe values are omitted with warnings.

Page-value exports default to the measured Colors/Typography overview, including
placeholder styles and resolved backgrounds. **Palette and font source** can
instead select raw element CSS properties. Both choices use the frozen audit's
scope; overview filters and sorting do not alter token order or export scope.
Overview quick-copy uses measured usage. JSON identifies an explicit choice with
`inventory: "measured"` or `"css"`; existing serializer callers without this option
retain the raw-CSS format.

Large previews show only the first 65,536 UTF-16 units, with a visible shortening
notice and at most 256 decorative color swatches. Copy and Save file retain the
complete export. Unchanged previews preserve keyboard focus and reading position.

For Tailwind v4, copy the complete utility names into a source file scanned by your own Tailwind build. Import the generated theme CSS from your existing v4 stylesheet. The export does not reset your theme. SCSS is compiled by your own Sass build. Neither compiler ships in the extension. See the [export schema and reproducible examples](tests/fixtures/export/README.md).

JSON uses the extension's own `schemaVersion: 2` format, with `kind` equal to `element`, `page-tokens`, `audit`, or `contrast-suggestion`. It is not a DTCG or Figma schema. Suggested changes carry `applied: false`. Internal browser/document IDs, page text excerpts, and webpage input values are not included in standard exports.

After explicitly selecting an element, an **Element text** card at the bottom helps locate it on the page or in its source. Contrast shows the chosen text area's excerpt (up to 500 UTF-16 units); the other element tabs show a combined excerpt (up to 2,000). Whitespace is normalized, combined fragments are separated by spaces, and shortening is indicated. This is DOM text from measured text nodes, so a partially clipped node can include more than its visible ellipsis and CSS text transformations are not reproduced. **Copy text** copies this excerpt separately. Form values, placeholders, editable areas and text-bearing attributes are excluded. Audits and unconfirmed picker previews do not collect excerpts. Excerpts stay in live selection memory and are absent from extension storage, ordinary reports and exports.

The diagnostic button is hidden by default. Enable **Show diagnostic button**
in Settings when troubleshooting. **Copy diagnostics** creates a separate `contrast-diagnostic` JSON report only on
request. It pairs the original measurement and timestamp with currently observed,
bounded paint layers and a separate capture timestamp; it does not perform a new
contrast assessment. Only allowlisted numeric/style values, generic element tags
and summarized effects are included. Page text, HTML, input values, selectors,
IDs, classes, URLs and arbitrary CSS strings are omitted. Reports are copied
locally, never saved in extension session storage or included in standard exports.
Navigation, rescans and superseding selections invalidate pending requests.

Editor text is excluded before reading its contents, including plaintext-only
editors, mixed-case `contenteditable` values, textbox roles and whole-document
editing. Ordinary noneditable text outside editors remains measurable. Copied
contrast reports retain stale and limited-scope notices; audit reports distinguish
running, cancelled and partial scans.

**Save file** asks for the optional `downloads` permission only after an explicit click, then opens Firefox's save dialog. Declining leaves preview and copy usable. The extension creates file contents locally. A started download is not reported as saved until Firefox confirms completion. If copying fails, a selectable text fallback is shown. Leaving its view or changing the export source, scope or format clears that fallback and ignores any late copy response.

## Things to know

- The **12 CSS-pixel** check is a strict `< 12` readability heuristic, not a WCAG minimum font-size rule. A value of 12 passes this project threshold; it does not guarantee readability or accessibility. CSS size is not physical display size, transformed glyph size, or zoom-adjusted size.
- For design guidance, [USWDS recommends at least 16px for most body text and at least 1.5 line height for longer passages](https://designsystem.digital.gov/components/typography/). WCAG separately requires [text resizing to 200%](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) and [support for user-adjusted text spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html) without loss of content or functionality. These are not automatically tested by the small-text heuristic.
- WCAG text contrast uses unrounded sRGB luminance: normal text needs 4.5:1 for AA or 7:1 for AAA; large text needs 3:1 or 4.5:1. Large means at least 24 CSS pixels, or at least `14 * 96 / 72` with a weight of 700 or more (a documented heuristic).
- Absolute OKLab/OKLCH colors are converted to sRGB with full precision using the default display conversion verified in Firefox 142 and 158. Experimental changes to Firefox's gamut-mapping preference are outside this model. These color spaces remain unsupported inside gradients.
- Simple sRGB linear gradients over a known opaque base can establish a conservative **minimum contrast**, marked **≥**. A fully covering opaque gradient excludes hidden background colors when its placement and text coverage can be proved. A target passes only when every color in the calculated background range meets it. A lower bound below AA or AAA remains **Not assessable**, never a failure; it does not identify the exact colors behind the text. Gradient results have no invented flat-color preview or automatic color suggestions.
- Transparent page backgrounds can resolve against Firefox's document canvas color, including the root's light/dark color scheme and custom browser colors. A local element's color scheme does not replace that page surface. Unknown shadow surfaces and top-layer backdrops remain unassessed.
- Uncertain backgrounds, unsupported gradients/images, painted pseudo-elements, overlapping page content, filters, blend modes, group opacity and unsupported color spaces produce **Not assessable** results. Empty pseudo-elements with no painting sources are ignored. A nearer opaque background hides background images painted behind it; ancestor opacity, filters and blending still require caution. An unavailable ratio says **No measurement**, also in copied reports; uncertainty never counts as a pass or failure.
- A `display: contents` element has no box to paint its declared background, so that background is excluded. Supported `-webkit-text-fill-color` values supply the actual glyph color, including inherited fills. A nonzero text stroke remains unassessed because the solid fill alone does not describe the outlined glyph.
- Leading and trailing separators, including metadata bullets, keycaps and single icon-font glyphs, can be excluded when their layout, glyph bounds and spacing establish that they cannot touch the text. Supported cases include single-line inline text, independent block layouts, horizontal flex groups with multiple children and centered half-turn icons whose reflected ink remains separate. Unknown fonts, clipping, reordering, generated text-emphasis marks, complex effects and uncertain positioning remain unassessed. All border edges count when checking whether padding can paint over text. Glyph measurement uses ordinary text transiently with a temporary unattached canvas; form values are never read. The separately requested selection excerpt is described above.
- For an unassessed result with a known foreground and opaque solid background, **CSS color contrast** shows the calculated ratio and, when the text size is known, separate AA/AAA threshold comparisons for that color pair. **Page rendering unverified** remains visible because page overlays and effects are excluded. These comparisons do not change actual page verdicts, findings or suggestion eligibility. The CSS-pair filter shows their count and opens them directly, separately from verified passes and failures. Copied reports distinguish both results; JSON adds a separate `cssColorContrast` field with `verified: false`. Missing colors and gradient ranges receive no substitute flat-color ratio; unknown text size receives no CSS AA/AAA assessment.
- Pointer-transparent labels can sit over a separately painted surface, such as a sibling input. An empty, opaque rectangular background with negative `z-index` can be resolved when it shares the text's stacking context and covers every measured text fragment. Translucent button backgrounds are composed over that surface; unrelated content underneath it does not obscure the text. A covering opaque ancestor can also stop checks of lower hit-test layers when the complete text rectangle, clipping and paint conditions establish coverage. This supports separate hints above empty editable surfaces while retaining uncertainty for actual overlays, typed glyphs and incomplete coverage; editable contents are not read. A floating hint inside the reserved horizontal padding of a sibling text/search input can use its flat background for a **CSS-only** comparison; page rendering remains unverified and input contents are never read. Other uncertain layers retain an unknown background. Offscreen labels in ordinary, undisplaced text flow can use an opaque enclosing background, including a positioned container. Floating or shifted transparent layers, negative margins and text outside the painted box remain unassessed.
- Overlap checks sample actual text fragments. Transparent padding around nearby icons does not count as covering text when their painted contents are outside the text area. Truly empty text nodes, text without any rendered rectangles and fully transparent feedback layers do not alone block measurement; visible feedback paint still does. A zero-size rectangle alone does not prove that text is invisible. Complex painting and exhausted sampling limits remain unassessed; these checks do not reconstruct individual screen pixels.
- Fully clipped text in supported overflow containers is excluded, including hidden wrapped navigation rows and ordinary-flow text inside exactly empty clipping boxes. Positioned carousel text is excluded only when its containing block establishes that the clip applies; horizontal checks can also account for ordinary solid strike-through decoration. Opening a collapsed menu or changing a slide and checking again includes its newly visible text. For supported multiline text, including euro prices and natural wraps after an authored ASCII hyphen, only proven hidden line fragments are removed from measurement; visible lines remain one text run. Single-line `pre-line` labels, such as timestamps, also follow established scroll-container clipping; preserved line breaks and multi-rectangle `pre-line` text remain conservative. Supported legibility rendering and explicit kerning use matching browser text settings. The check includes glyph overhang and rounding margins. Automatic hyphenation, unsupported word-internal breaks and unknown font settings remain conservative. Partially visible text, ordinary content outside the viewport and unsupported layouts remain included. Showing an element can scroll its container; run the audit again to measure the resulting view.
- Visible input placeholders are measured using their own computed color, opacity and font, including Firefox's `color(srgb ...)` colors. They are labeled **Placeholder text**. Input values and placeholder contents are not read or exported. Exact empty and hidden placeholders are skipped; whitespace-only hints remain a limitation of checking without reading text. Populated inputs retain conservative results. Element CSS exports describe the input itself, and placeholder color suggestions are not supported.
- Native button, submit and reset inputs with fully transparent glyph fill and no text effects are excluded as text. Their clickable boxes can still affect an underlying label, so this does not remove overlay uncertainty. Visible fill overrides, faint text, shadows, strokes and other unsupported effects remain in scope.
- Suggestions use a bounded OKLCH lightness search and verify the final quantized sRGB color again. A fixed background may make the chosen target impossible. Background suggestions require an explicitly owned opaque background. When text fill is supported, a foreground correction also resets `-webkit-text-fill-color` to `currentColor`; otherwise a fixed fill could ignore the suggested `color`. This additional declaration is included in the generated correction, including its JSON description. Recommendations address one measured text area and do not guarantee all states or descendant styles.
- Color vision previews use the Machado–Oliveira–Fernandes model at full severity, in linear sRGB, with gamut clipping. Grayscale is a separate luminance comparison. These are approximations, not a prediction of every person's vision. Simulation changes preview surfaces only; it never changes WCAG results, page styles, copied colors or normal exports.
- Visibility checks follow accessible slot assignments for light-DOM text in web components. A focus-only shortcut hidden by an internal wrapper is excluded until revealed. Visible overrides, faint text and supported top-layer exceptions remain included. This does not add text from inside Shadow DOM or resolve arbitrary component backgrounds.
- Collapsed disclosure content is excluded even when the browser retains its layout rectangles. The first summary stays in scope; reopening and rescanning includes the revealed text. Supported author overrides of `::details-content` follow the rendered state.
- Floating search hints can retain their unverified CSS color pair outside the viewport when one immediate input sibling and its reserved padding establish the same pair. This does not certify the page's rendered contrast or read control contents.
- Empty absolute side decorations can be excluded from contrast uncertainty when their resolved paint bounds are proven separate from the text ink. Unknown containing blocks, effects, transformations and actual overlaps remain unassessed.
- Offscreen text in ordinary layout can retain its enclosing opaque background. A legacy `float` declaration on a direct flex/grid item does not invalidate that check, because it does not float the item. Actual floating, displaced or ambiguously slotted text remains conservative.
- Frames, Shadow DOM text, images/canvas and unseen dynamic content are outside the audit scope. Scans inspect rendered main-document content, including offscreen content, without automatic scrolling or loading. An audit stops at 1,000 text runs or 20,000 visited elements and marks incomplete results. Style inventories retain at most 128 colors, 64 CSS font families, and 1,000 distinct sizes and variants per family, associated with at most 1,000 measured elements. Colors and Typography show when their relevant inventory limits actually omit further entries; reports retain these limits separately from overall scan limits. Viewport, scroll or DOM changes mark affected snapshots stale; a change during a scan also marks it partial and stale. Once results are stale, continuous page observation stops until the next explicit measurement. Highlighting does not change results, but scrolling to a result can mark them stale. A conflicting inspection never starts another page audit. Actual uncertainty remains unassessed.
- CSS font families describe the page's declarations, not proven glyph-level rendered fonts. Sidebar font previews use available local fonts and may substitute; web fonts are not downloaded.
- Only preferences use the extension's persistent local storage. Analysis snapshots remain in memory; browser session storage keeps only lightweight document authorization metadata. Optional permission grants are managed separately by Firefox. Live element references retain only the current audit, selection and hover preview; obsolete references are released when analysis is refreshed, cleared or evicted. Reloading a page or moving a tab to another browser window resets its old analysis. There is no backend, account, telemetry, remote code or runtime resource download.
- Selection suppression applies to the event handlers the extension can intercept. A handler already executed by a page before the picker listener cannot be undone.
- This is a focused inspection tool, not a complete accessibility audit or certification.

## Project layout

```text
Style-Inspector-Lite/
  src/core/             Pure measurements, suggestions, simulation, serializers
  src/runtime/          Settings, document identity and DOM measurement
  src/sidebar/          Native sidebar UI
  src/background.ts     Firefox coordination and file downloads
  src/content.ts        Explicit picker and document audit
  _locales/en/, de/      Complete interface catalogs
  assets/               Unchanged approved source logo
  internal/             Build tools, configuration and validation documentation
  tests/                Unit, integration, UI tests and reproducible fixtures
  manifest.json         Source manifest; do not load this file into Firefox
Style-Inspector-Lite-artifacts/
  dist/                 Generated loadable extension; select its manifest.json
  releases/v1.0.2/       Source ZIP, checksums and separate submission documents
  screenshots/en/, de/   Rendered 380 × 800 fixture screenshots
  archive/              Preserved earlier local artifacts
style-inspector-lite-1.0.2.zip  Unsigned installable package beside the repository
```

Test sources and build tools are kept in the source archive and excluded from the installable ZIP. Local maintainer instructions remain outside the repository and are not build dependencies.

## Development and testing

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run lint:extension
npm run test:ui
npm run test:contrast
npm run test:counters
npm run test:paint
npm run test:firefox
npm run test:source
npm run start:firefox
npm run package
```

Install [Node.js](https://nodejs.org/en/download) with its bundled npm, then run the commands from the extracted source directory. Windows 10/11 users can use PowerShell. The source archive also builds from an independently extracted directory outside the original workspace; no private sibling files or repository history are required. `npm ci` installs the exact lockfile dependencies. The local build uses **esbuild 0.28.2** to transpile TypeScript and bundle JavaScript, and **sharp 0.35.5** to produce icons from the included logo. It uses `bundle: true`, `minify: false`, no obfuscation and no webpack. Build output is `../Style-Inspector-Lite-artifacts/dist/`, relative to the extracted source directory; no generated `dist` directory is created inside the repository.

Set `ARTIFACTS_DIR` to an external directory to change the build, screenshot and release-document location. The lint and Firefox-start npm scripts use the same external build location. In a clean reviewer directory, omit this variable to use the default sibling location or set it explicitly to a new external directory. See [the source rebuild instructions](internal/RELEASING.md#reproduce-a-source-build) for the exact environment and commands.

UI tests use Playwright with installed Microsoft Edge by default; set `UI_BROWSER_CHANNEL=chrome` to use installed Chrome. The regular DOM/UI harness uses browser API fakes and real fixture measurements. The Firefox integration test temporarily installs the real extension into an isolated headless Firefox profile. Set `FIREFOX_BINARY` and `GECKODRIVER` to select test binaries. Firefox UI automation requires geckodriver's `--allow-system-access` in that isolated test session. No tests use the owner's browser profile or upload data.

`npm run test:contrast` checks rendered sidebar text, editable field boundaries, SVG controls and keyboard-focus outlines using an independent contrast calculation across English/German, light/dark themes, views and interaction states. It checks the add-on's own interface, excluding page/manual color previews, font previews and native OS dialogs; disabled controls are reported separately. Run it after building. The report is written to `test-results/sidebar-contrast.json`.

`npm run test:source` archives the current source allowlist, installs the lockfile dependencies in a temporary extracted directory, builds and typechecks there, and compares every runtime file's SHA-256 hash against the existing external build. Run it after building. Add `-- --offline --cache /absolute/npm-cache` to use a populated cache without registry access; results are recorded in `test-results/source-rebuild.json`.

`npm run test:counters` checks clipped animated number wheels with the built content script, including visible and partly clipped digits, changing counter values, expansion, preserved whitespace and actual overlays. Add `-- --firefox` to run the same fixtures in Firefox using the test binaries described above. Results are written under the external artifact directory's `test-results/`.

`npm run test:performance` measures synthetic simple, deeply nested and wide pages, hover previews and passive mutation handling. Add `-- --firefox` for Firefox or `-- --firefox --no-counts` for timing without style-call instrumentation. It asserts result counts and absence of automatic remeasurement; timing remains a diagnostic rather than a machine-dependent pass threshold. Reports go to the external artifact directory's `test-results/`. The browser messaging layer is stubbed in this focused test; use the native Firefox harness for complete extension workflows.

`npm run package` creates `../style-inspector-lite-1.0.2.zip` and `../Style-Inspector-Lite-artifacts/releases/v1.0.2/style-inspector-lite-1.0.2-source.zip`. `-- --artifacts /path/to/external-artifacts` changes the external build/source-release destination; `--runtime-dir /path/to/package-directory` changes the directory containing the installable ZIP. The builder validates real paths, rejects destinations inside the repository, and refuses to overwrite existing packages. Both archives reflect the actual working files; no commit is required. Builds do not increment versions or invoke Git/signing/upload commands.

For AMO's question about generated or preprocessed code, answer **Yes** and submit the matching source ZIP. This project transpiles TypeScript, bundles modules and generates icons even though JavaScript minification is disabled. Mozilla requires source and reproducible build instructions for bundled or otherwise preprocessed code. [Source code submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/).

See [VALIDATION.md](internal/VALIDATION.md) for actual results and [RELEASING.md](internal/RELEASING.md) for clean builds, manual Firefox checks, and the separate publication handoff. Local validation is not Mozilla review, signing, or publication.
