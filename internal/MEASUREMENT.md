# Measurement model and limitations

This document records the detailed behavior and limits of Style Inspector Lite's measurements. Start with the [README](../README.md) for installation and ordinary use. The [validation record](VALIDATION.md) identifies the browser versions and cases actually tested; supported patterns do not guarantee every layout on every website.

## Scope and scan limits

- Frames, Shadow DOM text, images/canvas and unseen dynamic content are outside the audit scope. Scans inspect rendered main-document content, including offscreen content, without automatic scrolling or loading. An audit stops at 1,000 text runs or 20,000 visited elements and marks incomplete results. Style inventories retain at most 128 colors, 64 CSS font families, and 1,000 distinct sizes and variants per family, associated with at most 1,000 measured elements. Colors and Typography show when their relevant inventory limits actually omit further entries; reports retain these limits separately from overall scan limits. Viewport, scroll or DOM changes mark affected snapshots stale; a change during a scan also marks it partial and stale. Once results are stale, continuous page observation stops until the next explicit measurement. Highlighting does not change results, but scrolling to a result can mark them stale. A conflicting inspection never starts another page audit. Actual uncertainty remains unassessed.

- This is a focused inspection tool, not a complete accessibility audit or certification.

## Text size, typography and thresholds

- The **12 CSS-pixel** check is a strict `< 12` readability heuristic, not a WCAG minimum font-size rule. A value of 12 passes this project threshold; it does not guarantee readability or accessibility. CSS size is not physical display size, transformed glyph size, or zoom-adjusted size.

