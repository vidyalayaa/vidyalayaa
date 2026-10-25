export function parseCsv(text: string) {
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unclosed quote in CSV.');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function csvRecords(text: string, allowedColumns?: readonly string[]) {
  const rows = parseCsv(text),
    header = rows.shift()?.map((h) => h.trim().toLowerCase());
  if (!header?.length || rows.length < 1 || rows.length > 500)
    throw new Error('Include a header and 1–500 records.');
  if (header.some((h) => !h) || new Set(header).size !== header.length)
    throw new Error('Each column must have a unique, non-empty name.');
  const unknown = allowedColumns && header.filter((h) => !allowedColumns.includes(h));
  if (unknown?.length)
    throw new Error(`Unknown columns: ${unknown.join(', ')}. Download the current CSV template.`);
  return rows.map((row, i) => {
    if (row.length !== header.length)
      throw new Error(
        `CSV row ${i + 2}: expected ${header.length} cells, received ${row.length}. Check commas and quotes.`,
      );
    return Object.fromEntries(
      header.flatMap((h, n) => (row[n]?.trim() ? [[h, row[n].trim()]] : [])),
    );
  });
}

export function saveCsv(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
