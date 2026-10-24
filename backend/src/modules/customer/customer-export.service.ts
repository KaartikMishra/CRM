/**
 * All Customers — the CSV export.
 *
 * ### The exported set is the filtered set, not the visible page
 *
 * The export runs the same `listDirectory` the page does, with the same query,
 * and then pages through it until exhausted. Exporting only the current page
 * would be the more obvious implementation and the wrong one: somebody who
 * filters to "repeat customers in Maharashtra" and clicks Export means all of
 * them, and a file silently containing the first twenty-five would be worse
 * than no file at all.
 *
 * ### Ordering is deterministic
 *
 * The query's own sort is honoured, and every ordering in the directory ends in
 * `id`, so two exports of unchanged data are byte-identical. Without that the
 * file would be unusable for comparing two points in time.
 *
 * ### Which fields leave the building
 *
 * The directory's own columns and nothing more. Deliberately absent: the
 * address (not shown in the directory either), `updatedAt`, and anything about
 * the account that created the record. A field is not exported merely because
 * it exists in the row — an export is a copy that leaves the CRM's access
 * controls behind, so the set is the narrow one the directory already shows to
 * the same permission.
 */

import {
  categoriseSource,
  csvDocument,
  csvFilename,
  type CustomerDirectoryQuery,
  type CustomerDirectoryRow,
} from '@rs/shared';
import { listDirectory } from './customer-directory.service.js';

/**
 * How many pages the export will walk before stopping.
 *
 * A ceiling rather than a trust in termination: a cursor bug would otherwise
 * loop forever holding a response open. At 100 rows a page this allows 50,000
 * customers, which is far beyond the current catalogue and still bounded.
 */
const MAX_PAGES = 500;
const PAGE_SIZE = 100;

const HEADER = [
  'Customer Id',
  'Name',
  'Company',
  'Type',
  'Phone',
  'Email',
  'State',
  'Country',
  'First Touch Source',
  'First Touch Category',
  'Last Touch Source',
  'Last Touch Category',
  'Valid Orders',
  'Verified Purchase Value (INR)',
  'Average Order Value (INR)',
  'Repeat Customer',
  'Last Purchase',
  'Last Enquiry',
  'Possible Duplicate',
  'Customer Since',
] as const;

/** An ISO instant as a plain date, or empty. Never a zero or an epoch. */
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

function rowOf(row: CustomerDirectoryRow): (string | number)[] {
  const first = categoriseSource(row.firstTouch.source, row.firstTouch.sourceOther);
  const last = categoriseSource(row.lastTouch.source, row.lastTouch.sourceOther);

  return [
    row.id,
    row.name,
    row.companyName ?? '',
    row.type,
    row.phone ?? '',
    row.email ?? '',
    row.state ?? '',
    row.country ?? '',
    /*
      Both the stored value and its reporting category. The original is the
      system of record and a reader checking an attribution needs it; the
      category is what a pivot table can group on.
    */
    first.original,
    first.category,
    last.original,
    last.category,
    row.validOrderCount,
    row.verifiedPurchaseValue,
    // Empty, not '0.00': a customer with no valid orders has no average, and a
    // zero here would be averaged into a cohort figure as though it were one.
    row.averageOrderValue ?? '',
    row.isRepeatCustomer ? 'Yes' : 'No',
    day(row.lastPurchaseAt),
    day(row.lastEnquiryAt),
    row.hasDuplicateCandidate ? 'Yes' : 'No',
    day(row.createdAt),
  ];
}

/**
 * Builds the file.
 *
 * Returns the body and a filename; the controller sets the headers, following
 * the payroll register's division of labour — `Content-Disposition` is a
 * transport concern rather than a service one.
 */
export async function exportDirectoryCsv(
  query: CustomerDirectoryQuery,
): Promise<{ filename: string; csv: string; rowCount: number }> {
  const rows: CustomerDirectoryRow[] = [];

  /*
    Paged rather than one unbounded query, because `listDirectory` is the only
    thing that knows how to apply the derived filters and the aggregate sort.
    Re-running it is what guarantees the file matches the screen.
  */
  let cursor: string | undefined;
  let page = 1;

  for (let i = 0; i < MAX_PAGES; i += 1) {
    const result = await listDirectory({
      ...query,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(query.page !== undefined || cursor === undefined ? { page } : {}),
    });

    rows.push(...result.customers);

    if (result.pagination.mode === 'keyset') {
      if (!result.pagination.nextCursor) break;
      cursor = result.pagination.nextCursor;
    } else {
      if (page >= result.pagination.totalPages) break;
      page += 1;
    }
  }

  return {
    filename: csvFilename('rs-customers'),
    csv: csvDocument(HEADER, rows.map(rowOf)),
    rowCount: rows.length,
  };
}
