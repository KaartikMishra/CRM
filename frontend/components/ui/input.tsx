import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        // The value the person typed stays `text-ink` — full contrast, the
        // darkest text on the page. Only the placeholder is lightened.
        'flex h-10 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink',
        // `faint` (#9a9890), not `muted` (#6b6a64): muted is body-copy weight
        // and made hints read as values somebody had already filled in. This
        // matches Textarea and the command palette, which were already on faint
        // — the input was the one control out of step with them.
        'placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
