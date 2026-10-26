# Export fixtures

These local fixtures are illustrative input data, never production fallback data.
`data.ts` fixes the timestamp, 1280 × 800 page viewport, a 11.99 CSS-pixel text run
with `#aaaaaa` on white, measured CSS width 160px and a distinct visual width 200px.
The contrast suggestion changes only the foreground, remains unapplied, and must
satisfy the AA threshold after parsing its exact serialized value.

The eight output files exercise CSS, SCSS, schema-version-2 JSON and Tailwind v4
for original measurements and a separate recommendation. Tests compare exact
bytes, compile Sass and Tailwind, and remeasure the emitted suggestion color.
Formatted HEX values use uppercase letters; JSON `raw` fields retain the input.
`generate.ts` deliberately regenerates them; normal tests do not alter fixtures.

The JSON schema is a project format, not DTCG or Figma. Its discriminator is
`kind` (`element`, `page-tokens`, `audit`, `contrast-suggestion`). `metadata`
contains measurement time, page viewport and limitations; `generator.version`
is the supplied manifest version. Element exports contain safe original and
formatted declarations, separate derived visual geometry and `textRuns`.
Audit exports contain the same run-level contrast and independent nonnormative
12px font-size rule, rule definitions and distinct counting objects. References
are neutral sequence numbers; no selectors, input text, tab or document tokens
are serialized. Shown-placeholder measurements carry optional `textSource:
"placeholder"` metadata, without their text contents. Element CSS exports still
describe the element itself; placeholder color suggestions are not supported.
Page-token exports can explicitly choose `inventory: "measured"` for the bounded
Colors/Typography overview (including placeholder styles and resolved surfaces)
or `inventory: "css"` for raw element properties. The JSON records that choice;
text formats label it in their generated header. Calls without this option keep
the existing raw-CSS contract. Both use stable generated names, omit private
references and ignore display-only sorting or filters.
Supported linear gradients carry optional `backgroundRange: { min, max }`
metadata: opaque, componentwise sRGB bounds, not actual sampled colors. Their
`effectiveBackground` is null and `contrast.ratioKind` is `"minimum"` when a lower
bound is available. The unrounded ratio establishes passes only; an insufficient
bound leaves AA or AAA manual with reason `gradient-contrast-inconclusive`.
Exports preserve these distinctions when changing the target. Gradient ranges
do not become CSS backgrounds or color suggestions.
When page contrast remains unassessed but a solid CSS color pair is known,
`textRuns` may include a separate `cssColorContrast` object with `ratio`,
`category`, `basis: "css-colors"`, `omitted: "page-layers-and-effects"` and
`verified: false`. Known text categories also include `AA` and `AAA` objects
with `threshold` and `status` (`pass` or `fail`) for that CSS pair only.
Unknown text size or weight omits those comparisons. The original `contrast`
object and audit counters continue to describe actual page verification;
CSS-only outcomes do not replace them.
A suggestion includes its exact color change, original pair, unrounded ratios,
conditions, algorithm version and `applied: false`. A foreground correction for
measured text fill also includes `additionalDeclarations` with
`{ "property": "-webkit-text-fill-color", "value": "currentColor" }`. CSS, SCSS and
Tailwind emit that reset too, so a fixed fill cannot ignore the proposed `color`.
These declarations are derived from the measured run, not accepted from a
caller-supplied patch. Original element and audit exports remain unchanged.

Machado reference-vector tests independently apply the published severity-1.0
matrix's first column to linear red, clamp channels, then encode using
`255 * (1.055 * channel ** (1 / 2.4) - 0.055)` (or the linear toe). They compare
unrounded preview channels within 0.001 of an 8-bit channel, including near-neutral
roundoff caused by the six-decimal published matrices. Grayscale uses relative
linear sRGB luminance, separately from the three dichromacy transformations.
