import { PackageSearch } from 'lucide-react';
import type { ShortageRow } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  ContentRegion,
  ContentScrollArea,
  contentCard,
} from '@/components/common/content-page';
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
 * The row's identity, mirroring how the server keys demand and supply.
 *
 *   rs:<id>        a line naming an RS Product
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
  if (row.rsProduct) return `rs:${row.rsProduct.id}`;
  if (row.productName) return `name:${row.productName}`;
  return null;
}

/**
 * What to call the row.
 *
 * Both fields can carry the name, and which one does depends on the row: a
 * mapped row has it on the RS Product, a free-text row has it on the line. So
 * neither alone is sufficient — reading only `productName` blanks every mapped
 * row, and reading only `rsProduct?.title` blanks every free-text one. Taking
 * the first that is present displays both, and leaves the component working
 * against either shape rather than only the newest one.
 */
export function displayName(row: ShortageRow): string {
  return row.rsProduct?.title ?? row.productName ?? '';
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
          Nothing to buy — every open order&apos;s outstanding demand is covered by CRM stock.
        </CardContent>
      </Card>
    );
  }

  const short = identified.filter(({ row }) => row.shortageQty > 0);

  return (
    <ContentRegion>
      <div className="flex shrink-0 items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Requirement vs stock
        </h2>
        {short.length > 0 && (
          <span className="text-right text-xs text-muted">
            {short.length} product{short.length === 1 ? '' : 's'} needing stock
            {identified.some(({ row }) => !row.rsProduct) &&
              ' · some rows are not mapped to RS Products'}
          </span>
        )}
      </div>

      {/* Its own scroll region: reading to the end of this list must not
          carry the purchase bills below it off the screen. */}
      <Card className={contentCard}>
        <ContentScrollArea>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Required</TableHead>
                {/*
                  TWO stock columns, because there are two numbers.

                    CRM stock  →  what the business has counted, kept by hand
                    RS stock   →  Shopify's sellable quantity, overwritten by sync

                  A single column here used to carry the CRM figure under the label
                  "RS stock", which read as a fact about the storefront and was
                  not one. They are separate columns now and neither is derived
                  from the other; where they disagree, that is a real signal.

                  Both sit beside the shortage and neither is subtracted from it —
                  the shortage is what the open orders still need, and stock is
                  shared across all of them. CRM stock is the figure that decides
                  whether a row appears at all.
                */}
                <TableHead className="text-right">CRM stock</TableHead>
                <TableHead className="text-right">RS stock</TableHead>
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
                    {!row.rsProduct && (
                      /*
                        The demand is real and must be bought, so the row is here.
                        What it cannot yet do is take part in allocation: nobody
                        has said which product these goods are, and allocation
                        matches on that identity alone — never on the wording.
                      */
                      <Badge variant="warning" className="ml-2 align-middle">
                        Not mapped
                      </Badge>
                    )}
                  </TableCell>
                  {/*
                    Its own column rather than a suffix on the name: a buyer
                    checking a delivery note reads down SKUs, and a value tucked
                    after a title of unpredictable length cannot be read that way.
                  */}
                  <TableCell className="font-mono text-[11px] text-muted">
                    {row.sku ?? <span className="text-faint">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular text-ink-2">{row.totalRequired}</TableCell>
                  {/*
                    Null is a dash in both columns, never a zero. "No RS Product is
                    mapped, so there is no stock figure to state" and "there are
                    none in stock" are different facts, and a zero would conflate
                    them — on an unmapped row the first is always what is true.
                  */}
                  <TableCell className="text-right tabular text-ink-2">
                    {row.crmStockQty === null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      row.crmStockQty
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular text-ink-2">
                    {row.rsStockQty === null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      row.rsStockQty
                    )}
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
        </ContentScrollArea>
      </Card>
    </ContentRegion>
  );
}
