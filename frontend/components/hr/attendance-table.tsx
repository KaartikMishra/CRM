import { CalendarCheck } from 'lucide-react';
import { formatMinutes, type AttendanceRow } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/common/empty-state';
import {
  ATTENDANCE_SOURCE_LABELS,
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUS_TONES,
  ATTENDANCE_WORK_MODE_LABELS,
  formatClockTime,
  formatHrDay,
} from './attendance-labels';

/**
 * The attendance board.
 *
 * Eleven columns, wider than a laptop viewport — wrapped in an `overflow-x-auto`
 * container so they scroll sideways, exactly as the Sales, Lead and Post Sales
 * boards do.
 *
 * Every figure arrives computed from the service. Nothing here sums, averages or
 * recalculates: `workedMinutes` and the rest were frozen at clock-out against the
 * policy in force then, and recomputing them in the browser against today's
 * policy would quietly restate history.
 *
 * The rows a viewer sees are decided server-side by the scope rules — an employee
 * gets their own, a manager their team's, HR everybody's. This component renders
 * whatever it is given and makes no access decision of its own.
 */
export function AttendanceTable({
  rows,
  filtered,
  showEmployee,
}: {
  rows: AttendanceRow[];
  /** Whether any filter is active, so "nothing here" can say which kind. */
  filtered: boolean;
  /** Hidden on the self-service view, where every row is the same person. */
  showEmployee: boolean;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title="No attendance to show"
        description={
          filtered
            ? 'No day matches these filters. Try widening the date range.'
            : 'Nothing has been recorded yet.'
        }
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {showEmployee && <TableHead>Employee</TableHead>}
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>In</TableHead>
              <TableHead>Out</TableHead>
              <TableHead>Worked</TableHead>
              <TableHead>Break</TableHead>
              <TableHead>Late</TableHead>
              <TableHead>Early</TableHead>
              <TableHead>Overtime</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {showEmployee && (
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-ink">{row.employee.displayName}</span>
                      <span className="text-xs text-muted">
                        {row.employee.employeeId}
                        {row.department ? ` · ${row.department.name}` : ''}
                      </span>
                    </div>
                  </TableCell>
                )}
                <TableCell className="whitespace-nowrap text-ink-2">
                  {formatHrDay(row.attendanceDate)}
                </TableCell>
                <TableCell>
                  <Badge variant={ATTENDANCE_STATUS_TONES[row.status]}>
                    {ATTENDANCE_STATUS_LABELS[row.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-ink-2">
                  {row.workMode ? ATTENDANCE_WORK_MODE_LABELS[row.workMode] : '—'}
                </TableCell>
                <TableCell className="text-ink-2">{formatClockTime(row.clockInAt)}</TableCell>
                <TableCell className="text-ink-2">{formatClockTime(row.clockOutAt)}</TableCell>
                <TableCell className="text-ink-2">{formatMinutes(row.workedMinutes)}</TableCell>
                <TableCell className="text-ink-2">
                  {row.breakMinutes > 0 ? formatMinutes(row.breakMinutes) : '—'}
                </TableCell>
                <TableCell className={row.lateMinutes > 0 ? 'text-warning' : 'text-ink-2'}>
                  {row.lateMinutes > 0 ? formatMinutes(row.lateMinutes) : '—'}
                </TableCell>
                <TableCell className={row.earlyExitMinutes > 0 ? 'text-warning' : 'text-ink-2'}>
                  {row.earlyExitMinutes > 0 ? formatMinutes(row.earlyExitMinutes) : '—'}
                </TableCell>
                <TableCell className="text-ink-2">
                  {row.overtimeMinutes > 0 ? formatMinutes(row.overtimeMinutes) : '—'}
                </TableCell>
                <TableCell className="text-xs text-muted">
                  {ATTENDANCE_SOURCE_LABELS[row.source]}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
