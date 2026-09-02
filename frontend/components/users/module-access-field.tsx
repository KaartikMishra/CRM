'use client';

import { APP_MODULES, APP_MODULE_LABELS, type AppModule } from '@rs/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * The module checkboxes — §3 and §5.
 *
 * Zero through seven are all valid, so there is deliberately no "at least one"
 * rule: an account with no modules is a real thing an administrator may want,
 * and the seven boxes are simply independent.
 */
export function ModuleAccessField({
  selected,
  onChange,
  disabled = false,
  idPrefix,
}: {
  selected: AppModule[];
  onChange: (modules: AppModule[]) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const chosen = new Set(selected);

  function toggle(module: AppModule, checked: boolean): void {
    const next = new Set(chosen);
    if (checked) next.add(module);
    else next.delete(module);
    onChange(APP_MODULES.filter((m) => next.has(m)));
  }

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Module access
      </legend>

      <div className="mt-2.5 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
        {APP_MODULES.map((module) => {
          const id = `${idPrefix}-${module}`;
          const active = chosen.has(module);

          return (
            <div
              key={module}
              className={cn(
                'flex items-center gap-2.5 bg-surface px-3 py-2.5 transition-colors',
                active && 'bg-brass-soft',
                disabled && 'opacity-60',
              )}
            >
              <Checkbox
                id={id}
                checked={active}
                onCheckedChange={(value) => toggle(module, value === true)}
              />
              <Label
                htmlFor={id}
                className={cn(
                  'cursor-pointer text-sm font-normal',
                  active ? 'text-ink' : 'text-ink-2',
                )}
              >
                {APP_MODULE_LABELS[module]}
              </Label>
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-muted">
        {selected.length === 0
          ? 'No modules — this person can sign in but will see only the dashboard.'
          : `${selected.length} of ${APP_MODULES.length} modules selected.`}
      </p>
    </fieldset>
  );
}
