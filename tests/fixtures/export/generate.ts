/** Explicit fixture maintenance; normal tests only compare these files. */
import { writeFileSync } from 'node:fs';
import { serializeExport } from '../../../src/core/exports';
import { suggestContrast } from '../../../src/core/suggestions';
import type { ExportSource } from '../../../src/core/types';
import { fixtureSnapshot } from './data';
const snapshot = fixtureSnapshot(), suggestion = suggestContrast(snapshot, snapshot.textRuns[0], 'AA').suggestions[0];
for (const kind of ['element', 'contrast-suggestion'] as const) for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
  const source: ExportSource = kind === 'element' ? { kind, snapshot } : { kind, snapshot, suggestion };
  const result = serializeExport(source, { format, version: '1.0.0' });
  writeFileSync(new URL(result.filename, import.meta.url), result.text);
}
