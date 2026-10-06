import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Sized to the real lead detail, so nothing jumps when the data lands. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-64" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
      </div>

      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </Card>

      {/* Complete the Ideal */}
      <Card className="flex flex-col gap-4 p-4">
        <Skeleton className="h-5 w-48" />
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-line-2 p-3">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-14 w-full" />
          </div>
        ))}
      </Card>
    </div>
  );
}
