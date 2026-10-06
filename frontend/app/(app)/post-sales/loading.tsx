import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Sized to the eight overview tiles, so nothing jumps when the counts land. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="flex flex-col gap-2 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-12" />
          </Card>
        ))}
      </div>
    </div>
  );
}
