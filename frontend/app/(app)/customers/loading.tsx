import { Card } from '@/components/ui/card';

/**
 * The directory's loading state.
 *
 * A skeleton rather than a spinner: the shape of what is coming is already
 * known, so reserving it stops the page jumping when the rows arrive. Next.js
 * renders this automatically while the server component awaits its data.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="h-8 w-56 animate-pulse rounded bg-surface-2" />

      <Card className="p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
              <div className="h-7 w-16 animate-pulse rounded bg-surface-2" />
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <div className="h-9 w-72 animate-pulse rounded bg-surface-2" />
      </Card>

      <Card className="p-4">
        <div className="flex flex-col gap-3">
          {/* Eight rows: enough to fill the fold without pretending to know
              how many customers will come back. */}
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-surface-2" />
          ))}
        </div>
      </Card>
    </div>
  );
}
