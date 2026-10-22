import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
  ContentScrollArea,
} from '@/components/common/content-page';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { AlertHistoryTable, MonitoredTable, variantLabel } from '@/components/rs-products/alert-tables';
import {
  AddMonitorForm,
  LowStockPopup,
  MonitorControls,
} from '@/components/rs-products/alert-controls';
import {
  fetchAlertHistory,
  fetchAlertSummary,
  fetchMonitorCandidates,
  fetchMonitoredVariants,
} from '@/lib/rs-product-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Inventory Alerts' };

type Search = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Inventory Alerts.
 *
 * Watches CRM stock — `crmStockQty`, the hand-maintained count — against a
 * threshold chosen per variant. Shopify's `inventoryQty` is shown beside it for
 * context and never used in a decision: it is overwritten by every sync and
 * says nothing about what the warehouse holds.
 *
 * Gated on RS_PRODUCTS VIEW to read and EDIT to configure, reusing the module
 * the catalogue already uses. The API enforces both again on its own authority;
 * this only decides what is worth rendering.
 *
 * Four requests in parallel rather than in sequence: the summary, the monitored
 * list, the history and — only when the viewer may edit and has searched — the
 * candidate picker.
 */
export default async function InventoryAlertsPage({ searchParams }: { searchParams: Search }) {
  const access = await requireModule('RS_PRODUCTS');
  if (!access.allowed) return <NoModuleAccess module="RS_PRODUCTS" />;
  if (!can(access.user, 'RS_PRODUCTS', 'VIEW')) return <NoModuleAccess module="RS_PRODUCTS" />;

  const canEdit = can(access.user, 'RS_PRODUCTS', 'EDIT');
  const params = await searchParams;
  const q = first(params.q);
  const addQuery = first(params.add);

  const [summary, monitored, history, candidates] = await Promise.all([
    fetchAlertSummary(),
    fetchMonitoredVariants({ ...(q ? { q } : {}) }),
    fetchAlertHistory({ status: 'RESOLVED' }),
    // Only fetched when somebody is actually searching for a variant to add.
    canEdit && addQuery ? fetchMonitorCandidates({ q: addQuery }) : null,
  ]);

  const totals = summary.success ? summary.data.summary : null;

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="RS Products"
          title="Inventory Alerts"
          description="Watches CRM stock against a threshold you set per variant. Shopify's own quantity is never used for these alerts."
          actions={
            <Button asChild variant="outline">
              <Link href="/rs-products">
                <ArrowLeft className="size-4" />
                Catalogue
              </Link>
            </Button>
          }
        />
      </ContentPageHeader>

      <ContentRegion>
        <ContentScrollArea>
          <div className="flex flex-col gap-6 pb-2">
            {/*
              The dismissible banner. Dismissing it changes nothing about the
              alerts themselves — they remain listed below until stock recovers.
            */}
            {totals && totals.activeAlerts > 0 && (
              <LowStockPopup count={totals.activeAlerts} shortfall={totals.totalShortfall} />
            )}

            {!summary.success ? (
              <ErrorMessage message={summary.message} code={summary.code} />
            ) : (
              <Card className="p-4">
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Active alerts" value={totals?.activeAlerts ?? 0} critical />
                  <Stat label="Monitored variants" value={totals?.monitoredVariants ?? 0} />
                  <Stat label="Units short" value={totals?.totalShortfall ?? 0} />
                  <Stat label="Archived configs" value={totals?.archivedConfigurations ?? 0} />
                </dl>

                {(totals?.negativeStockVariants ?? 0) > 0 && (
                  /*
                    Should be impossible — `crmStockSchema` refuses a negative —
                    so a non-zero count means stock reached the column through a
                    path that bypassed validation. Shown, never clamped.
                  */
                  <p className="mt-3 text-xs font-medium text-critical">
                    {totals?.negativeStockVariants} variant(s) have negative CRM stock — please
                    report this.
                  </p>
                )}
              </Card>
            )}

            {/* Monitored variants, searchable by title or SKU. */}
            <Card className="p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Monitored variants</h2>
                  <p className="mt-1 text-xs text-muted">
                    A variant is low when its CRM stock is at or below its threshold.
                  </p>
                </div>

                <form className="flex items-end gap-2" action="/rs-products/alerts">
                  <Input
                    name="q"
                    defaultValue={q ?? ''}
                    placeholder="Search title or SKU"
                    className="w-56"
                    aria-label="Search monitored variants"
                  />
                  <Button type="submit" variant="outline" size="sm">
                    <Search className="size-4" />
                    Search
                  </Button>
                </form>
              </div>

              <div className="mt-4">
                {!monitored.result.success ? (
                  <ErrorMessage
                    message={monitored.result.message}
                    code={monitored.result.code}
                  />
                ) : (
                  <>
                    <MonitoredTable rows={monitored.result.data.monitored} canEdit={canEdit} />

                    {/* Controls sit below the table rather than inside it: the
                        table stays a Server Component that ships no JS. */}
                    {canEdit && monitored.result.data.monitored.length > 0 && (
                      <ul className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
                        {monitored.result.data.monitored.map((row) => (
                          <li key={row.id} className="flex flex-wrap items-center gap-4">
                            <span className="min-w-[180px] text-xs text-muted">
                              {variantLabel(row)} — {row.productTitle}
                            </span>
                            <MonitorControls row={row} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </Card>

            {/* Add a variant to monitor. EDIT only. */}
            {canEdit && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold text-ink">Add a variant</h2>
                <p className="mt-1 text-xs text-muted">
                  Search the catalogue, then set a threshold. A variant already below it alerts
                  straight away.
                </p>

                <form className="mt-3 flex items-end gap-2" action="/rs-products/alerts">
                  {/* Preserves the monitored-list search while adding. */}
                  {q && <input type="hidden" name="q" value={q} />}
                  <Input
                    name="add"
                    defaultValue={addQuery ?? ''}
                    placeholder="Search title or SKU to monitor"
                    className="w-72"
                    aria-label="Search variants to monitor"
                  />
                  <Button type="submit" variant="outline" size="sm">
                    <Search className="size-4" />
                    Find
                  </Button>
                </form>

                {candidates && !candidates.result.success && (
                  <div className="mt-3">
                    <ErrorMessage
                      message={candidates.result.message}
                      code={candidates.result.code}
                    />
                  </div>
                )}

                {candidates?.result.success && (
                  <ul className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
                    {candidates.result.data.candidates.length === 0 ? (
                      <li className="text-sm text-muted">
                        No variants match that search.
                      </li>
                    ) : (
                      candidates.result.data.candidates.map((c) => (
                        <li key={c.variantId} className="flex flex-wrap items-center gap-4">
                          <span className="min-w-[220px] text-xs text-ink-2">
                            {variantLabel(c)} — {c.productTitle}
                          </span>
                          <span className="text-xs text-muted">
                            CRM stock {c.crmStockQty.toLocaleString('en-IN')}
                          </span>
                          {c.isMonitored ? (
                            <span className="text-xs text-muted">Already monitored</span>
                          ) : (
                            <AddMonitorForm candidate={c} />
                          )}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </Card>
            )}

            {/* Resolved history. Survives variant deletion via its snapshots. */}
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-ink">Resolved alerts</h2>
              <p className="mt-1 text-xs text-muted">
                Kept after the fact, and after a variant is removed from Shopify — each row
                records the stock and threshold as they were.
              </p>
              <div className="mt-4">
                {!history.result.success ? (
                  <ErrorMessage message={history.result.message} code={history.result.code} />
                ) : (
                  <AlertHistoryTable rows={history.result.data.alerts} />
                )}
              </div>
            </Card>
          </div>
        </ContentScrollArea>
      </ContentRegion>
    </ContentPage>
  );
}

function Stat({
  label,
  value,
  critical = false,
}: {
  label: string;
  value: number;
  critical?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd
        className={
          critical && value > 0
            ? 'mt-1 font-mono text-2xl font-medium tabular-nums text-critical'
            : 'mt-1 font-mono text-2xl font-medium tabular-nums text-ink'
        }
      >
        {value.toLocaleString('en-IN')}
      </dd>
    </div>
  );
}
