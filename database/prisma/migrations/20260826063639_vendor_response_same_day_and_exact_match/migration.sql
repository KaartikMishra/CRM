-- AlterEnum
ALTER TYPE "ProductMatchType" ADD VALUE 'EXACT_PRODUCT';

-- AlterTable
ALTER TABLE "VendorResponse" ADD COLUMN     "sameDay" BOOLEAN;