- For design guidance, [USWDS recommends at least 16px for most body text and at least 1.5 line height for longer passages](https://designsystem.digital.gov/components/typography/). WCAG separately requires [text resizing to 200%](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) and [support for user-adjusted text spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html) without loss of content or functionality. These are not automatically tested by the small-text heuristic.

- WCAG text contrast uses unrounded sRGB luminance: normal text needs 4.5:1 for AA or 7:1 for AAA; large text needs 3:1 or 4.5:1. Large means at least 24 CSS pixels, or at least `14 * 96 / 72` with a weight of 700 or more (a documented heuristic).

- CSS font families describe the page's declarations, not proven glyph-level rendered fonts. Sidebar font previews use available local fonts and may substitute; web fonts are not downloaded.

## Colors, contrast and uncertainty

- Absolute OKLab/OKLCH colors are converted to sRGB with full precision using the default display conversion verified in Firefox 142 and 158. Experimental changes to Firefox's gamut-mapping preference are outside this model. These color spaces remain unsupported inside gradients.

- Simple sRGB linear gradients over a known opaque base can establish a conservative **minimum contrast**, marked **≥**. A fully covering opaque gradient excludes hidden background colors when its placement and text coverage can be proved. A target passes only when every color in the calculated background range meets it. A lower bound below AA or AAA remains **Not assessable**, never a failure; it does not identify the exact colors behind the text. Gradient results have no invented flat-color preview or automatic color suggestions.

- Transparent page backgrounds can resolve against Firefox's document canvas color, including the root's light/dark color scheme and custom browser colors. A local element's color scheme does not replace that page surface. Unknown shadow surfaces and top-layer backdrops remain unassessed.

- Uncertain backgrounds, unsupported gradients/images, painted pseudo-elements, overlapping page content, filters, blend modes, group opacity and unsupported color spaces produce **Not assessable** results. Empty pseudo-elements with no painting sources are ignored. A nearer opaque background hides background images painted behind it; ancestor opacity, filters and blending still require caution. An unavailable ratio says **No measurement**, also in copied reports; uncertainty never counts as a pass or failure.

- A `display: contents` element has no box to paint its declared background, so that background is excluded. Supported `-webkit-text-fill-color` values supply the actual glyph color, including inherited fills. A nonzero text stroke remains unassessed because the solid fill alone does not describe the outlined glyph.

- For an unassessed result with a known foreground and opaque solid background, **CSS color contrast** shows the calculated ratio and, when the text size is known, separate AA/AAA threshold comparisons for that color pair. **Page rendering unverified** remains visible because page overlays and effects are excluded. These comparisons do not change actual page verdicts, findings or suggestion eligibility. The CSS-pair filter shows their count and opens them directly, separately from verified passes and failures. Copied reports distinguish both results; JSON adds a separate `cssColorContrast` field with `verified: false`. Missing colors and gradient ranges receive no substitute flat-color ratio; unknown text size receives no CSS AA/AAA assessment.

## Paint coverage and overlapping layers

- Pointer-transparent labels can sit over a separately painted surface, such as a sibling input. An empty, opaque rectangular background with negative `z-index` can be resolved when it shares the text's stacking context and covers every measured text fragment. Translucent button backgrounds are composed over that surface; unrelated content underneath it does not obscure the text. A covering opaque ancestor can also stop checks of lower hit-test layers when the complete text rectangle, clipping and paint conditions establish coverage. This supports separate hints above empty editable surfaces while retaining uncertainty for actual overlays, typed glyphs and incomplete coverage; editable contents are not read. A floating hint inside the reserved horizontal padding of a sibling text/search input can use its flat background for a **CSS-only** comparison; page rendering remains unverified and input contents are never read. Other uncertain layers retain an unknown background. Offscreen labels in ordinary, undisplaced text flow can use an opaque enclosing background, including a positioned container. When geometry proves that a painted layer does not cover the text, that layer can be skipped and the actual background underneath can be resolved. This includes text outside a painted background box when the underlying surface is known. Partial or uncertain coverage, unclear clipping, floating or shifted transparent layers and negative margins remain conservative.

- Overlap checks sample actual text fragments. Transparent padding around nearby icons does not count as covering text when their painted contents are outside the text area. Truly empty text nodes, text without any rendered rectangles and fully transparent feedback layers do not alone block measurement; visible feedback paint still does. A zero-size rectangle alone does not prove that text is invisible. Complex painting and exhausted sampling limits remain unassessed; these checks do not reconstruct individual screen pixels.

- Leading and trailing separators, including metadata bullets, keycaps and single icon-font glyphs, can be excluded when their layout, glyph bounds and spacing establish that they cannot touch the text. Supported cases include single-line inline text, independent block layouts, horizontal flex groups with multiple children and centered half-turn icons whose reflected ink remains separate. Unknown fonts, clipping, reordering, generated text-emphasis marks, complex effects and uncertain positioning remain unassessed. All border edges count when checking whether padding can paint over text. Glyph measurement uses ordinary text transiently with a temporary unattached canvas; form values are never read. The separately requested [selection excerpt](../README.md#exports) is described in the README.

- Empty absolute side decorations can be excluded from contrast uncertainty when their resolved paint bounds are proven separate from the text ink. Unknown containing blocks, effects, transformations and actual overlaps remain unassessed.

- Offscreen text in ordinary layout can retain its enclosing opaque background. A legacy `float` declaration on a direct flex/grid item does not invalidate that check, because it does not float the item. Actual floating, displaced or ambiguously slotted text remains conservative.

- Floating search hints can retain their unverified CSS color pair outside the viewport when one immediate input sibling and its reserved padding establish the same pair. This does not certify the page's rendered contrast or read control contents.

## Clipping, visibility and form controls

- Fully clipped text in supported overflow containers is excluded, including hidden wrapped navigation rows and ordinary-flow text inside exactly empty clipping boxes. Positioned carousel text is excluded only when its containing block establishes that the clip applies; horizontal checks can also account for ordinary solid strike-through decoration. Opening a collapsed menu or changing a slide and checking again includes its newly visible text. For supported multiline text, including euro prices and natural wraps after an authored ASCII hyphen, only proven hidden line fragments are removed from measurement; visible lines remain one text run. Single-line `pre-line` labels, such as timestamps, also follow established scroll-container clipping; preserved line breaks and multi-rectangle `pre-line` text remain conservative. Supported legibility rendering and explicit kerning use matching browser text settings. The check includes glyph overhang and rounding margins. Automatic hyphenation, unsupported word-internal breaks and unknown font settings remain conservative. Partially visible text, ordinary content outside the viewport and unsupported layouts remain included. Showing an element can scroll its container; run the audit again to measure the resulting view.

- Visibility checks follow accessible slot assignments for light-DOM text in web components. A focus-only shortcut hidden by an internal wrapper is excluded until revealed. Visible overrides, faint text and supported top-layer exceptions remain included. This does not add text from inside Shadow DOM or resolve arbitrary component backgrounds.

- Collapsed disclosure content is excluded even when the browser retains its layout rectangles. The first summary stays in scope; reopening and rescanning includes the revealed text. Supported author overrides of `::details-content` follow the rendered state.

- Visible input placeholders are measured using their own computed color, opacity and font, including Firefox's `color(srgb ...)` colors. They are labeled **Placeholder text**. Input values and placeholder contents are not read or exported. Exact empty and hidden placeholders are skipped; whitespace-only hints remain a limitation of checking without reading text. Populated inputs retain conservative results. Element CSS exports describe the input itself, and placeholder color suggestions are not supported.

- Native button, submit and reset inputs with fully transparent glyph fill and no text effects are excluded as text. Their clickable boxes can still affect an underlying label, so this does not remove overlay uncertainty. Visible fill overrides, faint text, shadows, strokes and other unsupported effects remain in scope.

## Suggestions and color vision previews

- Suggestions use a bounded OKLCH lightness search and verify the final quantized sRGB color again. A fixed background may make the chosen target impossible. Background suggestions require an explicitly owned opaque background. When text fill is supported, a foreground correction also resets `-webkit-text-fill-color` to `currentColor`; otherwise a fixed fill could ignore the suggested `color`. This additional declaration is included in the generated correction, including its JSON description. Recommendations address one measured text area and do not guarantee all states or descendant styles.

- Color vision previews use the Machado–Oliveira–Fernandes model at full severity, in linear sRGB, with gamut clipping. Grayscale is a separate luminance comparison. These are approximations, not a prediction of every person's vision. Simulation changes preview surfaces only; it never changes WCAG results, page styles, copied colors or normal exports.

## Analysis lifetime, privacy and page interaction

- Only preferences use the extension's persistent local storage. Analysis snapshots remain in memory; browser session storage keeps only lightweight document authorization metadata. Optional permission grants are managed separately by Firefox. Live element references retain only the current audit, selection and hover preview; obsolete references are released when analysis is refreshed, cleared or evicted. Reloading a page or moving a tab to another browser window resets its old analysis. There is no backend, account, telemetry, remote code or runtime resource download.

- Selection suppression applies to the event handlers the extension can intercept. A handler already executed by a page before the picker listener cannot be undone.
