import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchOffers } from '@/lib/recruitment-api';
import { OfferList } from '@/components/hr/offer-panel';

export const metadata: Metadata = { title: 'Offers' };

/**
 * The offers board.
 *
 * Gated on the module, unlike the roles and applications boards. An offer is what the
 * business committed to pay somebody, and an interviewer or hiring manager working on the
 * hire is not automatically entitled to read it — the API refuses them too, so showing an
 * empty list would be misleading where the access panel is honest.
 */
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_RECRUITMENT');

  if (!access.allowed || !can(access.user, 'HR_RECRUITMENT', 'VIEW')) {
    return <NoModuleAccess module="HR_RECRUITMENT" />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const [awaiting, all] = await Promise.all([
    fetchOffers({ status: 'SENT', limit: '50' }),
    fetchOffers({ status: single('status'), limit: '50', cursor: single('cursor') }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title="Offers"
        description="What has been offered, and who has answered."
      />

      {/*
        The outstanding ones first. An offer awaiting a reply has a clock on it — many
        carry an expiry — and burying them in a date-sorted list of everything is how one
        lapses unnoticed.
      */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Awaiting a reply
        </h2>
        {!awaiting.success ? (
          <ErrorMessage message={awaiting.message} />
        ) : (
          <Card className="p-4">
            <OfferList offers={awaiting.data.items} />
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          All offers
        </h2>
        {!all.success ? (
          <ErrorMessage message={all.message} />
        ) : (
          <Card className="p-4">
            <OfferList offers={all.data.items} />
          </Card>
        )}
        {all.success && all.data.nextCursor && (
          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <Link href={`/hr/recruitment/offers?cursor=${all.data.nextCursor}`}>Next page</Link>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
