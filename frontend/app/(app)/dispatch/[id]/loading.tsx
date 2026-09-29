import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Sized to the real order detail so nothing jumps when the data lands (§38). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>

      {/* Customer and order summary, two columns on desktop. */}
      <Card className="p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-52" />
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-20" />
          </div>
        </div>
      </Card>

      {/* The line table. */}
      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <Skeleton className="h-4 w-full max-w-2xl" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-line px-4 py-4 last:border-0"
          >
            <Skeleton className="h-4 w-6 shrink-0" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ml-auto h-4 w-40" />
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </Card>

      {/* Partial-dispatch and shipment panels. */}
      <Card className="p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-2 h-4 w-72" />
      </Card>
      <Card className="p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-4 w-64" />
      </Card>
    </div>
  );
}
