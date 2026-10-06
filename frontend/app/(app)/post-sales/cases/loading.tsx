import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Sized to the real case board, so nothing jumps when the rows land. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Skeleton className="h-9 w-64" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-32" />
        ))}
        <Skeleton className="h-9 w-20" />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <Skeleton className="h-4 w-full max-w-3xl" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-line px-4 py-4 last:border-0"
          >
            <Skeleton className="h-4 w-28 shrink-0" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="ml-auto h-4 w-24" />
          </div>
        ))}
      </Card>
    </div>
  );
}
