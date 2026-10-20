import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, artifactsRoot, resolveExternal } from './paths.mjs';
import { checkField } from './validate.mjs';

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const { version } = manifest;
if (version !== '1.0.1') throw new Error('Prepare version-specific release notes before generating submission documents for another version.');
const flag = process.argv.indexOf('--artifacts');
const artifacts = await resolveExternal(root, flag < 0 ? artifactsRoot : process.argv[flag + 1]);
const release = await resolveExternal(root, path.join(artifacts, 'releases', `v${version}`));
const metadata = JSON.parse(await readFile(path.join(release, 'build-metadata.json'), 'utf8'));
if (metadata.version !== version || metadata.signed !== false || metadata.published !== false) throw new Error('Expected matching unpublished unsigned packages; run npm run package first.');
const runtimeFile = await resolveExternal(root, path.resolve(release, metadata.runtimePackage));
const sourceFile = await resolveExternal(root, path.resolve(release, metadata.sourcePackage));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const [runtimeHash, sourceHash] = await Promise.all([hash(runtimeFile), hash(sourceFile)]);
const relative = file => path.relative(release, file).split(path.sep).join('/');
const english = 'Initial release.\n';
const german = 'Erstveröffentlichung.\n';
const reviewer = `Local CSS inspection and text-contrast checks in a native Firefox sidebar.

RELEASE
Initial release ${version}. Firefox Desktop ${manifest.browser_specific_settings.gecko.strict_min_version}+; English/German; MPL-2.0. No account or external service required.

SOURCE
Source ZIP required: esbuild 0.28.2 transpiles TypeScript and bundles modules; sharp 0.35.5 generates icons. No minification, obfuscation or remote code.
Tested with Node.js 22.23.3 and npm 10.9.9 on Windows x64. Extract the source ZIP; run npm ci, npm run typecheck, npm test, npm run build, npm run lint:extension. Output: ../Style-Inspector-Lite-artifacts/dist/. README.md and internal/RELEASING.md provide full instructions. No private files are needed.

PERMISSIONS
activeTab/scripting: explicit main-document inspection and highlights. menus: right-click inspection. storage: local preferences and bounded session analysis. clipboardWrite: explicit copies. Optional downloads: Save file only.
Optional HTTP/HTTPS access covers all websites. Check page/Check again requests it when missing; access persists until revoked. Denial leaves toolbar/context-menu activation available. Navigation alone never injects or scans.

DATA
No telemetry or data transmission. Webpage input values and editable text are not read or exported. Confirmed selections show bounded ordinary text excerpts for troubleshooting, with separate explicit copying; excerpts are excluded from storage, audits, hover previews and standard exports.

TESTING
Open an ordinary webpage, click the toolbar icon, then choose an element or start an audit. Right-click inspection selects the clicked element. Without a selection, Contrast offers a local HEX/color-picker calculator with normal/large AA/AAA ratings. Check highlights, rescan, exports and permission denial/grant.
Protected pages and embedded documents are excluded. Uncertain page contrast stays unassessed; CSS-pair thresholds are labeled separately. The <12 CSS-pixel hint is not a WCAG minimum. Automated evidence and remaining manual checks: internal/VALIDATION.md.
`;
const fields = { 'amo-changelog.en.txt': english, 'amo-changelog.de.txt': german, 'amo-reviewer-comment.en.txt': reviewer };
const counts = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, checkField(value, name)]));
const submission = `# AMO submission — ${version} (initial release)

Prepared for manual submission. Packages are unsigned; review and publication are pending.

Start at [Submit a new add-on](https://addons.mozilla.org/developers/addon/submit/distribution).
Use the two matching ZIPs below. Copy only the text inside each release-note or
reviewer block into the corresponding AMO field.

## Submission settings

| Field | Value |
| --- | --- |
| Distribution | On this site / Listed on AMO |
| Name / version | Style Inspector Lite / ${version} |
| Requested slug | style-inspector-lite — availability unconfirmed |
| Languages | English (default), German |
| Compatibility | Firefox Desktop ${manifest.browser_specific_settings.gecko.strict_min_version}+; no Android |
| License | Mozilla Public License 2.0 |
| Category | Web Development |
| Payment / account / external service | None required |
| Data collection | None; manifest declares required: ["none"] |
| Additional source upload | **Yes** — TypeScript and bundled JavaScript |
| Support email / website | Leave empty until public contact details are chosen |

Stable extension ID: \`${manifest.browser_specific_settings.gecko.id}\`.
Source repository: [Style Inspector Lite](https://github.com/alexandermayzel/Style-Inspector-Lite).

## Upload files and listing text

- **Add-on:** [${path.basename(runtimeFile)}](<${relative(runtimeFile)}>).
- **Source:** [${path.basename(sourceFile)}](<${relative(sourceFile)}>).
- **Listing summary and description:** [English](../../amo-description.en.md) · [German](../../amo-description.de.md). Copy only the text inside each block.

## Release notes

English:

\`\`\`text
${english}\`\`\`

German:

\`\`\`text
${german}\`\`\`

## Notes to reviewer

\`\`\`text
${reviewer}\`\`\`

## Verification

See the matching source archive's \`internal/VALIDATION.md\` and local \`verification.json\`. Native save-dialog and signed-package checks remain manual.

<details>
<summary>Package checksums and paste-field counts</summary>

SHA-256 (also recorded in [SHA256SUMS](SHA256SUMS)):

- Add-on: \`${runtimeHash}\`
- Source: \`${sourceHash}\`

Counts include a final newline; CRLF allows for Windows clipboard text. Each field is below 3,000 characters.

| Field | Codepoints LF | UTF-16 LF | Codepoints CRLF | UTF-16 CRLF |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(counts).map(([name, c]) => `| ${name} | ${c.codepointsLF} | ${c.utf16LF} | ${c.codepointsCRLF} | ${c.utf16CRLF} |`).join('\n')}

</details>

Mozilla guidance: [submission](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/), [source upload](https://extensionworkshop.com/documentation/publish/source-code-submission/), [data declaration](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
`;
await mkdir(release, { recursive: true });
for (const [name, value] of Object.entries(fields)) await writeFile(path.join(release, name), value, { flag: 'wx' });
await writeFile(path.join(release, 'RELEASE-NOTES.md'), english, { flag: 'wx' });
await writeFile(path.join(release, 'draft-metadata.json'), JSON.stringify({ name: `v${version}`, tag_name: `v${version}`, draft: true, generate_release_notes: false, remoteCreated: false, assetUploadsAuthorized: false }, null, 2) + '\n', { flag: 'wx' });
await writeFile(path.join(release, 'AMO-SUBMISSION.md'), submission, { flag: 'wx' });
console.log(JSON.stringify({ release, counts }, null, 2));
