import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * §37 — backend failures shown in the employee's language.
 *
 * The API already returns a human-readable message and a stable code; this
 * renders them without ever exposing a stack trace or a database error.
 */
export function ErrorMessage({
  message,
  code,
  className,
}: {
  message: string;
  code?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-md border border-critical/30 bg-critical-soft px-3 py-2.5 text-sm text-critical',
        className,
      )}
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p>{message}</p>
        {code && <p className="mt-0.5 text-xs opacity-70 tabular">{code}</p>}
      </div>
    </div>
  );
}
