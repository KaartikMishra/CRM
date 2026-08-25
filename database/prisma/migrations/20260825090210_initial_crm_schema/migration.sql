-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "AppModule" AS ENUM ('PRODUCT_ENQUIRY', 'SALES', 'PROCUREMENT', 'PACKING_DISPATCH', 'CUSTOMER_BILLING', 'VENDOR_INVOICE', 'POST_SALES');

-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('VIEW', 'CREATE', 'EDIT', 'DELETE', 'ASSIGN');

-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('RETAIL', 'BULK', 'WEDDING_GIFTING', 'CORPORATE_GIFTING');

-- CreateEnum
CREATE TYPE "EnquirySource" AS ENUM ('WHATSAPP', 'EMAIL', 'CALL', 'WEBSITE', 'INDIAMART', 'OTHERS');

-- CreateEnum
CREATE TYPE "EnquiryStatus" AS ENUM ('OPEN', 'PARTIAL_CLOSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EnquiryEfficiency" AS ENUM ('ON_TIME', 'DELAYED');

-- CreateEnum
CREATE TYPE "EnquiryProductStatus" AS ENUM ('PENDING', 'RESPONDED', 'NO_VENDOR');

-- CreateEnum
CREATE TYPE "WeightUnit" AS ENUM ('G', 'KG', 'LB');

-- CreateEnum
CREATE TYPE "DimensionUnit" AS ENUM ('MM', 'CM', 'IN', 'FT');

-- CreateEnum
CREATE TYPE "ProductMatchType" AS ENUM ('SIMILAR_PRODUCT');

-- CreateEnum
CREATE TYPE "EnquiryEventType" AS ENUM ('CREATED', 'ASSIGNED', 'REASSIGNED', 'PRODUCT_ADDED', 'PRODUCT_UPDATED', 'PRODUCT_REMOVED', 'VENDOR_RESPONSE_ADDED', 'VENDOR_RESPONSE_UPDATED', 'DEADLINE_BREACHED', 'DELAY_REASON_SUBMITTED', 'PARTIAL_SUBMITTED', 'FULL_SUBMITTED', 'CLOSED', 'REOPENED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserModulePermission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "module" "AppModule" NOT NULL,
    "action" "PermissionAction" NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "UserModulePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "city" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "secureUrl" TEXT NOT NULL,
    "format" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEnquiry" (
    "id" TEXT NOT NULL,
    "enquiryNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "source" "EnquirySource" NOT NULL,
    "sourceDetail" TEXT,
    "status" "EnquiryStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "slaMinutes" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "slaDeadlineAt" TIMESTAMP(3) NOT NULL,
    "firstSubmitAt" TIMESTAMP(3),
    "responseSeconds" INTEGER,
    "efficiency" "EnquiryEfficiency",
    "partialSubmittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductEnquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnquiryProduct" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "imageId" TEXT,
    "quantity" INTEGER NOT NULL,
    "weightValue" DECIMAL(10,3),
    "weightUnit" "WeightUnit",
    "weightInGrams" DECIMAL(12,3),
    "lengthValue" DECIMAL(10,2),
    "widthValue" DECIMAL(10,2),
    "heightValue" DECIMAL(10,2),
    "dimensionUnit" "DimensionUnit",
    "lengthMm" DECIMAL(12,2),
    "widthMm" DECIMAL(12,2),
    "heightMm" DECIMAL(12,2),
    "similarOptionNeeded" BOOLEAN NOT NULL DEFAULT false,
    "status" "EnquiryProductStatus" NOT NULL DEFAULT 'PENDING',
    "noVendorReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnquiryProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorResponse" (
    "id" TEXT NOT NULL,
    "enquiryProductId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "imageId" TEXT,
    "matchType" "ProductMatchType" NOT NULL,
    "ratePerUnit" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "deliveryWithinDays" INTEGER NOT NULL,
    "deliveryNote" TEXT,
    "weightValue" DECIMAL(10,3),
    "weightUnit" "WeightUnit",
    "weightInGrams" DECIMAL(12,3),
    "lengthValue" DECIMAL(10,2),
    "widthValue" DECIMAL(10,2),
    "heightValue" DECIMAL(10,2),
    "dimensionUnit" "DimensionUnit",
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnquiryEvent" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "type" "EnquiryEventType" NOT NULL,
    "actorId" TEXT,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnquiryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelayRecord" (
    "id" TEXT NOT NULL,
    "enquiryId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "minutesLate" INTEGER NOT NULL,
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DelayRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnquiryCounter" (
    "period" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EnquiryCounter_pkey" PRIMARY KEY ("period")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UserModulePermission_userId_module_action_key" ON "UserModulePermission"("userId", "module", "action");

-- CreateIndex
CREATE INDEX "Customer_name_idx" ON "Customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE INDEX "Vendor_isActive_name_idx" ON "Vendor"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_publicId_key" ON "MediaAsset"("publicId");

-- CreateIndex
CREATE INDEX "MediaAsset_uploadedById_createdAt_idx" ON "MediaAsset"("uploadedById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEnquiry_enquiryNo_key" ON "ProductEnquiry"("enquiryNo");

-- CreateIndex
CREATE INDEX "ProductEnquiry_status_slaDeadlineAt_idx" ON "ProductEnquiry"("status", "slaDeadlineAt");

-- CreateIndex
CREATE INDEX "ProductEnquiry_assignedToId_status_idx" ON "ProductEnquiry"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "ProductEnquiry_customerId_idx" ON "ProductEnquiry"("customerId");

-- CreateIndex
CREATE INDEX "ProductEnquiry_createdAt_idx" ON "ProductEnquiry"("createdAt");

-- CreateIndex
CREATE INDEX "ProductEnquiry_efficiency_createdAt_idx" ON "ProductEnquiry"("efficiency", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEnquiry_firstSubmitAt_idx" ON "ProductEnquiry"("firstSubmitAt");

-- CreateIndex
CREATE INDEX "EnquiryProduct_enquiryId_status_idx" ON "EnquiryProduct"("enquiryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EnquiryProduct_enquiryId_lineNo_key" ON "EnquiryProduct"("enquiryId", "lineNo");

-- CreateIndex
CREATE INDEX "VendorResponse_enquiryProductId_idx" ON "VendorResponse"("enquiryProductId");

-- CreateIndex
CREATE INDEX "VendorResponse_vendorId_createdAt_idx" ON "VendorResponse"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "EnquiryEvent_enquiryId_occurredAt_idx" ON "EnquiryEvent"("enquiryId", "occurredAt");

-- CreateIndex
CREATE INDEX "EnquiryEvent_type_occurredAt_idx" ON "EnquiryEvent"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "DelayRecord_enquiryId_submittedAt_idx" ON "DelayRecord"("enquiryId", "submittedAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserModulePermission" ADD CONSTRAINT "UserModulePermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEnquiry" ADD CONSTRAINT "ProductEnquiry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEnquiry" ADD CONSTRAINT "ProductEnquiry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEnquiry" ADD CONSTRAINT "ProductEnquiry_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEnquiry" ADD CONSTRAINT "ProductEnquiry_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnquiryProduct" ADD CONSTRAINT "EnquiryProduct_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "ProductEnquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnquiryProduct" ADD CONSTRAINT "EnquiryProduct_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorResponse" ADD CONSTRAINT "VendorResponse_enquiryProductId_fkey" FOREIGN KEY ("enquiryProductId") REFERENCES "EnquiryProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorResponse" ADD CONSTRAINT "VendorResponse_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorResponse" ADD CONSTRAINT "VendorResponse_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorResponse" ADD CONSTRAINT "VendorResponse_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnquiryEvent" ADD CONSTRAINT "EnquiryEvent_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "ProductEnquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnquiryEvent" ADD CONSTRAINT "EnquiryEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelayRecord" ADD CONSTRAINT "DelayRecord_enquiryId_fkey" FOREIGN KEY ("enquiryId") REFERENCES "ProductEnquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelayRecord" ADD CONSTRAINT "DelayRecord_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
