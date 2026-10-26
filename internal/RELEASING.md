# Local builds and release preparation

The manifest is the authoritative add-on version. Keep package and lockfile root metadata equal to it; the UI reads the built manifest. Version 1.0.1 remains the initial release. Version 1.0.2 is prepared for Mozilla submission with release date 2026-10-26. GitHub preparation remains a draft; publication and asset uploads are manual. Builds never increment versions. Advance once to the next patch only after a confirmed publication, unless the owner chooses another version.

## Reproduce a source build

Use Node.js 22 or later. The recorded environment is **Windows 24H2 x64, build 26100.9445, with Node.js 22.23.3 and npm 10.9.9**. Windows 10/11 users can run these commands in PowerShell after installing [Node.js with npm](https://nodejs.org/en/download). Install the recorded Node/npm versions when reproducing the submitted package. These command examples do not establish that every Windows version or another operating system has been tested; cross-platform equivalence must be checked before it is claimed.

Extract `style-inspector-lite-1.0.2-source.zip` into an empty directory, then open a terminal in that directory, alongside `package.json` and `package-lock.json`. It can be anywhere outside the original workspace. Run:

```sh
node --version
npm --version
npm ci
npm run typecheck
npm test
npm run build
npm run lint:extension
```

The default generated extension is **`../Style-Inspector-Lite-artifacts/dist/`**, relative to the extracted source directory. The builder creates the external directory when needed. The source `manifest.json` is copied there with generated scripts, icons, HTML/CSS and locales; the source manifest alone is not a working extension. Load **`../Style-Inspector-Lite-artifacts/dist/manifest.json`** in `about:debugging` for a temporary installation. The repository contains no generated `dist` directory.

An optional `ARTIFACTS_DIR` environment variable selects another external artifact root, with the extension under its `dist/` child. The lint, browser-test and Firefox-start scripts resolve the same build location. When reviewing an extracted source archive, clear a developer-specific `ARTIFACTS_DIR` override or set it to a fresh external directory. For example, from the extracted source directory in PowerShell:

```powershell
$env:ARTIFACTS_DIR = Join-Path (Split-Path (Get-Location) -Parent) 'Style-Inspector-Lite-review-artifacts'
npm run build
npm run lint:extension
```

The build needs no pre-existing sibling rule files, marketing documents, secrets, signed files or repository history. `npm ci` retrieves the exact dependencies from `package-lock.json`; a populated npm cache can supply them offline. All sources, local constants, the original logo and build scripts needed for output are in the source archive. Sass, Tailwind, TypeScript, esbuild, image tooling and test tools are development dependencies only.

**Build transformations:** esbuild **0.28.2** transpiles TypeScript to JavaScript and bundles local modules using `bundle: true`, `minify: false`, a Firefox 142 target and IIFE output. The build does not use webpack or obfuscation. TypeScript's separate check uses `--noEmit`. sharp **0.35.5** generates the icon files. Dependencies and their transitive versions are fixed by the lockfile.

The build crops only the original circular symbol from `assets/logo-source.png` with fixed reviewed coordinates, then produces icon sizes. The source logo is never overwritten. No runtime network requests or compilers are bundled.

## Check before packaging

Run the unit/integration suite, `npm run test:ui`, `npm run test:contrast` and the native Firefox harness. Review the generated screenshots in both languages and themes, including narrow layouts. Check the English README against actual behavior and testing evidence. Runtime/source ZIPs use separate allowlists, deterministic timestamps, forward-slash names and the working files rather than a Git commit. Inspect archive contents and SHA-256 hashes. Rebuild from an extracted source archive and compare runtime bytes.

For paint changes, also run `npm run test:paint` with the same Firefox binaries.
This checks first-line/letter styles, escaped and partial backgrounds, rounded
corners, clipped previews and the document canvas.

For measurement or scheduling changes, also run `npm run test:performance`
(Edge) or `npm run test:performance -- --firefox` with `FIREFOX_BINARY` and
`GECKODRIVER` set to local executables. Run timing probes without concurrent
browser tests. These synthetic fixtures assert bounded passive work and correct
results; reported timings are observations, not hardware-independent thresholds.

Run `npm run package`. For version 1.0.2, the default output paths, relative to the source directory, are:

- **Unsigned installable ZIP:** `../style-inspector-lite-1.0.2.zip`.
- **Matching source ZIP:** `../Style-Inspector-Lite-artifacts/releases/v1.0.2/style-inspector-lite-1.0.2-source.zip`.
- **Build metadata, checksums and submission documents:** `../Style-Inspector-Lite-artifacts/releases/v1.0.2/`.

`SHA256SUMS` resolves package paths relative to that release directory, including the installable ZIP outside it. `build-metadata.json` records the `runtimePackage` and `sourcePackage` paths so their different locations remain explicit.

The installable filename deliberately has no `-unsigned` suffix; its contents are still **unsigned**. Do not describe it as signed or suitable for permanent installation in ordinary Firefox.

`npm run package -- --artifacts <external-directory>` selects the external build and source-release root. `--runtime-dir <package-directory>` separately selects the directory containing the installable ZIP; its default is the source directory's parent. Both options may be combined. The script resolves real paths and symlinks, rejects destinations inside the repository, and refuses to overwrite packages or their metadata. For another local package use distinct artifact and package directories. Preserve signed and published files.

Earlier unpublished 1.0.0 packages remain in their existing release and archive locations. They are development handoffs, not a previous public release.

After packaging, run `npm run prepare:release-docs` to create `AMO-SUBMISSION.md`, release notes and the three checked paste fields in the release directory. The submission file links the short English/German listing summaries and descriptions at the external artifact root.

For the initial 1.0.1 release, the owner requested only "Initial release." / "Erstveröffentlichung." and no separate changelog. Future update notes use nonempty categories in the shared order Security, Added, Fixed, Changed, Removed, translated for German. Keep one blank line after headings and between categories. Reviewer text is separate, with text directly below each section heading.

Check every AMO field independently for at most 3000 characters, including CRLF and a copied final newline, counting both Unicode codepoints and UTF-16 units. The checker rejects excessive fields instead of truncating them.

## Manual Firefox checks

Use a separate test profile and `tests/fixtures/page.html` served over localhost. Verify:

1. Toolbar and assigned shortcut open a fresh audit view without starting analysis; a repeated toolbar click preserves an open tab and scroll position.
2. Keep the sidebar open and navigate to another HTTP/HTTPS website. An explicit Check page/Check again click can request optional access to all HTTP/HTTPS websites if document access is missing. Deny it and verify toolbar/context-menu activation still works. Grant it and verify subsequent deliberate scans on other websites need no renewed grant. Revoke it and check the fallback again. Opening, navigation and permission changes alone must never start a scan; navigation must not inject the inspector. Verify this with and without the optional grant.
3. First-use context menu inspection opens a closed sidebar and selects exactly the clicked element. Check slow startup, a removed target and unsupported frame targets.
4. Pick links, labels, form buttons and JavaScript buttons. Check pointerdown/mousedown/click suppression; Escape, sidebar replacement, tab changes and navigation remove the overlay. Normal actions work afterward.
5. Audit mixed text, gradients, transparency, 11.99/12-pixel text, cancellation and changing documents. Contrast uncertainty must not suppress measurable size warnings. DOM changes, scrolling and resizing mark old audit/selection results stale without remeasurement or new scans. Verify repeated page changes remain idle after the first stale notification, and explicit Measure again/Check again refresh the requested results.
6. Open another Firefox window. Verify document separation, live preference updates, clearing analysis across windows, and settings reset without data loss or revoking optional permissions. Reload a measured page: results must disappear without an automatic scan. Restart the browser/background: no analysis should be restored. Extension storage must contain no snapshots or audit runs; preferences remain saved.
7. Export all supported source/format combinations, including measured overview versus raw element CSS for page values. Deny then grant optional downloads, cancel a save dialog, and close the sidebar during a pending save. Compare preview, clipboard and saved bytes. Revoke permission and verify a new deliberate save is required.
8. Check AA/AAA switching, original versus suggested exports, palette candidates, and simulation invariance. Suggestions never modify page CSS.
9. Check dark/light/system appearance, both UI languages, keyboard navigation, narrow widths and zoom. Protected pages should show an honest unsupported explanation.
10. Open matching elements from palette colors, font families, sizes and weight/line-height variants. Inspect a match and return to the list; a fresh audit must replace obsolete associations. Group identical findings and check that totals and access to each member remain unchanged.
11. Send palette colors to the manual calculator. Keep fractional color and alpha values intact; require an explicitly chosen opaque underlay for transparent backgrounds. Return without losing the selected element.
12. Confirm that diagnostic buttons are hidden by default, then enable Show diagnostic button in Settings. Copy diagnostics for an uncertain finding or a selected text area. Check the clipboard fallback and discard late replies after navigation, rescan, a changed selection or disabling the option. Reset settings must hide the buttons again. Reports must exclude webpage text, HTML, selectors and addresses.
13. Run two complete manual audits of the same document and scope. Repair one finding, introduce another and remove a failing text area. Verify resolved, new and unassessed classifications; removed text must never count as repaired. Change target, viewport or scope and verify consistent reassessment or an explanation that comparison is unavailable.
14. Keep a completed audit, remove the selected scan root, then request a section scan. The rejected start must retain the old results and history. Cancel during a large single element and check that work stops promptly. Overflow the color/font inventory and verify the corresponding limit notice without warning at an exact limit.
15. Open the retained-analysis overview explicitly. Verify no automatic refresh, readable tab labels, per-tab confirmation, Escape cancellation and deletion without closing the page or clearing another tab. Leave the view while loading; late responses must not restore an obsolete confirmation or list.

## Owner-controlled publication

For AMO's question about generated/preprocessed code, select **Yes**. TypeScript transpilation, esbuild bundling and generated icons mean this submission includes a build step, even with `minify: false`. Upload the matching source archive with its lockfile and the build instructions above. Mozilla explicitly requires source for bundling and preprocessing, with the operating system, tool versions and commands needed to reproduce the installed bytes. [Mozilla source code submission guidance](https://extensionworkshop.com/documentation/publish/source-code-submission/).

Upload the unsigned ZIP and corresponding source archive to AMO manually. Paste the separately checked public English/German release notes and English reviewer notes. After Mozilla review, obtain the signed XPI without renaming an unsigned ZIP to pretend it is signed; verify its manifest and hash. A local test or lint result is not Mozilla approval.

Git staging, commits, tags, pushes, pull requests, releases and uploads require a separate explicit owner instruction. A specifically requested GitHub release must remain a draft named/tagged `vX.Y.Z`, with `draft: true` and `generate_release_notes: false`, using curated English notes. Asset upload is a distinct action. Publication remains manual. There are no automated remote-writing scripts.
