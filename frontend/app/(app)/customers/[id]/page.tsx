import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
  ContentScrollArea,
} from '@/components/common/content-page';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import {
  EnquiriesSection,
  LeadsSection,
  OrdersSection,
  OverviewSection,
  TimelineSection,
} from '@/components/customers/customer-profile-sections';
import {
  fetchCustomerEnquiries,
  fetchCustomerLeads,
  fetchCustomerOrders,
  fetchCustomerProfile,
  fetchCustomerTimeline,
} from '@/lib/customer-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Customer' };

const TABS = ['overview', 'enquiries', 'leads', 'orders', 'timeline'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  enquiries: 'Enquiries',
  leads: 'Leads',
  orders: 'Sales Orders',
  timeline: 'Timeline',
};

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

/**
 * One customer's profile.
 *
 * Gated on RS_PRODUCTS' sibling module CUSTOMERS, VIEW to read. The API
 * enforces the same on its own authority; this only decides what is worth
 * rendering — the sidebar hiding a link has never been what keeps anyone out.
 *
 * ### Only the open tab is fetched
 *
 * Five requests would load four lists nobody is looking at. The profile header
 * is always fetched because it carries the aggregates the page is about; the
 * tab's own list is fetched beside it. A tab is a URL parameter rather than
 * client state, so a tab is shareable and the tables stay Server Components
 * that ship no JavaScript.
 */
export default async function CustomerProfilePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const access = await requireModule('CUSTOMERS');
  if (!access.allowed) return <NoModuleAccess module="CUSTOMERS" />;
  if (!can(access.user, 'CUSTOMERS', 'VIEW')) return <NoModuleAccess module="CUSTOMERS" />;

  const { id } = await params;
  const query = await searchParams;
  const raw = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'overview';

  const [profile, enquiries, leads, orders, timeline] = await Promise.all([
    fetchCustomerProfile(id),
    tab === 'enquiries' ? fetchCustomerEnquiries(id) : null,
    tab === 'leads' ? fetchCustomerLeads(id) : null,
    tab === 'orders' ? fetchCustomerOrders(id) : null,
    tab === 'timeline' ? fetchCustomerTimeline(id) : null,
  ]);

  /*
    A failed profile fetch is rendered as the error it is, with the request id,
    rather than as an empty customer. The backend returns CUSTOMER_NOT_FOUND
    with a 404 for an id that does not exist, and that message is the honest
    thing to show.
  */
  if (!profile.success) {
    return (
      <ContentPage>
        <ContentPageHeader>
          <PageHeader
            eyebrow="All Customers"
            title="Customer"
            actions={
              <Button asChild variant="outline">
                <Link href="/customers">
                  <ArrowLeft className="size-4" />
                  Directory
                </Link>
              </Button>
            }
          />
        </ContentPageHeader>
        <ContentRegion>
          <ContentScrollArea>
            <ErrorMessage message={profile.message} code={profile.code} />
          </ContentScrollArea>
        </ContentRegion>
      </ContentPage>
    );
  }

  const customer = profile.data.customer;

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="All Customers"
          title={customer.name}
          description={
            customer.companyName
              ? `${customer.companyName} · ${customer.type}`
              : String(customer.type)
          }
          actions={
            <Button asChild variant="outline">
              <Link href="/customers">
                <ArrowLeft className="size-4" />
                Directory
              </Link>
            </Button>
          }
        />
      </ContentPageHeader>

      <ContentRegion>
        <ContentScrollArea>
          <div className="flex flex-col gap-6 pb-2">
            {/* Links rather than buttons: a tab is a URL, so it is shareable. */}
            <nav
              aria-label="Customer sections"
              className="flex flex-wrap gap-1 border-b border-line"
            >
              {TABS.map((name) => (
                <Link
                  key={name}
                  href={`/customers/${id}?tab=${name}`}
                  aria-current={tab === name ? 'page' : undefined}
                  className={
                    tab === name
                      ? 'border-b-2 border-accent px-3 py-2 text-sm font-medium text-ink'
                      : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink'
                  }
                >
                  {TAB_LABELS[name]}
                </Link>
              ))}
            </nav>

            {tab === 'overview' && <OverviewSection customer={customer} />}

            {tab === 'enquiries' && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold text-ink">Product enquiries</h2>
                <div className="mt-3">
                  {enquiries === null ? null : !enquiries.success ? (
                    <ErrorMessage message={enquiries.message} code={enquiries.code} />
                  ) : (
                    <EnquiriesSection rows={enquiries.data.enquiries} />
                  )}
                </div>
              </Card>
            )}

            {tab === 'leads' && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold text-ink">Leads &amp; deals</h2>
                <p className="mt-1 text-xs text-muted">
                  A lead counts as converted when it is linked to a sales order that was not
                  cancelled. WON is a separate judgement and is shown as its own column.
                </p>
                <div className="mt-3">
                  {leads === null ? null : !leads.success ? (
                    <ErrorMessage message={leads.message} code={leads.code} />
                  ) : (
                    <LeadsSection rows={leads.data.leads} />
                  )}
                </div>
              </Card>
            )}

            {tab === 'orders' && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold text-ink">Sales orders</h2>
                <p className="mt-1 text-xs text-muted">
                  Values come from the Sales module&apos;s own calculation, so they match each
                  order&apos;s own page. Cancelled orders are worth nothing and say so.
                </p>
                <div className="mt-3">
                  {orders === null ? null : !orders.success ? (
                    <ErrorMessage message={orders.message} code={orders.code} />
                  ) : (
                    <OrdersSection rows={orders.data.orders} />
                  )}
                </div>
              </Card>
            )}

            {tab === 'timeline' && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold text-ink">Activity</h2>
                <p className="mt-1 text-xs text-muted">
                  Enquiries, leads, follow-ups, orders, payments, refunds and post-sales cases,
                  newest first.
                </p>
                <div className="mt-3">
                  {timeline === null ? null : !timeline.success ? (
                    <ErrorMessage message={timeline.message} code={timeline.code} />
                  ) : (
                    <TimelineSection
                      entries={timeline.data.timeline}
                      /*
                        `truncated` rides in meta. Typed loosely here because
                        ApiResult exposes meta as an open record; an absent value
                        means nothing was capped.
                      */
                      truncated={
                        (timeline.meta?.truncated as string[] | undefined) ?? []
                      }
                    />
                  )}
                </div>
              </Card>
            )}
          </div>
        </ContentScrollArea>
      </ContentRegion>
    </ContentPage>
  );
}
