import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-medium tracking-wide whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-line-2 bg-surface-2 text-ink-2',
        accent: 'border-brass-line bg-brass-soft text-accent',
        positive: 'border-positive/30 bg-positive-soft text-positive',
        warning: 'border-warning/30 bg-warning-soft text-warning',
        critical: 'border-critical/30 bg-critical-soft text-critical',
        outline: 'border-line text-muted',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export type BadgeProps = React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
