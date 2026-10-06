import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Sized to the real case detail, so nothing jumps when the data lands. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-7 w-72" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-20" />
        </div>
      </div>

      <Card className="grid gap-5 p-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </Card>

      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <Skeleton className="h-5 w-48" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </Card>
    </div>
  );
}
