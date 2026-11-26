/**
 * A sankey written with a CSV header row (`Source,Target,Value`) for Pele.
 *
 * Pele 1.10+ reads every row as a flow and stops with "Expecting a number"
 * when a value is not a number (Pele #60), so a header row made the whole
 * diagram fall back to Mermaid. Mermaid and Pele 1.3 drew the header as a
 * flow of 0 from a "Source" node to a "Target" node. This reads it as what
 * the author meant, a header: the first row is blanked when its value is
 * not a number by Pele's own test (`parseFloat`). The line stays, empty, so
 * an error further down still names its line as written. Every later row is
 * left as written, so a bad value there is still Pele's error.
 */

const SANKEY_KEYWORD = /^\s*sankey(?:-beta)?\s*$/;

/** The row's fields, split on commas outside double quotes, quotes removed. */
function csvFields(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (quoted) {
      if (char === '"' && row[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

const isQuiet = (line: string) => line.trim() === '' || line.trimStart().startsWith('%%');

/** The source with a sankey's header row blanked; any other source as it is. */
export function withoutSankeyHeader(source: string): string {
  const lines = source.split('\n');
  let index = 0;
  if (lines[0]?.trim() === '---') {
    index = lines.findIndex((line, at) => at > 0 && line.trim() === '---') + 1;
    if (index === 0) return source;
  }
  while (index < lines.length && isQuiet(lines[index]!)) index++;
  if (index >= lines.length || !SANKEY_KEYWORD.test(lines[index]!)) return source;
  index++;
  while (index < lines.length && isQuiet(lines[index]!)) index++;
  if (index >= lines.length) return source;
  const row = lines[index]!;
  const fields = csvFields(row.replace(/\r$/, ''));
  if (fields.length !== 3 || Number.isFinite(parseFloat(fields[2]!))) return source;
  lines[index] = row.endsWith('\r') ? '\r' : '';
  return lines.join('\n');
}
