-- =============================================================================
--  Three NotificationType values for HR Phase 1.
--
--  Enum members only. No table is created, altered or dropped; no row is
--  inserted, updated or deleted.
--
--  SEPARATE FROM THE TABLES on purpose, following the precedent set by
--  20260930090000_lead_deal_module_permission and
--  20261006091000_post_sales_notification_types: Postgres will not let a value
--  added by ALTER TYPE be used in the same transaction that added it, and the
--  service writes notifications of these types. Two migrations is what makes
--  both safe to run in one deploy.
--
--  `IF NOT EXISTS` on every statement, so re-running this is a no-op.
--
--  WHY ONLY THREE
--
--  Each of these tells somebody something they must act on or could not otherwise
--  know: a manager gains a report, a person's CRM account is tied to their HR
--  record, or somebody's employment status moved. Creating an employee raises
--  nothing by itself — the HR team already knows, having just done it. A notice
--  nobody needs is how a notification bell stops being read, and this CRM already
--  carries ~35,590 SALES_ORDER_CREATED rows as a standing reminder of that.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE.
-- =============================================================================

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_EMPLOYEE_ASSIGNED_TO_MANAGER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_EMPLOYEE_ACCOUNT_LINKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_EMPLOYEE_STATUS_CHANGED';
