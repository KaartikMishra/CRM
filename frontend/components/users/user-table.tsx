'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { APP_MODULES, APP_MODULE_LABELS, type ManagedUser } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { EditUserDialog } from './edit-user-dialog';
import { setUserActiveAction } from '@/app/(app)/users/actions';

/** "2 modules", or the names when there are few enough to read at a glance. */
function ModuleSummary({ user }: { user: ManagedUser }) {
  if (user.role === 'ADMIN') {
    return <span className="text-sm text-ink-2">All {APP_MODULES.length} modules</span>;
  }

  if (user.modules.length === 0) {
    return <span className="text-sm text-muted">None</span>;
  }

  if (user.modules.length <= 2) {
    return (
      <span className="flex flex-wrap gap-1">
        {user.modules.map((module) => (
          <Badge key={module} variant="outline">
            {APP_MODULE_LABELS[module]}
          </Badge>
        ))}
      </span>
    );
  }

  return (
    <span
      className="text-sm text-ink-2"
      title={user.modules.map((m) => APP_MODULE_LABELS[m]).join(', ')}
    >
      {user.modules.length} modules
    </span>
  );
}

export function UserTable({ users }: { users: ManagedUser[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggleActive(user: ManagedUser): void {
    setPendingId(user.id);
    startTransition(async () => {
      const result = await setUserActiveAction(user.id, !user.isActive);
      setPendingId(null);

      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      toast.success(
        result.data.user.isActive
          ? `${result.data.user.name} can sign in again.`
          : `${result.data.user.name} has been deactivated.`,
      );
      router.refresh();
    });
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>User</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Modules</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell>
                <span className="block font-medium text-ink">{user.name}</span>
                <span className="block text-xs text-muted tabular">{user.employeeId}</span>
              </TableCell>

              <TableCell className="text-ink-2">{user.email}</TableCell>

              <TableCell>
                <Badge variant={user.role === 'ADMIN' ? 'accent' : 'neutral'}>{user.role}</Badge>
              </TableCell>

              <TableCell>
                <ModuleSummary user={user} />
              </TableCell>

              <TableCell>
                <Badge variant={user.isActive ? 'positive' : 'neutral'}>
                  {user.isActive ? 'Active' : 'Inactive'}
                </Badge>
                {user.lastLoginAt && (
                  <span className="mt-1 block text-[11px] text-muted">
                    Last in {formatDateTime(user.lastLoginAt)}
                  </span>
                )}
              </TableCell>

              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleActive(user)}
                    disabled={pendingId === user.id}
                  >
                    {pendingId === user.id && <Loader2 className="size-3.5 animate-spin" />}
                    {user.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(user)}>
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <EditUserDialog user={editing} onClose={() => setEditing(null)} />
    </>
  );
}
