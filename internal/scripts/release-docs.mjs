import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, artifactsRoot, resolveExternal } from './paths.mjs';
import { checkField } from './validate.mjs';

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const { version } = manifest;
if (!['1.0.1', '1.0.2'].includes(version)) throw new Error('Prepare version-specific release notes before generating submission documents for another version.');
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
const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
const versionHeading = changelog.split(/\r?\n/).find(line => line.startsWith(`## ${version} — `));
const releaseDate = versionHeading?.slice(`## ${version} — `.length);
if (version === '1.0.2' && releaseDate !== 'Unreleased' && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate ?? '')) throw new Error('Missing release date or Unreleased heading.');
const datedRelease = releaseDate && releaseDate !== 'Unreleased';
const currentNotes = versionHeading ? changelog.split(versionHeading)[1]?.split(/^## /m)[0]?.trim() : undefined;
if (version === '1.0.2' && !currentNotes) throw new Error('Missing current release notes.');
const english = version === '1.0.1' ? 'Initial release.\n' : currentNotes.replace(/^### /gm, '') + '\n';
const german = version === '1.0.1' ? 'Erstveröffentlichung.\n' : `Hinzugefügt

- Seitenpaletten nach Verwendung gruppiert, mit Häufigkeiten, Sortierung, Fundstellen und direktem Farbvergleich mit ausdrücklicher Untergrundwahl bei Transparenz.
- Schriftübersichten nach Häufigkeit, mit sortierbaren Größen und Varianten, Fundstellen und Hinweisen auf ausgelassene Einträge bei Farb- oder Schriftgrenzen.
- Ganze Seite, anfangs sichtbaren Bereich oder Abschnitt prüfen, mit Dauer und Grenzen; Ergebnisse optional gruppieren und fehlende Werte nach Ursache filtern.
- Zwei vollständige manuelle Prüfungen desselben Dokuments und Umfangs vergleichen: neue, behobene, fortbestehende oder ungeprüfte Befunde. Entfernter Text gilt nie als behoben.
- Übersicht temporärer Analysen mit Messzeiten, geschätzter Größe und bestätigtem Löschen einzelner Tabs.
- Optionale Diagnosekopien, standardmäßig aus, sowie Vergleiche zwischen Audit-Befund und späterer Einzelprüfung desselben Textbereichs.

Behoben

- Abgeschnittene Zählerziffern und vollständig maskierter Text erzeugen keine falschen Befunde mehr; teilweise sichtbarer breiter Text wird im sichtbaren Bereich auf Überlagerungen geprüft.
- Geeignete Texte außerhalb des sichtbaren Bereichs behalten einen gekennzeichneten CSS-Farbvergleich. Unklare Masken bleiben ungeprüft; Ausschnittprüfungen beachten den Messumfang.
- Abweichende erste Zeilen/Buchstaben und Text außerhalb eingefärbter Hintergründe erzeugen keine falschen Erfüllt-Wertungen. Unklare Flächendeckung bleibt ungeprüft.
- Abgewiesene Prüfungen erhalten Ergebnisse und geben die Bedienung auch nach einer neuen Auswahl frei. Abbrüche und Speicherfehler vermischen keine Auswahlen und verlieren keine Einstellungen.
- Berichte bewahren Prüfumfang und Kontrast-Mindestwerte; Schriftbefunde bleiben Lesbarkeitshinweise. Begrenzte Vorschauen liefern vollständige Kopien. Audit-Filter und nachgeladene Schriften behalten den Tastaturfokus.
- Seitenwerte exportieren Farben und Schriften der gemessenen Übersicht, mit ausdrücklicher CSS-Alternative und eingefrorenem Entwurf.

Geändert

- Messungen werden nur noch auf Wunsch erneuert. Seitenänderungen markieren Ergebnisse als veraltet und beenden die Beobachtung, um Hintergrundlast zu senken.
- Audits, Einzel- und Hover-Analysen legen Rechenpausen ein und brechen überholte Arbeit ab. Lange Schriftlisten und Varianten laden schrittweise.
- Analysen bleiben nur im Arbeitsspeicher und entfallen beim Neuladen oder Browser-/Hintergrundneustart; Einstellungen bleiben erhalten. Verdrängte Ergebnisse und Referenzen werden auch auf der Seite freigegeben, ältere Vergleichsstände zuerst.
`;
const reviewer = `Local CSS inspection and text-contrast checks in a native Firefox sidebar.

RELEASE
${version === '1.0.1' ? 'Initial release' : 'Version'} ${version}${datedRelease ? ` (${releaseDate})` : ''}. Firefox Desktop ${manifest.browser_specific_settings.gecko.strict_min_version}+; English/German; MPL-2.0. No account or external service required.

SOURCE
Source ZIP required: esbuild 0.28.2 transpiles TypeScript and bundles modules; sharp 0.35.5 generates icons. No minification, obfuscation or remote code.
Tested with Node.js 22.23.3 and npm 10.9.9 on Windows x64. Extract the source ZIP; run npm ci, npm run typecheck, npm test, npm run build, npm run lint:extension. Output: ../Style-Inspector-Lite-artifacts/dist/. README.md and internal/RELEASING.md provide full instructions. No private files are needed.

PERMISSIONS
activeTab/scripting: explicit main-document inspection and highlights. menus: right-click inspection. storage: local preferences and session document authorization metadata, never measurements. clipboardWrite: explicit copies. Optional downloads: Save file only.
Optional HTTP/HTTPS access covers all websites. Check page/Check again requests it when missing; access persists until revoked. Denial leaves toolbar/context-menu activation available. Navigation alone never injects or scans.

DATA
No telemetry or transmission. Analyses stay in memory and reset on page reload or browser/background restart. Input values and editable text are not read. Confirmed selections show bounded ordinary text excerpts with explicit copying; excerpts stay out of storage, audits, hover previews and standard exports. Optional diagnostic copies contain bounded, sanitized paint-layer data without text, HTML, selectors or URLs; they are not persisted or transmitted.

TESTING
${version === '1.0.1' ? 'Open an ordinary webpage, click the toolbar icon, then choose an element or start an audit. Right-click inspection selects the clicked element. Contrast offers a local HEX/RGB/color-picker calculator with normal/large AA/AAA ratings; palette colors can populate it, and transparent backgrounds require an opaque underlay. Check palette/font occurrences, grouped results, diagnostic copies, highlights, rescan, exports and permission denial/grant.' : 'Open an ordinary webpage, click the toolbar icon, then select an element or start an audit. Test right-click inspection, the local contrast calculator (transparent backgrounds need an opaque underlay), palette/font occurrences, highlights, exports and permission denial/grant. Enable diagnostics in Settings for explicit copies. Test page/visible-area/section scopes, two manual audit comparisons, rejected section rescans, inventory limit notices and per-tab deletion in the retained-analysis overview. All refreshes stay explicit.'}
Protected pages and embedded documents are excluded. Uncertain page contrast stays unassessed; CSS-pair thresholds are labeled separately. The <12 CSS-pixel hint is not a WCAG minimum. Automated evidence and remaining manual checks: internal/VALIDATION.md.
`;
const fields = { 'amo-changelog.en.txt': english, 'amo-changelog.de.txt': german, 'amo-reviewer-comment.en.txt': reviewer };
const counts = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, checkField(value, name)]));
const submission = `# AMO submission — ${version} (${version === '1.0.1' ? 'initial release' : datedRelease ? releaseDate : 'unreleased local test'})

Prepared for manual submission. Packages are unsigned; review and publication are pending.

Start at the [AMO Developer Hub](https://addons.mozilla.org/developers/). For an update, submit a new version of the existing add-on.
Use the two matching ZIPs below. Copy only the text inside each release-note or
reviewer block into the corresponding AMO field.

## Submission settings

| Field | Value |
| --- | --- |
| Distribution | On this site / Listed on AMO |
| Name / version | Style Inspector Lite / ${version} |
${datedRelease ? `| Release date | ${releaseDate} |\n` : ''}| AMO listing | [style-inspector-lite](https://addons.mozilla.org/firefox/addon/style-inspector-lite/) |
| Languages | English (default), German |
| Compatibility | Firefox Desktop ${manifest.browser_specific_settings.gecko.strict_min_version}+; no Android |
| License | Mozilla Public License 2.0 |
| Category | Web Development |
| Payment / account / external service | None required |
| Data collection | None; manifest declares required: ["none"] |
| Additional source upload | **Yes** — TypeScript and bundled JavaScript |
| Support website | https://github.com/alexandermayzel/Style-Inspector-Lite/issues |

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
const releaseNotes = version === '1.0.1' ? english : `${datedRelease ? `Release date: ${releaseDate}\n\n` : ''}${english.replace(/^(Security|Added|Fixed|Changed|Removed)$/gm, '## $1')}`;
await writeFile(path.join(release, 'RELEASE-NOTES.md'), releaseNotes, { flag: 'wx' });
await writeFile(path.join(release, 'draft-metadata.json'), JSON.stringify({ name: `v${version}`, tag_name: `v${version}`, draft: true, generate_release_notes: false, remoteCreated: false, assetUploadsAuthorized: false }, null, 2) + '\n', { flag: 'wx' });
await writeFile(path.join(release, 'AMO-SUBMISSION.md'), submission, { flag: 'wx' });
console.log(JSON.stringify({ release, counts }, null, 2));
