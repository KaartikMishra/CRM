-- Notifications: one row per thing somebody should know about.
--
-- Additive throughout. No existing table, column, constraint or row is
-- touched; the only reference outward is a foreign key to "User", so a
-- deleted user's notices go with them and nothing else notices.
--
-- The row is the record. The WebSocket that carries it is only delivery, so a
-- notice raised while its recipient was offline is still here when they
-- return — which is why it is written inside the business transaction and
-- sent only after that transaction commits.

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ENQUIRY_ASSIGNED', 'SALES_ORDER_CREATED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- One notice per (person, kind, subject). A retried request therefore cannot
-- raise the same notice twice; the service reads the resulting unique
-- violation as success rather than as an error.
CREATE UNIQUE INDEX "Notification_recipientId_type_entityId_key"
    ON "Notification"("recipientId", "type", "entityId");

-- The bell's own query: this person's undismissed notices, newest first.
CREATE INDEX "Notification_recipientId_dismissedAt_createdAt_idx"
    ON "Notification"("recipientId", "dismissedAt", "createdAt");

-- Retention sweeps by age across every recipient, so it needs its own index
-- rather than scanning the per-recipient one above.
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- A notice belongs to exactly one person and cannot outlive them.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
