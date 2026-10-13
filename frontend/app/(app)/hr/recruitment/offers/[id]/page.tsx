import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchOffer } from '@/lib/recruitment-api';
import { OfferDetail } from '@/components/hr/offer-panel';

export const metadata: Metadata = { title: 'Offer' };

/**
 * One offer.
 *
 * `annualPackage` arrives as null for anybody without HR_RECRUITMENT:VIEW, and the panel
 * renders a dash — indistinguishable from "no figure recorded", which is the correct
 * outcome for a reader who is not entitled to know which it is.
 */
export default async function OfferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireModule('HR_RECRUITMENT');
  const { id } = await params;

  const canDecide = access.allowed && can(access.user, 'HR_RECRUITMENT', 'APPROVE');

  const result = await fetchOffer(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Recruitment" title="Offer" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/recruitment/offers">Back to offers</Link>
          </Button>
        </div>
      </div>
    );
  }

  const offer = result.data.offer;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`Recruitment · ${offer.code}`}
        title={offer.candidate.displayName}
        description={offer.position}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href={`/hr/recruitment/applications/${offer.applicationId}`}>Application</Link>
          </Button>
        }
      />

      <OfferDetail offer={offer} canDecide={canDecide} />
    </div>
  );
}
