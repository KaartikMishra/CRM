'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { createUserSchema, type AppModule } from '@rs/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ErrorMessage } from '@/components/common/error-message';
import { ModuleAccessField } from './module-access-field';
import { createUserAction } from '@/app/(app)/users/actions';

/**
 * §3 — create a USER.
 *
 * There is no role control, on purpose. This form can only produce a USER, and
 * the API has no role field to send one either, so the absence here matches the
 * contract rather than merely hiding a choice.
 *
 * Validation runs against the same Zod schema the backend uses, so a message
 * shown here is the one the API would have returned — and the API validates
 * again regardless.
 */
export function CreateUserDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const formId = useId();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [modules, setModules] = useState<AppModule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function reset(): void {
    setName('');
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setModules([]);
    setError(null);
    setFieldErrors({});
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const parsed = createUserSchema.safeParse({
      name,
      email,
      password,
      confirmPassword,
      modules,
    });

    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        errors[key] ??= issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    startTransition(async () => {
      const result = await createUserAction(parsed.data);

      if (!result.ok) {
        if (result.details?.length) {
          const errors: Record<string, string> = {};
          for (const detail of result.details) {
            errors[detail.path] ??= detail.message;
          }
          setFieldErrors(errors);
        }
        setError(result.message);
        return;
      }

      toast.success(`${result.data.user.name} can now sign in.`);
      reset();
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
          if (!next) reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Create User
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create User</DialogTitle>
          <DialogDescription>
            A new account with the USER role. Choose which modules they can open.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-name`}>Name</Label>
            <Input
              id={`${formId}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              placeholder="Devansh Sharma"
            />
            {fieldErrors.name && <p className="text-xs text-critical">{fieldErrors.name}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-email`}>Email</Label>
            <Input
              id={`${formId}-email`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              placeholder="name@royalstuffs.com"
            />
            {fieldErrors.email && <p className="text-xs text-critical">{fieldErrors.email}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-password`}>Password</Label>
              <Input
                id={`${formId}-password`}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              {fieldErrors.password && (
                <p className="text-xs text-critical">{fieldErrors.password}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-confirm`}>Confirm Password</Label>
              <Input
                id={`${formId}-confirm`}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
              {fieldErrors.confirmPassword && (
                <p className="text-xs text-critical">{fieldErrors.confirmPassword}</p>
              )}
            </div>
          </div>

          <Separator />

          <ModuleAccessField
            selected={modules}
            onChange={setModules}
            disabled={pending}
            idPrefix={`${formId}-module`}
          />

          {error && <ErrorMessage message={error} />}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Create User
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
