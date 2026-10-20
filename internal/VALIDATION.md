# Local validation record

Recorded on 2026-10-20 for the prepared initial release **1.0.1** (unpublished).
The source is the working tree, with no commit provenance asserted. Results apply
to this local implementation; subsequent runtime changes require relevant checks
again. This record is not Mozilla review, signing,
publication, or a complete accessibility assessment.

The transparent-document follow-up resolves the browser's document canvas color
when the CSS background chain reaches the top-level HTML root without an opaque
surface. A short-lived, hidden CSS `Canvas` probe uses the root's color scheme;
it does not assume white or use an element's local scheme. Same-batch reuse
avoids a probe for each text run, and later measurements refresh browser colors.
Owned probe mutations do not invalidate the audit. Unknown shadow surfaces and
top-layer backdrops remain unresolved, and existing image/effect/overlap checks
remain in force.

All 263 unit/integration tests, type checking, build and extension lint pass
(zero lint errors, warnings or notices). The complete sidebar/DOM harness passes.
Eight additional browser groups pass on Firefox 142, Firefox 158 and Edge 155,
using the built content script and a controlled messaging harness. They compare
the measured canvas with independent screenshot pixels, including root light/dark
schemes, an opposing local scheme, alpha composition, gradients, explicit paint,
custom Firefox colors, forced colors, uncertain overlays, slotted text and
transparent modal/popover backdrops. They also verify audit/inspection agreement,
probe cleanup and audit freshness. The reconstructed black-on-white navigation
returns 21:1 in both audit and inspection.
An isolated offline source rebuild produces all 15 runtime files byte-identically.

Kickstarter's supplied export has opaque black text, a transparent CSS background
and `unresolved-background`. Its live page blocked automated access, so these
checks establish the general missing-canvas correction, not that every one of
the reported 289 entries has the same cause. The corrected build is included in
the initial 1.0.1 handoff; preceding artifacts are preserved locally. Earlier
validation below records preceding changes and is not a claim that every older
check was repeated for this update.

The final edge-case review corrects backgrounds declared on boxless
`display: contents` elements and measures the actual supported glyph fill,
including inherited `-webkit-text-fill-color`. Native tests prove the previous
false passes become the expected failures. Outlined text retains a manual
assessment with a specific reason. Editor text is excluded before content reads,
including plaintext-only, mixed-case editable declarations, semantic textbox
roles and designMode; ordinary noneditable text outside editors remains in scope.

Firefox resolves fixed fill and `currentColor` to the same computed value when
their colors coincide. A separate reproduction proved that a plain `color`
suggestion was ineffective for fixed inline, inherited and stylesheet fills.
Foreground correction exports now explicitly reset the fill to `currentColor`.
The reset is derived from the measured run, included in CSS/SCSS/Tailwind and
JSON's additional declarations, and explained in the suggestion card. Original
style exports remain original measurements.

Completed follow-up audits also detect disappeared or replaced descendant text
that belonged to the preceding scan. Unknown owners and bounded or incomplete
inventories do not imply missing text. A native delayed-batch reproduction now
marks the audit and container selection stale instead of presenting them as fresh.
Pending audit selections and late errors cannot overwrite a newer picker or
context selection. Explicit same-element picker confirmation starts with a valid
current run, while cancellation preserves the previous choice. Copied contrast
and audit reports preserve stale, scope and scan-status qualifications.

All 256 unit/integration tests, type checking, build and extension lint pass,
with zero lint errors, warnings or notices. Firefox 142 and 158 each pass all
45 native groups. Separate Firefox 142.0.1 and 158 probes pass 10 paint/privacy
assertions and 36 fill-correction checks each (nine cases across four export
formats). The DOM harness and complete English/German behavior suite pass.
Interface contrast covers 1,344 states, 13,988 text measurements and 9,832
non-text measurements, with no failures.

An existing offscreen fixture now expects the missing-background reason as well
as layering uncertainty after discarding its nonpainting contents background.
A native rescan assertion could read the old nine-run audit before the new
ten-run report arrived; it now uses the existing bounded count-wait helper.
The final rerun passes, and the original failure logs remain outside the source
archive. These test corrections do not relax the expected contrast outcomes.
The private WhatsApp paint state described below remains unverified; this
review does not claim that its exact missing-background cause was reproduced.

The preceding measurement-consistency update preserves a selected text area across
fresh measurements and detects contradictions introduced by a later audit batch.
Text-run identities follow actual Text objects and their owners through a weak
registry, instead of reusing visible ordinals after insertion or removal. Moving
or replacing a node cannot silently substitute another run. Missing requested
areas show an explicit notice and require the user to choose another area.
Optional excerpt capture and text-free exports retain their existing scope.

At audit completion, contradictory paint inputs or a disappeared direct run
mark the audit partial/stale and the earlier selection stale. Unchanged scans
still complete normally; cancelled, superseded and incomplete inventories do not
invent missing measurements. No retry-until-pass loop or forced ratio is added.
Native tests distinguish an edit to the same Text node from replacement by a new
node; the latter now deliberately requires explicit choice.

All 247 unit/integration tests, type checking, build and extension lint pass
(zero lint errors, warnings or notices). The English/German UI suite covers
passive refresh, missing audit requests and explicit recovery. The interface
contrast run covers 1,344 states, 13,988 text measurements and 9,832 non-text
measurements, with zero failures. Firefox 142 and 158 each pass all 44 native
groups, including same-node text updates and explicit recovery after replacement.
The earlier native waits expected automatic adoption of a replacement node;
the updated assertions test the intended distinction. Failure logs are retained
with the external diagnostic evidence.

A local reconstruction uses the supplied WhatsApp class structure, cached public
CSS and font, and synthetic text in Firefox 142 and 158. Stable visible,
pointer-transparent, scrolled and offscreen cases give the same
7.046327883257104:1 in audit and inspection; both exclude the fully clipped case.
An intentionally changed overlay between audit batches
reproduces the earlier fresh-but-conflicting result; it now produces a partial,
stale audit. This demonstrates the lifecycle correction, not the cause of the
owner's initial missing background. The private WhatsApp session and its exact
paint state remain unverified. Public CSS/fonts and diagnostic outputs are kept
outside both release archives.

The preceding broad review corrects several independently reproduced lifecycle
and UI edge cases. Delayed context-menu captures and successful or failed
handshake replies can no longer replace a newer picker, selection or audit.
Background record revisions cover accepted content events as well as requests.
Legitimate unchanged handshakes continue to restore analysis normally.

A contradictory measurement of already-scanned text during a running audit now
marks that audit partial and stale. Explicit selection, reconnect measurements
and resize measurements are covered; none queues another scan. Showing a result
while picking now sends the matching picker-cancel event. Moving a tab between
browser windows resets its prior analysis and pending work. The global epoch
remains monotonic, old-window commands are rejected, and only the exact fresh
context-menu capture survives a same-epoch window reassignment.

Live element references are limited to current audit, selection and preview
snapshots; disconnected and obsolete nodes are released without reusing IDs.
An automatic scan temporarily retains at most 1,000 prior audit references so
unchanged elements keep their IDs, then releases unused references at completion
or cancellation. The first implementation pruned those references too early;
the existing DOM test caught that regression. The corrected lifecycle test also
covers intervening hover previews and cancellation.

Clipboard fallback text and pending copy callbacks are invalidated when leaving
their view or changing export source, scope or format, including a return to the
original controls. Invalid stored preference arrays and objects now fall back
to valid enum defaults rather than being accepted through string coercion.
These changes do not alter color math, page-contrast verdicts, permission scope,
export schemas, translations or UI styling.

All 241 unit/integration tests, type checking, build and extension lint pass;
lint reports zero errors, warnings and notices. Firefox 142 and 158 each pass
all 44 native groups. The DOM/sidebar harness and English/German behavior suite
pass, including the new clipboard checks and existing frozen-export checks.
An intermittent overflow fixture failure was traced to a queued native scroll
event; the test now waits for that actual event before starting its scan.

The fresh interface contrast run covers 1,344 states, 13,988 text measurements
and 9,832 non-text measurements, with zero failures. Lowest enabled text ratios
are 5.399:1 in light mode and 5.551:1 in dark mode; checked control/focus graphics
have minima of 3.363:1 and 4.460:1. Page color samples, decorative surfaces,
disabled controls and native operating-system dialogs retain their documented
exclusions. The UI bundle stayed byte-identical after the final content-only
registry correction. Packaging preserves the preceding local handoff and checks
the isolated source rebuild, archive allowlists, checksums and AMO field limits.
These tests use isolated profiles and synthetic fixtures, not private sessions.

The preceding update reconciles a fresh explicit element measurement with an older
page audit. Previously, a conflict only marked the audit stale while retaining
its old rows. The supplied WhatsApp export confirms a later 17.210166562311272:1
measurement; it does not contain the earlier audit's page geometry or paint.
Audit and inspection already share the same measurement functions. Scrolling,
hover, CSSOM changes and other page updates can change their inputs between
measurements, so this update addresses the general snapshot inconsistency rather
than claiming to reproduce the private page's earlier state.

A conflicting confirmed selection now starts one complete audit at the current
page state. It retains the selected element, its request and the existing live
element references, while rebuilding all runs, counts, palette, font inventory
and measurement time. There is no merge by ordinal text-run ID and no promotion
of uncertain colors to a verified result. Conflicts involving a newly failing
or uncertain result trigger the same behavior as a newly passing result.
An already-stale completed or partial audit can be refreshed this way too.

Unchanged inspections, target-only changes, hover previews, reconnect handshakes
and automatic resize measurements do not restart scans. An active or cancelled
audit is not restarted by inspection. There is no queued retry or loop until a
result passes. Manual rescan still clears selection and retires references.
Clear-data, newer epochs, navigation and a new manual scan invalidate obsolete
work. Scrolling during any scan marks that scan partial and stale; completed
scans remain snapshots until a new measurement is requested.

All 226 unit/integration tests, type checking, build and extension lint pass.
The new lifecycle tests cover both result directions, complete inventory rebuild,
selection preservation, cancellation, overlapping work, passive measurements,
navigation, queued mutations, scan limits and scroll changes. Independent review
found no remaining event-ordering or lifecycle issue. No geometry, color math,
permission, export-schema or UI styling changes are included in this update.

Firefox 142 and 158 each pass all 44 native groups. Conflicting CSSOM-only
inspection refreshes the whole page, including newly visible unrelated text and
a separately changed failing contrast. Returning to Contrast retains the same
selection and excerpt; subsequent pass-to-uncertain and uncertain-to-fail changes
update the audit too. An explicit manual rescan still clears the selection.

The DOM/sidebar harness checks fresh timestamps, complete font/palette replacement,
retained request and element references, no repeat loops, cancelled audits and
an immediately superseding manual scan. Its initial new hover test exposed a
missing getUILanguage API in the browser mock; the mock is completed and command
success is asserted rather than suppressing the preview check. UI runtime files
are unchanged. Packaging preserves the preceding handoff, verifies the isolated
source rebuild and checks all AMO fields against their character limits.

The preceding update fixes background traversal for pointer-transparent labels over
empty editable fields. The supplied WhatsApp structure renders its hint as a
separate absolutely positioned element. Empty editable DIV/P/BR content was
already ignored correctly; the failure occurs when hit testing continues past
an opaque ancestor and reaches an unrelated painted surface behind that ancestor.

