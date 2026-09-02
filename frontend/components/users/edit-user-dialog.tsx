'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { updateUserSchema, type AppModule, type ManagedUser } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { ErrorMessage } from '@/components/common/error-message';
import { ModuleAccessField } from './module-access-field';
import { updateUserAction } from '@/app/(app)/users/actions';

/**
 * §12 — edit name, password, active state and module access.
 *
 * Only what actually changed is sent. That is what makes "leave the password
 * blank to keep it" work, and it is also why an untouched module grid sends no
 * `modules` key at all: an empty array means "revoke everything", so the two
 * must stay distinguishable.
 *
 * Administrators are shown read-only. Their access is all seven modules by role
 * and cannot be edited (§13), and the role itself is not editable anywhere in
 * the product.
 */
export function EditUserDialog({
  user,
  onClose,
}: {
  user: ManagedUser | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const formId = useId();

  const [name, setName] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [modules, setModules] = useState<AppModule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isAdmin = user?.role === 'ADMIN';

  // Reload the form whenever a different person is opened.
  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setIsActive(user.isActive);
    setModules(user.modules);
    setPassword('');
    setConfirmPassword('');
    setError(null);
    setFieldErrors({});
  }, [user]);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (!user) return;
    setError(null);
    setFieldErrors({});

    const sameModules =
      modules.length === user.modules.length &&
      modules.every((m) => user.modules.includes(m));

    const payload: Record<string, unknown> = {};
    if (name !== user.name) payload.name = name;
    if (isActive !== user.isActive) payload.isActive = isActive;
    if (password) {
      payload.password = password;
      payload.confirmPassword = confirmPassword;
    }
    // Never send module edits for an administrator — the API refuses them, and
    // the grid is read-only above.
    if (!isAdmin && !sameModules) payload.modules = modules;

    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    const parsed = updateUserSchema.safeParse(payload);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errors[issue.path.join('.')] ??= issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    startTransition(async () => {
      const result = await updateUserAction(user.id, parsed.data);

      if (!result.ok) {
        if (result.details?.length) {
          const errors: Record<string, string> = {};
          for (const detail of result.details) errors[detail.path] ??= detail.message;
          setFieldErrors(errors);
        }
        setError(result.message);
        return;
      }

      toast.success(`${result.data.user.name} updated.`);
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open={user !== null} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>
            {user ? `${user.employeeId} · ${user.email}` : ''}
          </DialogDescription>
        </DialogHeader>

        {user && (
          <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {fieldErrors.name && <p className="text-xs text-critical">{fieldErrors.name}</p>}
            </div>

            <div className="flex items-center gap-2.5 rounded-md border border-line bg-surface-2 px-3 py-2.5">
              <Checkbox
                id={`${formId}-active`}
                checked={isActive}
                onCheckedChange={(value) => setIsActive(value === true)}
              />
              <Label htmlFor={`${formId}-active`} className="cursor-pointer font-normal">
                Active — can sign in
              </Label>
            </div>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-password`}>New password</Label>
                <Input
                  id={`${formId}-password`}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="Leave blank to keep"
                />
                {fieldErrors.password && (
                  <p className="text-xs text-critical">{fieldErrors.password}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-confirm`}>Confirm new password</Label>
                <Input
                  id={`${formId}-confirm`}
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={!password}
                />
                {fieldErrors.confirmPassword && (
                  <p className="text-xs text-critical">{fieldErrors.confirmPassword}</p>
                )}
              </div>
            </div>

            <Separator />

            {isAdmin ? (
              <p className="rounded-md border border-brass-line bg-brass-soft px-3 py-2.5 text-sm text-ink-2">
                Administrators always have every module. Their access is set by their role
                and cannot be edited here.
              </p>
            ) : (
              <ModuleAccessField
                selected={modules}
                onChange={setModules}
                disabled={pending}
                idPrefix={`${formId}-module`}
              />
            )}

            {error && <ErrorMessage message={error} />}
          </form>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
