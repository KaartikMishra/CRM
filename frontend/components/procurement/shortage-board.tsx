import { PackageSearch } from 'lucide-react';
import type { ShortageRow } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StandingQty } from './procurement-badges';

/**
 * The row's identity, mirroring how the server keys demand.
 *
 *   product:<id>   a catalogue-linked requirement
 *   name:<text>    free text, keyed by the exact string on the line
 *
 * Read from the identity fields themselves rather than from `linked`. The flag
 * and the data are two things that must agree, and deriving the key from the
 * flag means a disagreement — `linked: true` with no product, or a row missing
 * its name — produces a key like `name:undefined` instead of failing visibly.
 * Interpolating an absent value into a template literal is what makes that
 * silent: `name:${undefined}` is a perfectly good string, and two of them
 * collide.
 *
 * The fallback is deliberately not an array index. Rows are sorted by shortage
 * size, so they reorder as quantities change; an index key would reattach React
 * state to whichever row happens to land in that position. `salesOrderItemId`
 * would be no better here — a shortage row is an aggregate over many order
 * lines and has no single one to point at.
 */
export function rowKey(row: ShortageRow): string | null {
  if (row.product) return `product:${row.product.id}`;
  if (row.productName) return `name:${row.productName}`;
  return null;
}

/**
 * What to call the row.
 *
 * Both fields can carry the name, and which one does depends on the row: a
 * catalogued row has it on the Product, a free-text row has it on the line. So
 * neither field alone is sufficient — reading only `productName` blanks every
 * catalogued row, and reading only `product?.name` blanks every free-text one.
 * Taking the first that is present displays both, and leaves the component
 * working against either shape rather than only the newest one.
 */
export function displayName(row: ShortageRow): string {
  return row.product?.name ?? row.productName ?? '';
}

/**
 * What still has to be bought, by product.
 *
 * Shortage and standing sit side by side rather than being netted together:
 * a shortage is what the orders need, standing is stock already on the shelf
 * with nobody's name on it. Combining them into one number would hide the fact
 * that some of the gap can be closed by allocating rather than purchasing.
 */
export function ShortageBoard({ rows }: { rows: ShortageRow[] }) {
  /*
    Rows carrying no identity at all are dropped rather than rendered under an
    invented key: with neither a product nor a name there is nothing to show in
    the Product column and nothing to act on. Keys are built once, here, so the
    de-duplication below and the rendering below that cannot drift apart.
  */
  const identified = rows.flatMap((row) => {
    const key = rowKey(row);
    return key ? [{ row, key }] : [];
  });

  // Checked after filtering, so a payload of only unidentifiable rows shows the
  // empty state rather than a table with no body.
  if (identified.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-5 text-sm text-muted">
          <PackageSearch className="size-4 shrink-0" />
          Nothing outstanding — no open order needs stock that is not already on hand.
        </CardContent>
      </Card>
    );
  }

  const short = identified.filter(({ row }) => row.shortageQty > 0);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Requirement vs stock
        </h2>
        {short.length > 0 && (
          <span className="text-xs text-muted">
            {short.length} product{short.length === 1 ? '' : 's'} short
            {identified.some(({ row }) => !row.product && row.shortageQty > 0) &&
              ' · some need catalogue mapping'}
          </span>
        )}
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Required</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Allocated</TableHead>
              <TableHead className="text-right">Shortage</TableHead>
              <TableHead className="text-right">Standing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {identified.map(({ row, key }) => (
              <TableRow key={key}>
                <TableCell>
                  <span className="font-medium text-ink">{displayName(row)}</span>
                  {!row.product && (
                    /*
                      The demand is real and must be bought, so the row is here.
                      What it cannot yet do is take part in inventory: there is
                      no catalogue entry to hold stock against, which is why
                      On hand reads as a dash rather than zero.
                    */
                    <Badge variant="warning" className="ml-2 align-middle">
                      Not in catalogue
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular text-ink-2">{row.totalRequired}</TableCell>
                <TableCell className="text-right tabular text-ink-2">
                  {row.product ? row.onHand : <span className="text-muted">—</span>}
                </TableCell>
                <TableCell className="text-right tabular text-ink-2">{row.totalAllocated}</TableCell>
                <TableCell className="text-right">
                  <span className={row.shortageQty > 0 ? 'font-medium text-critical tabular' : 'text-muted tabular'}>
                    {row.shortageQty}
                  </span>
                </TableCell>
                <TableCell className="text-right"><StandingQty qty={row.standingQty} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}