Traversal now stops only when the ancestor fully covers the original text
fragment with an opaque background. Conservative checks include borders, rounded
corners, viewport and scrollport coverage, scrollbar dimensions, intermediate
colors, stacking, clipping and paint effects. This does not invent a background
color or change unresolved results into CSS-only comparisons. Real earlier
overlays, typed glyph geometry, independently painted editors, translucency and
incomplete coverage remain unassessed. No editable text or form value is read.
See the [CSS painting order](https://www.w3.org/TR/CSS22/zindex.html#painting-order).

The independent reproduction uses the supplied subtree, public WhatsApp CSS/font
and synthetic text in Firefox 142 and 158. Its outer background and unrelated
lower surface are modeled, not measurements of the private messaging session.
The formerly failing lower-surface case now agrees between audit and inspection
at 6.4007252631758575:1 for the synthetic color pair. Empty, focused and empty-text-
node cases retain that value; typed text, whitespace, editor backgrounds and
inset shadows retain their manual results. Before/after source hashes and public
asset hashes are recorded outside the packages. The live user session was not
accessed or independently verified.

All 218 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 44 native groups. The new group checks matching
audit/inspection values, AA pass and AAA fail, focus, lower-layer color changes,
private-text getter traps, genuine overlays, translucency and incomplete coverage.
Initial test runs needed corrections to the expected decimal formatting and to
wait for the actual contrast tab after asynchronous inspection; runtime timing
and number formatting were unchanged. The sidebar DOM harness passes. UI runtime
files are unchanged. The previous handoff is archived before replacement;
package verification checks source rebuilding and AMO field limits.

The preceding update applies existing overflow clipping checks to single-line
`white-space: pre-line` text. The supplied timestamp structure and the public
WhatsApp stylesheet identify a visible inline timestamp with this whitespace
mode, inside relatively positioned, floated metadata with negative margins.
A separate `visibility: hidden` copy reserves layout space and was already
excluded correctly. In a modeled inner scroll area, the formerly retained hidden
timestamp samples a separate surface and reports `layered-background`; scrolling
it into view produces 4.6467297950363164:1. Audit and inspection use the same
measurement path and agree at the same scroll position.

Only one positive Range rectangle with no CR, LF or form feed is newly
supported. Existing font, shaping, Canvas advance, glyph overhang, clipping and
rounding checks are unchanged. Preserved breaks, multiple rectangles, unsupported
controls and uncertain metrics remain conservative. This avoids collapsing
preserved line breaks into spaces during the local glyph proof. See the
[CSS whitespace processing rules](https://www.w3.org/TR/css-text-3/#white-space-processing).

Both Firefox 142 and 158 reproduce the original failure using the supplied
timestamp subtree, publicly served CSS/font and synthetic message text. The
outer scroll area is modeled; the private messaging session was not accessed.
The final-source reproduction excludes the clipped timestamp, retains it at
4.65:1 when visible, and excludes it again after scrolling back. The hidden
layout duplicate remains excluded throughout.

All 213 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 43 native groups, including the new scrolling
timestamp fixture: visible and ordinary offscreen text remain in scope, selected
timestamps show AA pass and AAA fail, real overlays remain unassessed, and
removing clipping restores the previously hidden text. The sidebar DOM harness
passes. UI runtime files are unchanged. The previous handoff is archived before
replacement; package verification checks source rebuilding and AMO field limits.

The preceding update preserves overflow clipping checks for legibility rendering
and explicitly enabled kerning. The public WhatsApp Web stylesheet sets
`text-rendering: optimizeLegibility` and `font-feature-settings: "kern"` on the
body. Together with its publicly served Roboto Variable font, these rules
reproduce twelve synthetic preview text runs: runs three and four have an
unresolved background, while later hidden runs fall outside the viewport and
retain a misleading ordinary background result. The visibility helper formerly
rejected both font settings before proving which text was actually clipped.

The fix mirrors supported text rendering and kerning in the native Canvas
measurement, checking property support and successful assignment before using
its metrics. Lowercase computed CSS rendering values are mapped to the Canvas
enum. Only normal features or an enabled `kern` feature are supported; feature
lists, disabled/conflicting kerning, unsupported rendering modes and all previous
font, shaping, paint and ink-boundary uncertainties remain conservative.
No glyph tolerance is increased and no unknown background is promoted to a pass.
See the [Canvas rendering property](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/textRendering)
and [font feature precedence](https://www.w3.org/TR/css-fonts-4/#feature-precedence).

The public font and stylesheet are diagnostic inputs kept outside both packages;
repository fixtures contain synthetic text and use a system font. No private
messaging session or account was accessed. The actual user's live session remains
unverified, but the observed public font rules and the reported 3/4 failure pattern
are reproduced in both supported Firefox test versions.

All 210 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 42 native groups. The new group checks two visible
sections at 7.05:1 in both audit and inspection, including the partially visible
second section; real overlays remain uncertain. Unknown feature lists and
conflicting kerning retain their candidates, while expanding the preview restores
all twelve now-visible sections. Tooltip attributes do not add text runs.
One initial Firefox 142 run reached a rescan before its sidebar action was ready;
the existing empty-overflow test now waits for that action before asserting its
synchronous reset. The repeated run passes. No runtime timing was changed.

The final-source probe uses the public WhatsApp font with no source substitutions.
Both Firefox versions reduce the twelve-node reproduction to two visible passes
at 7.046327883257104:1. The tested kerning/ligature matrix has zero DOM/Canvas
width difference, while disabled conflicting kerning and unknown features remain
unsupported by the product. The DOM/sidebar harness passes. UI runtime files
are unchanged; package verification retains prior contrast evidence, preserves
the previous handoff and checks the independent source rebuild and AMO limits.

The preceding update handles natural line breaks immediately after an authored
ASCII hyphen in clipped multiline text. A synthetic 112-by-44-pixel product
title reproduces the reported unresolved-background symptom in Firefox 142
and 158: a break after `Over-` formerly caused all seven Range fragments to
remain, including five hidden lines whose sample points hit the next tile.
Replacing hyphens with spaces already allowed the two visible lines to be
measured. The new boundary rule retains the existing exact Range matching,
Canvas advance/ink checks, loaded-font requirements and rounding guards.
It does not change text-node boundaries or relax checks for arbitrary word
breaks, Unicode/soft hyphens, automatic hyphenation or paint effects.

The Google export has `layered-background`, but the supplied HTML contains no
relevant stylesheet rules. Google blocked the isolated public-page request.
Therefore the local reproduction and correction are confirmed; their match to
the user's current Google card remains unverified. No advertising links were
followed. Diagnostic scripts and supplied HTML remain outside both packages.

All 206 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 41 native groups. The new group covers natural
hyphen breaks in visible and hidden lines, fixed-height and line-clamped titles,
transparent click targets, real overlays, automatic hyphenation, revealed
overflow and expansion. Audit and inspection agree at 10.43:1
for the synthetic #99C3FF-on-#111111 pair. The standalone before/after probe
confirms seven raw fragments become two measured visible fragments, while
ordinary space-separated titles retain their existing result. The DOM/sidebar
harness passes. UI runtime assets are unchanged; packaging verification covers
the preserved prior handoff, AMO field limits and an independent source rebuild.

The preceding update preserves CSS-only comparisons for offscreen floating search
hints. On the public Geizhals product URL ending in `#reports`, the search header
is outside the viewport when the audit starts. The former offscreen guard
returned an unresolved background without trying the existing sibling-input
CSS fallback. Inspecting the same hint after scrolling to the top then yielded
7.058440424184376:1, while the earlier audit still had no numeric comparison.

The new fallback requires exactly one immediate input sibling among at most
32 children, no ambiguous slot/shadow relationship, and the existing strict
opaque-input/padding/geometry checks. Every text fragment must fit the same
reserved input padding; truncated geometry cannot produce a pair. No control
value or placeholder text is read. Actual paint order is still unknown, so
`layered-background`, the manual page verdict and its null contrast ratio are
preserved. Only the separate CSS-pair result gains the available value.

The live Firefox 158 probe now yields 7.058440424184376:1, CSS AA/AAA passes and
`verified:false` in audit and inspection for anchor entry, inspection at the
top, a fresh top audit and another anchor-position audit. These entries therefore
belong to the CSS-pair filter, not the No measurement filter. This does not remove
the page scan limit or resolve unrelated page effects. Diagnostic files remain
outside both packages.

All 203 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 40 native groups. The new group checks both
viewports, audit/inspection agreement, filter membership, second-input ambiguity
and private control-content exclusion. Unit tests additionally cover the bounded
lookup, slot/shadow ambiguity, all-fragment coverage and limited geometry. The
DOM/sidebar harness passes. Unchanged UI assets retain prior contrast evidence;
release verification covers archive preservation, AMO limits and an independent
source rebuild matching all 15 runtime files.

The preceding update excludes collapsed disclosure contents whose positive layout
rectangles previously produced false unresolved-background findings. On the
public Geizhals product page, all three supplied styles match price, offer-link
and merchant-caption elements in a closed additional-offers list. The same
ordinary visible offers already yielded measured contrast. Firefox retains
element and text Range rectangles inside closed `details`, but hit testing
returns the neighboring visible offer instead.

Native `checkVisibility()` uses its default options, keeping ordinary offscreen
and `content-visibility:auto` text in scope. Direct text and boxless descendants
also check the disclosure's content wrapper while preserving the first direct
HTML summary. Firefox 158 author overrides on `::details-content` are respected;
boxless and non-replaced inline wrappers do not hide text merely through
`content-visibility:hidden`. Firefox 142 uses the native open state where this
pseudo is unsupported. Nested and slotted light-DOM contents follow the same
rendered ancestry; the scan does not add internal shadow text to its inventory.
See the [HTML rendering rules](https://html.spec.whatwg.org/multipage/rendering.html#the-details-and-summary-elements)
and [native visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility).

In comparable Firefox 158 live-page probes with closed additional-offer groups,
the former partial scan reached its 1000-run limit with 41 unassessed entries;
the corrected scan completed with 964 runs and 5 unassessed entries.
The recorded other outcomes stayed at 937 contrast passes and 22 failures. These counts
describe this public snapshot, not a guarantee for changing offers or consent
states. Live diagnostics remain outside both packages.

Expanded offer lists also have an empty absolute side stripe. A new bounded
proof compares its reconciled pixel insets and border-box width against measured
text ink, with rounding guards. The ordinary owner padding box must be known;
transforms, effects, ambiguous slots, special controls, unknown alignment and
changed disclosure containing blocks remain conservative. Firefox 158 exposes
the normal disclosure wrapper needed for this proof; Firefox 142 does not and
retains the existing CSS-pair/unchecked result for this decorative DETAILS case.
Actual overlap still prevents a trusted contrast verdict.

The three previously hidden live targets, when expanded, now produce
11.9119003721186:1 (price), 14.6325351726001:1 (offer button) and
10.4091841299395:1 (merchant caption), all AA/AAA passes. Reclosing excludes the
targets again. Existing visible offers retain their audit and selection values.

All 201 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 39 native groups, including disclosure state
changes, direct/boxless/slotted text, supported pseudo overrides, ordinary
offscreen text, both side stripes, bordered/padded owners and actual overlays.
Independent native pixel probes verify stripe positions and conservative
positioned/transformed disclosure wrappers. The DOM/sidebar harness passes.
UI assets are unchanged; prior light/dark contrast evidence is retained.
Release verification checks archive preservation, ZIP content, AMO field limits
and an independent source rebuild producing the same 15 runtime files.

The preceding update fixes an offscreen background guard for direct flex/grid items
with legacy float declarations. On the public Amazon homepage, the logo suffix
uses `float:left` and `pointer-events:none` inside a flex link. Firefox preserves
the declared float in computed style, although it does not float the flex item.
The guard incorrectly rejected its enclosing dark background after scrolling.
A subsequent inspection after returning to the top reported 17.666316631442516:1
while the earlier audit retained an unresolved layered background.

The exception requires an immediate HTML flex/inline-flex/grid/inline-grid
parent without shadow-tree or slot ambiguity. Existing position, offset, margin,
transform, zoom and full opaque-background containment checks remain in force.
Real floats and displaced text are still conservative. This matches the
[flex-item rules](https://www.w3.org/TR/css-flexbox-1/#flex-items) and
[grid-item rules](https://www.w3.org/TR/css-grid-1/#grid-items).

The corrected public-page probe gives the same 17.666316631442516:1 AA/AAA pass
in the audit and selection, before/after scrolling and with/without hover. The
additional supplied Prime class produces the same result in the isolated test;
no signed-in Amazon session was used. The earlier audit's stale marker after a
scroll remains intentional. Live diagnostic captures stay outside both ZIPs.

All 193 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 37 native groups. The new group covers eight
direct flex/grid and left/right-float combinations both inside and outside the
viewport, eleven conservative geometry/parent exceptions, and real overlay
removal. The DOM/sidebar harness passes; unchanged UI assets retain the prior
light/dark contrast evidence. Release verification checks the archived prior
handoff, ZIP contents and independent byte-identical source rebuild.

The preceding update corrects the visibility of light-DOM text assigned to open
web-component slots. On the public OTTO homepage, the navigation skip link has
positive text and host rectangles while an internal shadow wrapper has zero
opacity. Following only DOM parents incorrectly included it as an unassessed
text run. A Firefox 158 probe of the actual page now excludes it while hidden,
includes it when its internal button receives focus, and excludes it after blur.
The focused component's contrast remains conservative; this change does not
claim to resolve its internal backgrounds, filters or other paint effects.

Visibility follows accessible assigned slots and shadow hosts without adding
internal shadow text to the inventory. Directly assigned Text nodes also use
their slot's visibility, including visible overrides inside a hidden host.
Boxless slots/wrappers do not acquire opacity, clipping or content-visibility
surfaces. Tiny positive opacity is retained, top-layer escape rules remain
conservative, and slot reassignment is evaluated on each scan. Closed or
otherwise inaccessible assignments are not treated as known visibility.

Five focused unit tests cover these paths. The native fixture checks the full
audit through hidden/focused/blurred states, direct Text-node assignment, visible
overrides, boxless opacity/content-visibility, faint text, opened/closed popovers
and slot reassignment. Unassigned light text and internal shadow-only text stay
outside the inventory. Independent Firefox 142/158 geometry and screenshot
probes confirmed the visibility-override and boxless-content cases. Live-site
captures and ad-hoc rendering probes stay outside both ZIPs; the synthetic
regression fixture and test definitions are included in the source archive.

All 193 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 36 native groups, including the new slot cases;
the rendered DOM/sidebar harness also passes. Sidebar assets and translations
are unchanged, so the preceding UI contrast results continue to apply.

The preceding update addresses text in clipped carousel slides and separated
half-turn icon-font glyphs. A direct Firefox 158 audit of the public Felgenoutlet
homepage reproduced 21 entries without a measured or CSS color-pair ratio:
16 absolutely positioned countdown labels, four struck-through prices on
clipped slides, and the visible offer link with a rotated generated arrow.
The first 20 are hidden by the carousel's overflow viewport, although their
layout rectangles can lie inside the browser viewport. They must not be
assigned invented background colors. The offer link's generated glyph is
measured with its actual loaded font and reflected ink bounds; unsupported
transforms, shadows and overlapping ink retain uncertainty.

The corrected live snapshot contains 151 text runs and zero entries in No
values, down from 175 runs and 21 such entries. The visible offer link has a
conservative minimum ratio of 15.578292040457692:1 and meets both AA and AAA.
The final live audit is marked partial because the page's countdown mutates
during measurement; this observation is limited to the captured homepage state,
not a complete certification of the site. Diagnostics stay outside both ZIPs.

The clipping proof now follows supported local absolute-position containing
blocks before applying higher overflow clips. Fixed, sticky and top-layer
exceptions remain conservative. Solid strike-through text can be excluded only
by horizontal clipping, using both glyph ink and the decorating box. A missing
first-line/first-letter decoration does not negate an already accounted-for
solid strike. Italic text uses the identical style for font availability and
Canvas ink measurements. A preserve-3d declaration alone is accepted only when
the complete ancestor path remains two-dimensional, with no perspective or
other supported-proof-breaking transform. New regression cases cover visible
partial text, nested absolute badges, slide changes, overflow removal, escaping
elements, top-layer popovers, italic overhang, real 3D rotation and perspective.

All 188 unit/integration tests, type checking, build and extension lint pass.
Firefox 142 and 158 each pass 35 native groups. The new carousel group verifies
4 visible runs, 8 after removing overflow clipping and 3 after changing slides;
escaping, fixed, sticky, real 3D and perspective cases remain included. Firefox
computes the authored-relative open popover as absolute; its positioned parent
would clip it without the explicit top-layer exception. Open/closed audits
preserve/remove its text correctly. English/German interaction and rendered
DOM checks pass, all nine screenshots per locale were reviewed, and light/dark
UI contrast checks report no failures. Release verification records the matching
source archive, preserved previous handoff and independent byte-identical build.

The empty Element text message now describes an unavailable copyable excerpt,
rather than implying that an element has no text. Input/combobox content remains
excluded from excerpts. This message is independent of contrast availability.

The preceding update permits the euro sign in the existing conservative text-ink
proof. Previously, one euro sign anywhere in a text node kept every wrapped
line, including lines entirely hidden by a three-line clip. Sampling those
hidden lines could hit the next card and discard the correct background.
Loaded-font checks, matching advance/font bounds, actual ink overhang, clipping
margins and restrictions on combining marks, bidi and effects remain intact.

The supplied Mydealz export shows a white, 14-pixel paragraph with a 60-pixel
height limit and an unresolved layered background. The supplied card HTML
contains three-line titles with euro prices. A synthetic 148-pixel-wide title
reproduced the error in Firefox: euro text retained eight lines and became
unassessed, while the EUR control retained only the three visible lines.
After correction, Firefox 142 and 158 both retain three lines and measure white
on #222222 at 15.909984431773273:1 in selection and audit, with and without
line-clamp. Direct site access returned HTTP 403, so the exact live page's fonts
and surrounding computed styles remain unverified.

The preceding update excludes ordinary-flow text inside provably empty overflow
padding boxes. A synthetic closed menu reproduced spurious text runs when a
following SVG or unsupported font metadata blocked the existing glyph proof.
The new check uses exact used CSS dimensions, padding and borders; rounded
client dimensions alone do not establish emptiness. It preserves positive
subpixel clips, padding, boxless wrappers, expanded overflow-clip margins and
potentially escaping positioned or top-layer descendants. Fieldsets are excluded
from this shortcut because their legends can paint outside the anonymous
clipped content box. Visible `inert`
content is retained: inertness alone does not hide paint.

The preceding update adds a separate, copyable text excerpt at the bottom of
confirmed element details. Contrast uses the selected text run; the other
element tabs combine eligible measured nodes in DOM order. Reading is bounded
before whitespace normalization (4,096 UTF-16 units per node and 50,000 per
selection), with 500-unit run excerpts and a 2,000-unit combined excerpt.
Truncation preserves surrogate pairs and is indicated. This is a DOM excerpt,
not an assertion that all its characters survive CSS clipping or transformation.

Form values, placeholders, editable content (including inherited editable
containers, role-based textboxes and document design mode), attributes and
non-HTML text are excluded. No excerpts are collected by audits or unconfirmed
picker previews. Session persistence strips excerpts from cloned snapshots;
live confirmed selections retain them. Standard exports and reports remain
text-free; only the separate Copy text action copies the requested excerpt.
This explicit selection feature supersedes earlier blanket no-page-text UI
statements in this record. Existing clipping and painting measurements are
unchanged.

All 180 unit/integration tests, type checking, build and extension lint passed.
English/German interaction checks verify run and whole-element scope, literal
rendering, truncation, narrow layouts, clipboard fallback invalidation and
exclusion from standard export formats. The rendered DOM harness checks actual
node mapping, forbidden content, refresh/reset and opt-in capture. The new card
passes light/dark text and control contrast checks. Native Firefox 142 and 158
each pass 34 check groups, including excerpt controls, JSON privacy, euro titles and empty
overflow menus. Opening and closing the synthetic menu gives 0, 3 and 0 text
runs on fresh audits. Separate cases preserve visible inert text, 0.25-pixel
and 0.5-pixel clipping areas, padding, escaping boxes and open top-layer surfaces.
Archive and independent source-rebuild evidence accompanies the local package.

The supplied Heise export is current and contains one 16-pixel, weight-600
text run with #E0E0E0 foreground and no resolved background (layered-background).
The subsequent supplied HTML identifies IT News, Online-Magazine and Über uns
as headings inside the expandable main menu. Its main toggle is marked closed
and its panel inert; the SVG sibling matches the synthetic failing pattern.
The supplied HTML does not include resolved clipping geometry. Public page
access returned an authorization restriction, so the exact live state remains
unverified. The empty-overflow correction is proven on controlled cases, not
claimed as a reproduced live Heise measurement.

The preceding update replaces the audit's broad Unverified filter with No values
(German: Keine Messwerte). It selects unassessed contrast only when neither a
measured ratio nor a CSS color-pair ratio is available. CSS color pairs retain
their existing filter and count. Inconclusive gradients with a displayed minimum,
font-size-only uncertainty and inactive controls are not missing contrast values.
The overview still reports all unverified page-rendering verdicts, including CSS
pairs; this filter change does not change any measurement, verdict or export.
English/German interaction checks cover disjoint filter membership and counts,
unknown font size with a CSS ratio, gradient minima, inactive controls, empty
results and rescan reset. All 172 unit/integration tests, build/lint, rendered
sidebar checks, light/dark UI contrast checks and 31 native checks in each of
Firefox 142 and 158 passed. Package contents and the independent offline source
rebuild are recorded with the external handoff.

The preceding update corrects a clipping guard for split text inside shadowed boxes.
A synthetic twelve-node preview reproduced the reported pattern: nodes three
and four hit a neighboring pane while later hidden nodes fell outside the viewport.
A decorative ancestor box shadow unnecessarily disabled the existing bounded
glyph/overflow proof. Box shadows no longer prevent that visibility proof; text
shadows, filters, unsupported typography and ambiguous glyph bounds still do.
This does not relax the separate background/contrast checks for visible text or
claim to measure text that remains clipped. Box-shadow painting is defined
separately from glyphs in [CSS Backgrounds](https://www.w3.org/TR/css-backgrounds-3/#shadow-layers).

The private messaging page was not accessed. The supplied exports lack ancestor
styles and text geometry, so they cannot establish whether the box-shadow guard
caused those exact private-page failures. The group-title export already passes
at 17.210166562311272:1. A separate synthetic case reproduces an unassessed audit
for offscreen, pointer-transparent text in a displaced container, followed by a
passing selection after scrolling it into view. That audit correctly becomes
stale; this update does not guess a background for the earlier offscreen state.

All 172 unit/integration tests and extension build/lint checks pass. The native
Firefox 142 and 158 suites each pass 31 checks, including two visible preview
runs at 7.046327883257104:1 in shadowed boxes, matching audit and selection,
and restoration after removing clipping. The rendered harness also preserves
uncertainty for text shadows and filters. Its synthetic text uses matching
DOM/Canvas widths in both engines; Chromium's different kerning for another
phrase correctly retained the existing conservative width-mismatch fallback.
The sidebar code, styles, locales and assets are unchanged, so the preceding
UI interaction and light/dark contrast evidence remains applicable.

The preceding update adds page overviews to Colors and Typography when no element
is selected. They reuse the current audit's palette and computed CSS font-family
stacks, with measurement time, scope and incomplete/stale status. The font list
explicitly includes fallback families and does not claim to identify the font
face actually used for each glyph. Without an audit, a scan starts only after
the user presses its button. Selecting an element retains its detail view and
copy/export scope; without selection, the footer uses existing page-value
serialization for colors and fonts. The 12 CSS-pixel readability threshold and
content measurements are unchanged.

The EN/DE interaction checks cover full font stacks, page-value copy/export and
frozen drafts, element priority, incomplete/running/cancelled/stale/empty states,
navigation and rescan replacement. Both overview headers fit a 280 CSS-pixel
sidebar. Native Firefox 142 and 158 each pass 31 checks, including the page
overviews, font changes that remain historical until rescan, reload cleanup and
the existing safe font-export subset. All 171 unit/integration tests, build/lint,
rendered DOM/sidebar checks and the expanded light/dark UI contrast checks pass.

The preceding update corrects background detection for truncated multiline text.
The reported Amazon return link occupies 102 by 48 CSS pixels and shows three
lines, but Firefox returns six text Range rectangles. Hit-testing the hidden
lines previously reached neighboring feature rows and produced an unknown
background. Supported ordinary text now maps each wrapped fragment to its exact
substring and verifies font metrics and glyph ink before excluding a fully
clipped fragment. The visible lines remain one text run. Partial lines, effects,
ambiguous ranges, word-internal shaping, automatic/soft hyphenation and unknown
font metrics retain their previous conservative treatment. Work is bounded to
32 fragments and 4096 characters, and character geometry is read only when a
real overflow clip could wholly hide at least one fragment. Form contents are
never read and text contents are not added to exports.

The public Firefox 158 diagnostic reproduced the original unknown background
and measured the corrected return link as #2162A1 on #FFFFFF, 6.313166596100774:1
(AA pass, AAA fail). A real pointer hover changed it to #0C3353 and
13.01059009645572:1 (AA/AAA pass). No popover appeared in that public session.
The live page kept mutating during its audit, so its partial audit totals are
not evidence of a complete page-wide improvement. Public diagnostics remain
outside the source and runtime archives.

The synthetic six-line regression reproduced the old failure and now passes in
Firefox 142 and 158. Its seven text runs include a partial final line, split
descendants, offscreen text and a shadow that remains unassessed. Real overlays
still prevent a verified result; removing clipping and expanding the text box
update the next audit. Hover colors and separate AA/AAA outcomes are checked
through the installed native sidebar. Chromium's extra ellipsis and ambiguous
wrap-space rectangles retain a conservative fallback in the DOM harness.
All 171 unit/integration tests, build/lint, rendered DOM/sidebar checks and 30
native checks in each supported Firefox version passed. Package byte comparisons
and the clean source-archive rebuild are recorded separately for this handoff.

The preceding update handles three reported comparison-page cases. A fully covering
opaque sRGB gradient now anchors its own conservative color range, so hidden
ancestor colors no longer weaken the result. Partial or translucent images,
unknown placement, effects and unsupported interpolation retain uncertainty.
Absolute OKLab/OKLCH colors keep full conversion precision and original CSS text.
Their out-of-gamut conversion matches the default sRGB clipping verified in
Firefox 142 and 158 with actual DOM screenshot pixels, not just Canvas output.
The reported badge is #322400 on #FFFFCC, 14.730280417677456:1, AA/AAA pass.
This intentionally follows Firefox's default `layout.css.gamut-mapping.method=0`
as implemented in [StyleColor.cpp](https://searchfox.org/firefox-main/source/layout/style/StyleColor.cpp);
custom experimental gamut-mapping preferences are not detected. These modern
color functions remain unsupported in gradients because mapping stops before
interpolation would not establish the same color range.

A floating search hint in a sibling input's reserved horizontal padding can now
retain that control's flat CSS background for a separately labeled CSS comparison.
The Geizhals pair is #BFBFBF on #29323D, 7.058440424184376:1. Its page rendering
remains unverified; input values and placeholder contents are never read. An outer
display:contents wrapper is accepted for this limited fallback while its effects
are still checked. The negative-z background proof retains its previous guards.
The rendered regression failed on the previous build. Its twelve text runs cover
the three cases, partial/shifted/translucent/modern-color gradients, input padding
and unknown control backgrounds, value-read traps and changed-style rescans.
All 166 unit/integration tests, build/lint, rendered DOM/sidebar checks and 29
native checks in each of Firefox 142 and 158 passed. Public-page diagnostics and
final package/rebuild evidence remain outside the source and runtime archives.
The final public Firefox 158 run used the actual content bundle with faked
extension messaging and temporarily hid only the consent overlay for diagnosis;
no consent choice or account interaction occurred. All 30 currently visible
yellow offer buttons passed AA/AAA with a conservative minimum of
14.632535172600084:1; the badge and search-hint CSS pair matched the values above.
The final audit retained six unverified results among 934 text runs. An earlier
baseline contained 38 unverified results among 964 runs and 31 visible offer
buttons. Live offers changed between visits, so these totals do not represent
identical page content. The synthetic fixture provides the fixed before/after
regression, including invalidating both gradient coverage and hint padding.

The preceding update excludes fully clipped image-replacement labels whose computed
text indent is a finite pixel length. Actual Range, glyph bounds and overflow
clipping must still prove that no text is visible; partial, unclipped, offscreen,
shadowed and unsupported labels remain included. The English/German empty-text
notice now explains that icons and image content are outside text-contrast checks.
The 9GAG search link was reproduced publicly in Firefox 158: its hidden "Search"
label uses -999px indentation, while a PNG sprite supplies the visible magnifier.
The old build incorrectly produced one manual text result. Default, hover and
active captures now contain zero text runs; hover/active change the background,
while the CSS text color stays #0099FF. A fresh isolated diagnostic temporarily
disabled only the consent overlay's pointer interception; no consent selection or
account interaction occurred. This public diagnostic used a source measurement
bundle with the matching content-build hash; native tests below exercise the
actual extension build. Public captures remain outside both archives.
The rendered regression failed on the previous build and now passes seven cases,
including genuine hover/active states. Revealing a clipped label restores it in
inspection and changes the audit from five to six runs. All 154 unit/integration
tests, build/lint, rendered DOM/sidebar checks and 28 native checks in each of
Firefox 142 and 158 passed. The native checks also verify the explanatory notice,
absence of invented icon ratios/AA/AAA and retained raw CSS values. Independent
source rebuild and final archive checks are recorded separately. This correction
does not add image/icon contrast measurement or continuous hover-state monitoring.

The preceding update resolves a uniform opaque top background image only when it
covers all measured text rectangles. Image placement, clipping, rounded corners
and unblurred inset shadow strips are checked; partial images, other corner shapes,
unknown typography and painting effects retain conservative gradient bounds.
Owned background images also prevent ineffective background-color suggestions.
The reported Amazon swatch price was reproduced on its public product page in
Firefox 158. Its white top image hid gray and blue border colors that previously
produced a false #21628C-to-white range. The corrected CSS pair is #565959 on
#FFFFFF, 7.0733461612626805:1, meeting both AA and AAA. The 0.01-opacity native
input and strike pseudo-element still leave page rendering explicitly unverified.
The 10px readability warning remains independent. No account or purchase action
was used. Public diagnostics remain outside the source and runtime archives.
The synthetic regression failed before correction, including the actual price
position near the rounded corner. Nine cases check exact or CSS-only results,
unsupported coverage and a rescan after changing the top image to a real gradient.
All 152 unit/integration tests, build/lint, rendered DOM/sidebar checks and 27 native
checks in both Firefox 142 and 158 passed. Independent source rebuild and final
archive checks are recorded separately. The round-corner proof accepts the
equivalent computed `superellipse(1)` form defined by
[CSS Borders 4](https://www.w3.org/TR/css-borders-4/#corner-shape-values).

The preceding update corrects fully clipped adjacent text nodes in long message
previews. Collapsible boundary spaces can retain their measured advance; the
visibility proof now considers all matching edge-space interpretations and their
combined glyph bounds. Supported simple Latin/Cyrillic text and common punctuation
are bounded to 4,096 code units. NBSP is preserved; combining marks, bidi controls,
unspaced shaping boundaries, effects and unsupported metrics remain conservative.
The new rendered regression failed on the prior build. Its nine synthetic cases
now retain 17 text runs, with precise 7.046327883257104:1 contrast for the supported
visible fragments; removing clipping restores all twelve Latin nodes and raises
the audit to 28 runs. Audit and inspection agree. Export events contain no fixture
text. All 146 unit/integration tests, build, lint, the full rendered DOM/geometry
harness and 26 native checks in both Firefox 142 and 158 passed for that handoff;
the current expanded suites also cover those cases.

The preceding text-only update added a bold localized Note/Hinweis prefix to the audit explanation. A targeted rendered check passed in both languages and themes at 280 CSS pixels, with normal-weight body text and no overflow. The broader interface-contrast and interaction evidence below belongs to the earlier icon handoff; the latest correction changes the content script and localized notice, including the bundled English fallback, while sidebar behavior and CSS remain unchanged.

Audit status circles use fixed SVG glyphs instead of font-dependent text symbols.
Visual checks covered both languages/themes at 280 and 480 CSS pixels: all 64
glyphs were centered, with no overflow or browser errors. Existing sidebar
interaction and rendered contrast suites, all 140 unit/integration tests, build,
lint and native Firefox 158 checks passed for that handoff. Both Firefox versions
were checked again for the latest background-surface correction described above.

Clipped message previews now restrict overlap sampling to the supported visible
overflow area. A synthetic long preview reproduced the reported missing background:
its full text range extended into an adjacent pane even though overflow hid that
part. The regression failed before the correction and now checks exact 60%-alpha
white over #161717 (7.046327883257104:1) in both audit and element inspection.
The fixture covers own/ancestor clipping, pointer-transparent text and scrolling,
plus actual overlays, visible overflow, escaping text and unsupported transforms.
No private WhatsApp session or real message content was accessed or included in
the fixture. The supplied export supports this diagnosis, but live confirmation
on the owner's page remains pending. Existing hit-testing limitations remain;
this is not a general proof of all surfaces beneath independently positioned text.

The manual contrast calculator was checked in both languages and themes, with
HEX and inline color-picker synchronization, invalid input, normal/large AA/AAA,
copy behavior, selected-element priority, navigation, focus and data clearing.
The full unit, DOM and native Firefox suites were rerun. The interface audit now
also measures editable field boundaries, SVG controls and keyboard-focus outlines.
It found weak field borders and a dark-theme clipboard-textarea focus indicator;
both were corrected. The light success color was darkened for additional margin.

The initial native Windows color dialog retained zero luminosity when starting
from black. The manual calculator now uses an inline saturation/value field plus
an immediately clickable hue strip and keyboard-accessible hue/saturation/value
sliders. Opening preserves the original color. Real pointer tests compare a
sampled palette screenshot pixel with the resulting HEX, preview and contrast;
they also cover dragging, clamping, cancellation, achromatic hue changes, same-color
recovery after invalid HEX and Escape with focus retained in the text field.
The pointer gesture retains its initial palette bounds: hiding an invalid-HEX
message cannot shift the selected brightness between pointer-down and pointer-up.
The regression reproduced that shift before the correction and now checks the
clicked saturation/brightness after the error message disappears.

## Output-location correction

The source manifest was selected during a local temporary-install attempt. It
does not have generated JavaScript and icons beside it, which explains the
missing toolbar icon and nonfunctional button. The loadable extension now belongs
at **`../Style-Inspector-Lite-artifacts/dist/`**; temporary installation must use
the `manifest.json` in that external build directory. The repository-root manifest
remains a build input, and no generated `dist` directory belongs in the repository.

The default unsigned package is **`../style-inspector-lite-1.0.1.zip`**. Its filename
does not contain `-unsigned`, but it is still unsigned. The matching source archive
and release documents belong under
`../Style-Inspector-Lite-artifacts/releases/v1.0.1/`. Earlier unpublished artifacts
are preserved under `../Style-Inspector-Lite-artifacts/archive/initial-layout-v1.0.0/`.

The results below were rerun for the initial 1.0.1 preparation. They cover
the external build, native installation from that directory, revised path checks
and an independent source-archive rebuild. Final ZIP contents and checksums are
inspected separately after packaging.

The owner selected 1.0.1 as the initial release. Previous 1.0.0 packages are
preserved as local development handoffs. The release notes contain only
"Initial release." / "Erstveröffentlichung."; there is no separate changelog.
AMO listing summaries/descriptions remain outside the source and runtime ZIPs.

## Recorded results

| Check | Observed result | Evidence and limits |
| --- | --- | --- |
| TypeScript | Passed | `npm run typecheck`. |
| Unit and integration tests | 171 of 171 passed | Includes hidden wrapped-line fragments, glyph overhang, partial clipping, expansion, ambiguous character ranges, hyphenation and bounded layout work; also opaque image coverage and gradient bounds, OKLab/OKLCH conversion, reserved input-padding CSS pairs, clipped indented labels, elliptical corner boundaries, unsupported effects and image-covered suggestion restrictions; retained edge-space advances, ambiguous ink-bound unions, NBSP, bounded Cyrillic, combining/bidi exclusions, adjacent shaping and unknown font metrics; also separate unverified CSS color ratios, transparent native-label privacy, audit freshness after conflicting element measurements, document/tab/request races, permission revocation, rescan isolation, element actions, highlight cleanup, bounded text-heavy scans, per-fragment overlap and transparent icon padding, empty clipping regions, placeholder privacy/opacity, separated leading/trailing decoration, offscreen flow, bounded negative-z background proofs and unknown sibling backgrounds, empty feedback text ranges, sRGB color() parsing, rounded HEX labels with precise measurements/exports, conservative gradient bounds and exports, download ordering/recovery, archive exclusions, color extremes and real export compilers. |
| Extension build | Passed | `npm run build` produced the external `../Style-Inspector-Lite-artifacts/dist/` tree. |
| Extension lint | Passed with 0 errors, 0 warnings and 0 notices | `npm run lint:extension`; lint is not AMO review. |
| Rendered sidebar geometry | Passed | `test-results/ui.json`: Microsoft Edge 155.0.4283.62, five locales, four viewports and all five tabs. Browser extension APIs were faked for this harness. |
| Real DOM fixture and picker | Passed in the rendered harness | The initial fixture had 23 text runs, 1 contrast failure and 3 small-text hints. Labeled highlights follow nested scrolling and resize without modifying target CSS. Repeated highlights do not stale the scan; real edits do, and rescanning measures corrected styles with fresh references. Picker suppression, normal click restoration, privacy and Escape cleanup also passed. |
| Additional sidebar interactions | Passed in English and German | Independent AA/AAA results, numeric colors, CSS-only AA/AAA comparisons, separate CSS filters/counts and unchanged precise actual measurements in JSON exports, text-size thresholds, copied ratings and target changes without rescanning. Suggestion swatches, exact HEX copies across color preferences, and actual before/after preview colors for text/background changes. Also rule totals, stale/live actions, reconnection, rescan reset, settings, focus, clipboard fallback, exports, permissions and simulation. Browser extension APIs were faked. |
| Interface catalogs | 327 keys in each locale | Matching English/German catalogs, including page overview scope, CSS font stacks and page-value copying. |
| Rendered UI text contrast | Passed in light and dark themes | `test-results/sidebar-contrast.json`: 13,732 text measurements and 9,436 non-text measurements across 1,344 states, zero AA text-contrast failures and zero own UI font sizes below 12 CSS px. Includes complete, incomplete, running, empty and not-yet-scanned page overviews. Independent calculation from actual browser-computed styles; scope below. |
| Native Firefox 158.0 | Thirty-one checks passed | `test-results/firefox-158.0.json`; installation from the external build, native sidebar interactions, the real optional website-permission prompt, page overviews and all expanded fixtures described below. |
| Native Firefox 142.0 | The same thirty-one checks passed | `test-results/firefox-142.0.json`; the exact declared minimum was tested with the actual external extension directory, page overviews and all expanded fixtures. |
| Clean source-archive rebuild | Recorded separately | `test-results/source-rebuild.json` records the extracted source archive, offline `npm ci`, build/typecheck result and SHA-256 comparison of all 15 runtime files. Verify that its source and runtime hashes match the final handoff. |

The geometry matrix used **en, en-US, de, de-DE and fr**. French exercises the
English fallback; it is not a third interface translation. The content viewports
were **280 × 480**, **320 × 600**, **380 × 800** and **480 × 720 CSS pixels**.
Header, picker toolbar, tabs and footer were compared across all five tabs.
These are application content sizes, not claims about Firefox's sidebar limits.
The audit overview uses tinted status backgrounds, neutral high-contrast labels and numbers, and filled 20-pixel status circles with centered 16-pixel SVG glyphs. Matching headings, descriptions, wrapped status rows and totals
align across both columns; the existing English/German behavior check verifies
their rendered positions in both themes. Narrow layouts stack the cards.
All five audit filters show their matching totals in parentheses, including zero. Counts cover the full matching list, before pagination. No values selects missing contrast ratios independently of the font-size rule and does not overlap CSS color pairs. The CSS-pair count appears in its filter instead of adding an asymmetric row.
The harness also checked navigation, frozen export bytes, empty access states and
locale fallback. Its browser API fakes do not prove native Firefox permissions.

All twenty-seven native checks passed in Firefox 142.0 and 158.0 for this handoff with Firefox's default
sidebar configuration. The expanded fixture results below also passed in the
separate rendered harness, which checks detailed color-chip layout and copy/export
behavior:

1. Temporary installation from the external build directory produced a visible
   toolbar icon; its actual extension image URL decoded successfully.
2. A trusted toolbar click opened the audit view and
   activated the document without starting a picker or scan.
3. A repeated toolbar click kept the sidebar open and preserved its active tab.
4. An explicit sidebar picker selected real fixture styles and ended afterward.
5. An explicitly started page audit completed.
6. Repeated highlights and inspection of stale findings stayed available; after
   a page style edit, a fresh scan replaced results and cleared element selection.
7. Reloading the same URL invalidated old document data; a trusted toolbar click
   reactivated the new document without selecting automatically.
8. The native context menu on a new document with a closed sidebar captured the
   clicked element without starting the picker.
9. Navigating between distinct local HTTP origins kept the same sidebar document
   open. A trusted scan click triggered Firefox's real optional website-permission
   prompt: denial left the action retryable; approval started the requested scan.
10. A subsequent navigation could be scanned from that same sidebar without
    another permission prompt or toolbar activation. Navigation alone did not scan.
11. Fully clipped accessible labels and descendants were excluded from the audit.
    Partially clipped, small and offscreen visible text remained included;
    revealing a hidden label added its text and contrast result on rescan.
12. Shown placeholders used their own color, opacity and font, including native
    Firefox placeholder colors. Empty placeholders were excluded. Nonpainting
    decoration did not block button text; real uncertainty remained explicit.
    The fixture had 10 runs: 5 passes, 4 unassessed, 1 exempt and no failures.
13. A native placeholder with fractional sRGB channels and 0.54 alpha displayed
    `#1111118A` with a precise RGB tooltip. Its swatch, unrounded contrast ratio and
    AA failure retained the original alpha, using the actual installed picker.
14. Transparent logo padding and stretched layout boxes did not invalidate text
    contrast. Real solid/SVG/pseudo/shadow overlays, closed shadow hosts, later
    text fragments and sampling limits remained unassessed. The fixture had
    12 runs: 4 passes and 8 unassessed; adding closed-shadow paint gave 3/9;
    removing it and another solid overlay then rescanning gave 5/7.
15. Supported light and nested translucent linear gradients established minimum
    contrast with separate AA/AAA passes. Ambiguous bounds, translucent text,
    images, other interpolation spaces and painting effects remained unassessed.
    The 12-run fixture had 5 passes and 7 unassessed; changing a light gradient to
    black/white gave 4/8 on rescan, with no false failures in either scan.
16. Clearly separated trailing keycaps and inline/breadcrumb separators retained
    their text contrast. Small gaps, broad shadows, transforms, overflowing glyphs,
    wrapping and ambiguous layouts remained unassessed. The 18-run fixture had
    6 passes and 12 unassessed; moving a key into the text gave 5/13 on rescan.
    All 18 small-font hints remained. A pointer-transparent hint above a sibling
    input retained an unknown background and contrast instead of the header color.
17. Leading metadata bullets, inline generated text, independent block layouts and
    multiple flex children retained exact AA/AAA contrast. The 23-run fixture had
    10 passes and 13 unassessed; moving a timestamp separator gave 9/14 on rescan.
18. Ordinary offscreen pointer-transparent labels retained their enclosing opaque
    background. Displaced or floating transparent layers, negative margins, boxless
    or too-small backgrounds and painted emphasis remained unassessed. The 12-run
    fixture had 4 passes and 8 unassessed; moving a label gave 3/9. Painting a
    previously transparent feedback layer gave 2/10, with no false failures.
19. Separate opaque negative-z background surfaces resolved text over translucent
    buttons in a shared stacking context. The 16-run fixture had 4 passes and 12
    unassessed; moving a background in front of its label gave 3/13 on rescan.
    Incomplete coverage, other contexts, lower text, masks, gradients and painting
    effects stayed unassessed. No false failures were introduced.
20. A CSSOM-only overlay change discovered by fresh inspection marked the older
    audit stale while preserving its rows, totals and timestamp. Unchanged
    inspections stayed fresh; a rescan replaced all measurements together.
21. Fully clipped overflow text was excluded while partial, offscreen, escaping,
    decorated and unsupported text stayed included. The 14-case fixture retained
    11 text runs; revealing the second navigation row added its twelfth run.
    Native inspection measured the revealed link at 13.57:1 with AA/AAA pass.
22. Five fully transparent native labels were excluded from the 14-case control
    fixture; visible fills, faint text, effects and placeholders remained. A
    sibling label under a native button retained overlay uncertainty while the
    sidebar displayed 9.54:1 with separate CSS-only AA/AAA threshold comparisons
    while retaining the unverified page-rendering status.
    Revealing a transparent label increased the audit from 9 to 10 text runs.
23. Protected Firefox pages remained unscannable after granting website access.
24. Without selection, the manual calculator showed 21:1 for black/white, separate
    normal/large AA/AAA outcomes, synchronized HEX/palette values, and
    removed results for invalid input without starting a page scan or export.
25. Clipped previews sampled their visible overflow area and retained 7.05:1
    AA/AAA measurements. The nine-run fixture had five passes and four uncertain
    results; removing clipping changed these to four passes and five uncertain.
26. Adjacent clipped text nodes retained boundary-space metrics. Supported visible
    fragments kept 7.05:1 and AAA, while proven hidden nodes were omitted and
    uncertain shaping/effects remained included. Native multilingual inspection
    contained two visible runs; revealing all twelve Latin nodes changed the audit
    from 17 to 28 runs. No private WhatsApp session was used.
27. Uniform white images hid lower button-border colors only where coverage was
    established. The nine-run fixture had two passes and seven uncertain results;
    all nine retained small-text hints. The simulated struck price displayed the
    white CSS pair at 7.07:1 with AA/AAA pass while rendering remained unverified.
    Changing a uniform image to a real gradient produced one pass and eight
    uncertain results on rescan. Control values were not emitted.

The permission test uses WebDriver pointer input to the actual sidebar button.
In headless Firefox the doorhanger falls outside WebDriver's scrollable viewport,
so the test activates its real confirmation controls through browser chrome. It
does not pre-grant permissions or bypass the permission request. Optional website
access covers HTTP/HTTPS only and remains until revoked. Revocation and races
while permissions are pending additionally have controlled integration/UI tests.

The native harness passes the actual external unpacked extension directory to
Firefox's own `AddonManager.installTemporaryAddon`. It does not install the
repository-root source manifest or generate a temporary XPI for this test. The
same built files used by the documented temporary-install procedure supply the
toolbar icon, content script and sidebar throughout the Firefox session.

## What the automated checks cover

Fresh element measurements now invalidate a completed audit when matching text
runs have changed colors, font measurements or paint uncertainty. This also
covers changes made through CSSOM, which do not generate DOM mutation records.
The old audit retains its original rows, counts and timestamp; an explicit rescan
refreshes the complete set. AA/AAA preference changes and unrelated selections
do not by themselves invalidate matching measurements. Running audits and stale
or foreign-document selections are excluded from this comparison.

The `audit-freshness.html` fixture starts with a real overlay blocking one link.
Hiding the overlay through a stylesheet rule leaves the DOM unchanged. Inspection
then measures white text on `#232F3E` at 13.569124702898852:1, and the old audit
becomes stale. Unit tests and the rendered harness verify that its original data
is preserved, unchanged inspections stay fresh, and a rescan restores coherent
results. The installed extension passed this regression in Firefox 142.0 and
158.0. A before/after probe of the older packaged runtime confirms it missed the
stale flag for the same CSSOM change. The owner's Amazon element export has this
same color pair and passes AA/AAA.

A focused public Amazon navigation probe subsequently reproduced a separate
cause: wrapped links occupied a second row outside an `overflow:hidden`
scrollport. The old audit included them as `layered-background`; showing a link
scrolled the container and made the subsequent inspection pass at 13.57:1.
The updated runtime excluded fully hidden rows, retained visible links with
AA/AAA measurements and measured a revealed link at that exact ratio. This was
tested on the public guest page, not the owner's personalized navigation.

The `overflow-text.html` regression covers display:contents wrappers, vertical
and horizontal clipping, partial visibility, document-offscreen text, escaping
absolute positioning, translation versus scaling, text shadows, combining marks,
decorations, first-line styles, expanded overflow-clip margins and custom font
metrics with oversized glyph ink. Only three proven hidden cases are excluded.
The rendered harness additionally exercises showing a hidden selection, revealing
both navigation rows and rescanning, and verifies that page text is not exported.
Glyph checks run only for disjoint clipping candidates and retain unsupported
typography instead of guessing from layout boxes alone.

Public guest probes of the reported Amazon product page also exposed native
button inputs with `opacity: 0.01` and fully transparent text fill. They serve as
click targets over separate visible labels. The new `transparent-controls.html`
fixture excludes their unpainted text without reading form contents or using an
opacity cutoff. Button/submit/reset inputs with visible or unknown fill, text
shadows, strokes, emphasis, decoration or text-clipped backgrounds remain eligible.
Native appearance can still paint over a sibling label, so that separate overlap
reason is preserved. The guest product view did not expose the owner's exact
purchase controls; the supplied orange-button export supplies that color pair's
regression case. Dynamic guest scans are not a stable before/after page total.
The final public guest probe recorded 686 text runs (654 passes, 3 failures and
29 unassessed) and confirmed that all eight sampled transparent native button
inputs now contributed no text runs. These totals describe only that page load.

The owner supplied the complete HTML for YouTube's signed-in Create button.
Recreating that markup inside the public guest page's real masthead reproduced
the failure after scrolling: YouTube made its separate `#background` surface
opaque, and the pointer-transparent label's hit stack included that negative-z
surface plus thumbnails scrolled underneath the header. The old result discarded
the effective background with `layered-background`. Before scrolling, the same
button already measured correctly. No signed-in session or account was accessed.

The correction recognizes a narrowly supported background behind the text in the
same stacking context. Its solid opaque rectangle must cover the full text range;
lower hit-test layers are then hidden by that surface. The label's translucent
button ancestors are composed above it. In the live reconstruction, `#F1F1F1`
over `#272727` gives **13.225798856331128:1**, passing AA and AAA after scrolling.
The supplied label dimensions and typography also match the reconstruction.
External evidence: `test-results/youtube-create-scrolled-before-firefox.json`
and `test-results/youtube-create-scrolled-after-firefox.json`. This verifies the
supplied markup and public CSS, not the owner's authenticated browser state.

Four unit tests cover composition, context boundaries, paint/coverage failures,
privacy and bounded ancestry. The rendered/native fixture adds foreground
overlays, negative text contexts, masks, gradients, rounded/partial surfaces,
separate stacking branches and rescan. Animated or clipped contexts, top-layer
elements and unsupported effects are excluded from the new proof. It does not
infer pixel colors from screenshots or generally resolve arbitrary sibling paint.
The unchanged interface catalogs, behavior and own-text contrast results remain
those of the preceding UI validation; renderer/native checks include this change.

The reported YouTube timestamp used `#AAAAAA` over `#0F0F0F` at 14 CSS pixels,
but a generated separator caused an unassessed result. The supplied measurement
gives approximately 8.251239820985962:1 and passes both AA and AAA when the separator
cannot paint over the text. A fresh isolated Firefox 158 visit used YouTube's newer
`yt-lockup-view-model` layout rather than the reported `ytd-video-meta-block`, so
the exact timestamp element was unavailable for a live check. Loaded public CSS
still confirmed the legacy `::before` bullet and its 4-pixel horizontal margins.
The equivalent color and layout are covered by the local regression fixture;
this is not a claim that the user's exact live page variant was reproduced.
External evidence: `test-results/youtube-time-loaded-css-firefox.json`.

The separator proof now covers leading and trailing punctuation in supported
single-line inline, independent block and horizontal flex layouts. It measures
glyph advance and ink separately, allows actual ink overhang only with sufficient
clear space, and checks available width, child placement, wrapping and transforms.
Ten focused tests cover the geometry and conservative fallbacks. Text-emphasis
marks are rejected because canvas glyph metrics do not describe them; all four
border widths, including unknown widths, count as paint across padding. A visible
emphasis-overlap regression remains unassessed. Ordinary text is measured only
transiently; form values and unrelated feedback text contents are never read.

Offscreen pointer-transparent text can retain a background only through a bounded,
undisplaced flow path to an opaque box that encloses its text rectangle. A positioned
opaque container is accepted before testing transparent ancestor displacement.
Floating layers, moved relative elements, transforms, negative margins,
`display: contents` fake backgrounds and text outside the painted box stay
unassessed. Transparent feedback wrappers may contain truly empty text nodes or
nodes whose Range has no rectangles; those nodes no longer count as paint merely
because they exist. The empty-node check uses `Text.length === 0`, without reading
the string. Firefox 142 can return a zero-size rectangle for an empty node while
Firefox 158 returns an empty rectangle list. Nonempty nodes with zero-size
rectangles remain conservative: glyph ink can still extend outside those metrics.
The fixture creates an actual empty text node, matching the observed YouTube
feedback wrapper, rather than relying on formatting whitespace. Fully transparent
children are ignored, while visible feedback paint still blocks measurement. The
12-run fixture verifies these distinctions and rescans without retaining page
text or reading form values.

Isolated Firefox 158 YouTube probes first preserved the real consent overlay, then
temporarily hid only its dialog/backdrop locally for a controlled diagnostic;
no consent action or persisted state change occurred. Controlled scans counted
293 runs with 237 passes and 56 unassessed before, then 298 runs with 266 passes
and 32 unassessed afterward, with no contrast failures. Recommendations changed
between visits, so these totals are not an exact matched-page comparison. Seventeen
ordinary more-replies labels passed in the final probe. Twenty reply labels with
a negative margin remained unassessed, as did other unresolved paint and shadows.
Untouched consent overlays continued to produce genuine uncertainty.
External evidence: `test-results/youtube-time-controlled-before-live-firefox.json`
and `test-results/youtube-time-controlled-after-live-firefox.json`.
The final-build snapshot had 294 runs, 263 passes, no failures and 31 unassessed,
with 16 current more-replies labels passing and 20 negative-margin reply labels
still unassessed (`test-results/youtube-time-controlled-final-after-live-firefox.json`).

An unassessed measurement may retain known CSS colors without having reliable
rendered contrast. The sidebar now explicitly labels such a preview **CSS color
sample**, identifies its background as CSS-derived and explains that page effects
and overlays are omitted. With a known opaque solid background, the audit and
detail view also show a separately labeled **CSS color contrast** ratio.
The reported Amazon `#0F1111` / `#FFA41C` pair gives 9.54274942553824:1, while
the CSS pair reaches both AA/AAA thresholds. The actual page contrast and its
AA/AAA results remain unassessed, with **Page rendering unverified** visible.
CSS threshold results and their ratio use the selected target's pass/fail colors
inside the explicit CSS-only context. Unknown text size retains the numeric
ratio without asserted AA/AAA thresholds. Foreground alpha
is composited without display rounding. Missing colors, gradient ranges and
excluded controls receive no substitute value. Counts and suggestions retain
their original meaning. A dedicated filter with an integrated count identifies
CSS pairs without adding them to verified page passes or failures.
Copied reports label both outcomes separately; JSON
retains the null `contrast.ratio` and adds a sibling `cssColorContrast` object
marked `verified: false`. English/German tests cover both themes at 280/380 CSS
pixels, precise alpha, swatches, copies, exports and unchanged measurements.

The reported Geizhals element was a search hint followed by a generated slash key.
The old runtime rejected any painted pseudo-element, including clearly separate
trailing symbols. The correction accepts only a bounded static layout whose text
geometry, glyph ink, available width, margins and small shadow bounds establish
separation. Unavailable font metrics, nontrivial effects and uncertain layouts keep
the unassessed result. Ordinary text is measured transiently in an unattached
canvas; no page text is stored/exported, and no form values are read.

The exact search hint also exposed an unrelated background problem: it floats
above a sibling input with pointer events disabled. Its ancestor header color
does not represent the input underneath. Missing target hit-testing with a painted
unrelated layer now retains `layered-background` and a null effective background;
removing the decoration reason alone must not manufacture a contrast result.

Isolated live Edge 155 dark-theme probes used the same 1987 x 1325 viewport.
Fresh consent overlays made the untouched scan partial at 1,000 runs: unassessed
results fell from 295 to 277. A second diagnostic temporarily hid only the OneTrust
overlay/banner locally, without clicking consent controls or persisting state.
Both complete scans then had 995 runs: 919/15/61 pass/fail/unassessed before and
937/15/43 afterward. Pseudo-element reasons fell from 28 to 8, while two separate
background cases correctly remained unassessed. One inline separator measured
6.10712594:1, passing AA and failing AAA. The exported search hint remained
unassessed with a null background and its independent 11-pixel warning.
External evidence: `test-results/geizhals-controlled-old-edge.json` and
`test-results/geizhals-controlled-new-edge.json`. These page states differ from
the owner's 86-result snapshot; they do not prove that all 86 cases are resolved.

The later separator/flow correction was also checked against Geizhals with the
same controlled procedure. Both scans retained 995 runs: 937/15/43 before and
941/15/39 pass/fail/unassessed afterward. Four further separated punctuation cases
became assessable; the search hint's sibling background remained unknown.
External evidence: `test-results/geizhals-controlled-youtube-followup-old-edge.json`
and `test-results/geizhals-controlled-youtube-followup-new-edge.json`. This follow-up
does not replace the earlier diagnostic evidence or establish every page state.
Final-build verification retained 995/941/15/39 runs/pass/fail/unassessed
(`test-results/geizhals-controlled-final-new-edge.json`).

The initial decoration fixture failed against the previous runtime before the fix.
It passed in the rendered harness and both native Firefox versions. Its original
six focused unit tests covered font/ink bounds, shadow limits, layout and transform guards,
geometry completeness, device-pixel rounding and privacy. Browser checks verify
that a private input sentinel is never read or included in runtime events, that
a nonpainting hit layer cannot hide a sibling background, and that moving the
pointer-transparent hint offscreen does not create a false measured result.

The reported WeberHaus page reproduced exactly 34 unassessed gradient results:
5 header and 29 footer text runs. All had `background-image-or-gradient`, caused
by real, nearly white CSS linear gradients. The current page yielded 110 runs
(the owner's earlier snapshot had 108). An isolated live Edge probe before the
correction counted 76 passes and 34 unassessed; afterward it counted 110 passes,
no failures and no unassessed contrast results. All 34 corrected runs also passed
AAA, with unrounded minimum ratios 7.9460795829583475 in the header and
7.941070356711113 in the footer. Evidence is recorded in
`test-results/weberhaus-before-live-edge.json` and
`test-results/weberhaus-after-live-edge.json`. These are current-page snapshots,
not a claim about every page state or all accessibility requirements.

The new bounded-gradient fixture failed against the previous build (1 pass,
11 unassessed) before the fix. It passes in the rendered harness and both native
Firefox versions. Unit tests cover CSS layer order, translucent gradient stops,
uncovered background, parser/work limits, unsupported paint, opaque-child hiding,
AA/AAA target changes and JSON exports. Black/white gradient endpoints that each
pass against gray text still yield an inconclusive minimum of 1 because an
intermediate color can match the text. Independent numerical review sampled
30,000 premultiplied-alpha colors in 3,000 layered cases without a bound violation.
English/German UI checks preserve the minimum marker in labels and copied reports,
round displayed bounds downward (4.499 becomes 4.49), and avoid fabricated flat
background previews or gradient color suggestions, including at 280 CSS pixels.

The Amazon placeholder export exposed a display-only precision fallback. Its
`color(srgb 0.0666667 0.0666667 0.0666667 / 0.54)` value correctly parsed to
17.0000085 per RGB channel and 0.54 alpha, but the HEX preference displayed precise
RGB because those values are not exactly representable in eight-bit HEX. A separate
display formatter now produces `#1111118A`; the localized tooltip retains the exact
RGB value. Individual color and palette copies match the shown label. Swatches,
contrast calculations, raw JSON measurements and code export serialization keep
their original precision. The reported contrast remains 4.032916523267044:1.

The new Amazon assertion failed against the previous build before the correction.
Unit checks cover byte rounding, alpha near zero/one, transparent values, uppercase
output, invalid channels, RGB/HSL preferences and unchanged input values. Browser
checks cover English/German labels and tooltips, exact measured swatch alpha,
280-pixel layouts, color/palette copies and precise JSON/export bytes. Both native
Firefox versions confirmed the displayed HEX and precise measurement on a real
input selected through the installed add-on. The reported Amazon data was used
for the regression; no Amazon account or page interaction was needed.

The remaining YouTube country-label report was reproduced in isolated Firefox
158 and Edge profiles. The visible `DE` text occupied x169–181.25, while the
transparent logo wrapper extended to x179. Its actual clipped SVG ended at x165,
leaving a 4-pixel gap. Hit testing reported the wrapper above the text even though
its padding painted nothing there. The old whole-element midpoint and the text
midpoint both hit that wrapper, so changing the sample point alone was insufficient.
The reported `#AAAAAA` on `#0F0F0F` gives 8.25:1, passing AA and AAA; the separate
10 CSS-pixel readability hint remains valid. No account or consent action was used
for the live diagnosis.

A post-fix isolated Firefox visit still had an untouched, partially opaque consent
backdrop above the label. Its actual measurement correctly remained unassessed for
that real overlay; an unobstructed live pass is not claimed. The equivalent clear
logo layout is verified by the local rendered and native fixtures below.

Overlap sampling now follows each direct text node's rendered fragments instead
of the entire element's layout box. A bounded check can discard transparent
wrappers whose clipped icon contents lie outside the text area. Unknown or actual
paint stays conservative, including effects that can extend beyond a box. Geometry
is collected during the existing text traversal; it does not trigger another scan
of all text nodes or get stored in exported snapshots.

The new regression failed against the previous build, then passed in the rendered
harness and both installed Firefox versions. Separate text-node results, later
wrapped fragments, pointer-transparent SVG paint, shadows extending from outside
the text area, input privacy and the 32-fragment limit were covered. The original
snapshot budget test still required only 101 Range reads for 100 retained runs.
Native tests confirmed Firefox's closed-shadow-root presence check. The complete
rendered sidebar geometry, English/German interaction suites and UI text-contrast
matrix were rerun after the HEX display correction.

The YouTube header report exposed two unnecessary uncertainty causes: all inputs
were unassessed, and an empty, transparent masthead pseudo-element blocked nearby
text. A read-only live Firefox 158 probe on the reported
[watch page](https://www.youtube.com/watch?v=A4Q8q0KQQ14) confirmed both. After the
correction, the logged-out Sign in label changed from unassessed to 7.40:1 with
AA and AAA passing. The search placeholder was correctly identified as
`color(srgb 1 1 1 / 0.54)` over `#121212`; an untouched consent dialog still
overlapped it, so its live result correctly remained unassessed. The exact signed-in
Create button was unavailable in the isolated profile and was not verified.

Fixtures in Edge and both native Firefox versions cover placeholder CSS, alpha
composition, fonts, empty/disabled/populated inputs, gradients, group opacity,
and invisible versus painted pseudo-elements. Throwing getters reject reads of
input values and placeholder contents. JSON marks placeholder measurements without
including their contents; suggestion generation and export reject element-color
corrections for placeholder runs. The interface and copied reports show
"No measurement" / "Kein Messwert" without a ratio unit when no number exists.
English/German UI checks include these states at 280 CSS pixels and explicitly
label placeholder measurements while retaining AA/AAA outcomes and counters.

The hidden-label regression was reproduced on Extension Workshop's
[source-code submission page](https://extensionworkshop.com/documentation/publish/source-code-submission/).
Its newsletter email label has text color `#0A0A0A` over `#09204D`, but
`clip-path: inset(50%)` hides it completely. Its text range still has positive
dimensions. The visible gray email placeholder belongs to a different element.
The old build incorrectly reported the hidden label as a contrast failure; the
new browser regression failed against that build before the correction.

The visibility fixture now passes in the rendered harness and both native Firefox
versions: seven eligible text runs and no contrast failures, then eight runs and
one failure after revealing the black label. Tests cover empty percentage insets
and legacy positioned `clip: rect()` on elements and ancestors. Partial clips,
one-pixel boxes with visible overflow, offscreen text, ignored static legacy clips
and boxless `display: contents` ancestors remain eligible. The detailed sidebar
interaction and text-contrast suites were also repeated for the initial 1.0.1
release preparation.

The contrast harness measures the rendered interface independently of the add-on's
analyzer: English/German, both themes, all tabs, settings, exports, manual inputs,
validation errors, narrow layouts and hovered/keyboard-focused controls. The
minimum enabled text ratios are **5.399357:1 in light mode** and **5.551498:1 in dark
mode**. The 204 disabled-text samples have a minimum of **6.684011:1** and are
reported separately. All 9,436 non-text samples meet 3:1: field boundaries, SVG
strokes/fills and CSS focus outlines. The minima are **3.362789:1 light** and
**4.460262:1 dark**. Boundary/focus checks reject unsupported group opacity rather
than silently calculating the wrong composited color.

Page/manual color previews, font previews and swatches represent tested content
and are excluded. Decorative separators, hidden text, native select menus, OS
color-picker dialogs and checkbox interiors are outside this rendered sample.
The separate visual check covers manual fields and focus-ring containment in both
languages/themes at 280/380 px. This verifies nominal colors and sampled geometry,
not antialiasing or complete WCAG conformance. The historical old-build baseline
contained 616 failing text samples; it is not the current-build result.

The calculator uses only opaque #RGB/#RRGGBB entered by the user. Invalid partial,
alpha or non-HEX input removes stale results. Exact unrounded ratios determine
normal-text and large-text AA/AAA separately; copied reports identify the manual
scope, and no webpage snapshot or export is synthesized. Draft and caret survive
unrelated state messages and navigation, real selections take priority, and Clear
data restores black/white. No website access or scan is requested by calculation.
The native tests exercise the installed inline palette with real pointer clicks;
assistive-technology announcements remain a manual check. The manual calculator
does not open an operating-system color dialog.

Both the selected-element view and individual audit findings show AA and AAA
results simultaneously. Browser checks cover a normal-text value that passes AA
but fails AAA, its green-to-red change when the selected target changes, large
text with different thresholds, and unresolved or exempt results. The selected
target is labeled beside a status badge; meaning is not conveyed by color alone.
The computed-color matrix includes these states and colored suggestion ratios in
both themes. The separate AA/AAA judgments also survive copying an audit report.

Suggestion tiles are checked against their actual swatch colors and clipboard
bytes with HEX, RGB and HSL preferences. Both text-color and background-color
recommendations keep the unchanged counterpart in their before/after previews;
copying a recommendation preserves the original measurements and regular exports.
The text-contrast matrix also covers the prominent Show on page action and tile
copy controls in their normal, hovered and focused states.

Palette layout checks at widths of 280, 380 and 550 CSS px verify that white and
eight-digit alpha HEX values keep their copy controls below the value, aligned
with the swatch. Visible and copied HEX values are uppercase. Color and export
tests verify uppercase generated values without changing precise channels or
the original raw strings retained in JSON measurements.

Compact swatch checks cover contrast, colors, typography, layout, suggestions,
simulation and all four export formats. The squares measure 28 CSS px, retain
alpha checkerboards, and distinguish unsupported colors from transparent colors.
The English/German harness checks narrow layouts, computed fills, exact copied
values, export text and selection, and clipboard failure/retry behavior. Visual
decoration does not alter the serializer's bytes.

The latest review corrected delayed context-menu capture restoring an old tab,
late clipboard failures reviving discarded data, stale fallback text remaining
after a successful retry, an overflowing HSL hue throwing during parsing, and
Sass interpreting unquoted font names as expressions or null. Regression cases
cover these paths; the Sass tests compile actual element and page-token exports.
Audit reassessment and locale formatters are reused across repeated renders, and
the audit loop avoids a duplicate visibility check. No benchmark speedup is claimed.

The additional edge-case review covers generated empty pseudo-elements, text-heavy
elements, delayed operations and extreme color values. Generated
`::before`/`::after` content remains conservatively unassessable unless the bounded
separator proof above establishes separation, or it is empty with all checked
painting sources absent (including backgrounds, borders, outlines, shadows,
filters and native appearance). The 100/1,000-run limits bound range measurements and allocations before
creating results; truncating the final element still marks a partial result.
Element labels are computed once per measured element. HSL conversion avoids
endpoint cancellation; tests include finite near-black/near-white output and real
Sass compilation. Additional deterministic probes covered 30,000 color roundtrips
and 1,728 extreme HSL inputs without invalid colors or crashes.

Export drafts retain a cached serialization across unrelated renders. Tests cover
duplicate save clicks, a theme update while permission is pending, changes to the
draft or connection before the permission response, and data clearing. Retained
suggestions are invalidated when their target or selection changes, including
after reconnecting. Queued events from detached simulation panels cannot restore
old state after a reset.

Late picker failures are ignored after a newer selection request in the same
document. Superseded audit activation failures are also discarded before they
can affect a newer scan. Regression tests first reproduced both failures and
then verified the corrections, including preservation of cancellation/staleness
identity and errors from current requests.

Controlled download regressions cover completion before the download promise or
ownership write settles, duplicate completion, event-page restart recovery,
storage rejection and object-URL cleanup. Only explicit user cancellation is
reported as cancelled; disk and unknown interruption errors report failure.
These tests do not automate the native operating-system save dialog. Source
archive tests additionally exclude nested metadata, generated directories and
case-varied private filenames while retaining required build sources.

The rendered content fixture checks a labeled highlight beyond the former
one-second lifetime, follows a target inside a nested scroll container after
scrolling and resizing, and dismisses it with Escape. Lifecycle tests additionally
verify the eight-second timeout, zero-box range fallback, removal of a disconnected
target, and cleanup on picker handoff, rescan and navigation. They assert that
page text/input values are not read and target styles are not modified.

Pure analysis tests cover WCAG ratios and exact thresholds, large-text
classification, the independent `< 12` CSS-pixel rule, alpha composition, unknown
backgrounds, separate audit denominators and target reassessment. Suggestion tests
verify the final serialized colors, fixed counterpart, unsupported cases and
unreachable targets. Simulation tests use the published Machado matrices and
independently calculated reference vectors, with linear sRGB transfer functions.

Export tests compare deterministic fixture bytes and compile actual SCSS with
Dart Sass **1.105.2** and Tailwind v4 output with **4.3.3**, as fixed by the lockfile.
They exercise precise alpha, Unicode and multiword font names, negative margins,
unequal spacing, radius values, an altered Tailwind theme, unsafe input rejection,
separate original/suggestion sources and JSON privacy boundaries. The project JSON
schema is documented in `tests/fixtures/export/README.md`; it is not an industry
design-token format. Tests inspect its required fields and values.

Controlled runtime tests cover document/request identity, late replies, session
clearing, picker cancellation, BFCache cleanup, settings and download lifecycle
logic. Permission-request UI tests also check same-tab navigation while its token
is null, changed tabs, denied access and duplicate clicks. A fake storage or
download API does not prove native download prompts or operating-system save dialogs.

The source rebuild uses the packaging script's source allowlist and the actual
working files. It does not read Git history, sibling maintainer rules or private
marketing documents. It creates a temporary ZIP, extracts into a checked OS
temporary directory, installs the locked dependencies and compares runtime bytes.
This proves the captured source can reproduce the captured build; later edits
require another run.

## Reproduce the checks

Use Node.js 22 or later and npm from the repository root or an independently
extracted source directory. The recorded environment is **Windows 24H2 x64,
build 26100.9445, with Node.js 22.23.3 and npm 10.9.9**; dependencies are fixed by `package-lock.json`, including
esbuild **0.28.2** and sharp **0.35.5**. Windows 10/11 users can run the commands
in PowerShell. Exact operating-system compatibility beyond the recorded run must
not be inferred from the command examples.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run lint:extension
npm run test:ui
npm run test:contrast
npm run test:canvas
npm run test:firefox
npm run test:source
```

`npm run test:ui` runs both rendered harnesses. It uses an installed Microsoft
Edge by default; `UI_BROWSER_CHANNEL=chrome` selects installed Chrome. These are
headless tests of rendered UI and content logic, not Chromium extension tests.
The screenshot harness writes the nine views per supported language under the
configured external artifact directory.

`npm run test:contrast` checks actual computed text and background colors in the
built UI, writes `test-results/sidebar-contrast.json`, and rejects AA text-contrast
failures or own UI font sizes below 12 CSS px. It also checks a separate readability
goal of 4.5:1 for inactive labels and 3:1 for editable boundaries, SVG icons and focus outlines. `-- --baseline` records an old build's measurements
without asserting those improved thresholds.

`npm run build` generates the extension under the external artifact root's
`dist/` directory, by default `../Style-Inspector-Lite-artifacts/dist/`. Set
`ARTIFACTS_DIR` to choose a different external root. The npm lint, test and Firefox
start commands resolve this same build location. The source archive can create its
own external build directory without the owner's workspace or private rule files.

`npm run test:firefox` temporarily installs that external build in an isolated headless Firefox
profile. Set `FIREFOX_BINARY` and `GECKODRIVER` to select the executable paths.
The test enables geckodriver's `--allow-system-access` only for that test session.
Run separately with the declared minimum and current Firefox versions; preserve
their individual JSON result files. Installing a test binary alone is not a test.

`npm run test:canvas` runs the document-canvas fixture in Edge. Add `-- --firefox`
to run the same assertions in native Firefox with `FIREFOX_BINARY` and
`GECKODRIVER`. It uses a controlled message bridge for the built content script,
not an installed extension, and writes a browser-specific result file.

`npm run test:source -- --offline --cache /absolute/npm-cache` reuses a populated
npm cache without registry access. Omitting `--offline` permits npm's ordinary
dependency retrieval. The cache argument must be absolute. Build the external `dist` first;
the test deliberately compares its bytes instead of silently replacing the
reference build. It writes `test-results/source-rebuild.json` on success or
failure and verifies the generated temporary path before cleanup.

After the final checks, `npm run package` creates the unsigned installable ZIP
beside the repository and the source ZIP in the external version directory.
`-- --artifacts /external/artifacts` changes the build/source-release root;
`--runtime-dir /external/packages` changes the installable ZIP's directory.
Existing packages and release metadata are preserved. Inspect both archives'
allowlists and checksums. This command does not
sign, upload, create Git history or publish anything. See
[RELEASING.md](RELEASING.md) for the separate owner-controlled handoff.

## Implementation limits and remaining manual checks

The audit covers rendered text in the loaded HTTP/HTTPS main document, including
rendered offscreen content, without scrolling or loading additional content.
Frames, Shadow DOM text, image/canvas text and later dynamic content are excluded.
Webpage input values and editable text are not recorded. Form-control text coverage
is conservative and cannot establish that every control contains visible text.
Shown input placeholders use pseudo-element style metadata without reading their
contents. Exactly empty and hidden hints are excluded; whitespace-only hints
cannot be distinguished reliably without reading text. Populated inputs retain
the control-text uncertainty reason; textarea and editable text remain excluded.
Visibility checks exclude provably empty supported percentage `inset()` and
positioned `rect()` clipping regions, plus exactly empty supported non-root
overflow padding boxes for ordinary-flow text. A bounded glyph check excludes simple
single-fragment text wholly outside supported non-root overflow scrollports.
It preserves partially visible and document-offscreen text and does not resolve
every arbitrary clipping shape, typography or overflow combination.

An audit stops at 1,000 text runs or 20,000 visited elements; selection inspection
is bounded to 100 runs and 300 visited elements. Page palettes retain at most 128
colors and 64 CSS font-family entries. These are bounded samples, not exhaustive
design-token inventories. Changed or interrupted scans retain their limitations.

Overlap sampling covers at most 32 rectangles per direct text node. Longer
fragment lists retain a localized unassessed reason without changing the font-size
result. Transparent-wrapper inspection is also bounded and falls back to an
unassessed result when it cannot establish the absence of covering paint. Truly
empty text nodes, empty Range rectangle lists and opacity-zero feedback layers do
not establish covering paint by themselves. A nonempty text node with a zero-size
rectangle is not discarded. Offscreen flow checks require an enclosing opaque box and reject
transparent displacement or uncertain geometry; they do not resolve arbitrary
sibling surfaces.

Simple sRGB alpha composition and transparent ancestor background chains are
supported when they resolve to a known opaque background. A complete supported
chain can use the browser's document canvas color, resolved with the HTML root's
color scheme. Unknown shadow surfaces or top-layer backdrops prevent this
fallback; an unresolved canvas is not assumed white. Simple linear gradients with legacy sRGB colors or explicit
`in srgb` interpolation can establish a conservative minimum contrast for opaque
text. Bounds include every supported stop, intermediate color and uncovered base;
they do not locate individual colors behind the text. AA/AAA pass only when their
threshold is met throughout the bounds. Insufficient bounds remain unassessed,
never failures. Narrowly supported leading/trailing separators and keycaps do not
block contrast when their complete paint bounds are separate from the measured text.
Unsupported gradients, background images, other painted pseudo-elements, overlapping
painting, filters, blend modes, group opacity, shadows and unsupported color
spaces produce results labelled Not assessable. A background image hidden behind
a closer fully opaque background does not alone make contrast unassessable; group
opacity, filters and real overlapping paint remain conservative cases. This tool
does not perform pixel-level compositing or identify every possible overlay.
An explicitly labeled CSS color sample and its optional CSS-only ratio are not
measurements of painted contrast. Actual analysis stays unchanged; exports label
the optional calculated ratio separately and mark it unverified.

Suggestions require opaque sRGB text and a safely resolved solid background.
Placeholder measurements are excluded from suggestions and suggestion exports,
which currently target element properties rather than pseudo-element styles.
Changing the background also requires an owned opaque background. They concern
one measured text area, do not apply changes, and do not guarantee other states
or descendants. Simulation affects only sidebar preview surfaces and is an
approximation, not a medical model of an individual or an accessibility result.
CSS font families do not prove the font used for every glyph; the sidebar cannot
reuse unavailable page web fonts. The size heuristic does not measure transformed
glyphs or guarantee readability.

Before ordinary use or submission, manually verify the remaining native paths in
a separate test profile:

- Optional download permission denial, grant and revocation; native save-dialog
  cancellation; closing/replacing the sidebar during a pending save; saved bytes
  matching the preview and clipboard. No file should be reported saved merely
  because its download started.
- Multiple Firefox windows, rapid tab/document switches, navigation during a
  scan, settings synchronization, and global data clearing while late work is
  arriving. Controlled tests do not cover every native scheduling combination.
- First-use context menus during slow startup, removed targets, unsupported
  frames, browser-protected pages, assigned shortcuts and Sidebar replacement.
- Keyboard and screen-reader behavior, high zoom, native light/dark/system
  changes and both interface languages. Fixed geometry assertions alone are not
  a complete accessibility audit.
- Signed-package installation and update checks after Mozilla review.

No signed package, Mozilla acceptance, AMO listing or GitHub publication has been
verified by these local checks.
