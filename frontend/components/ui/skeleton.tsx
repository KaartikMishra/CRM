import { cn } from '@/lib/utils';

/** Sized to the content it replaces, so nothing shifts when data arrives. */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-sm bg-surface-3', className)} {...props} />;
}
