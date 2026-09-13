-- =============================================================================
--  RS Products — the data model.
--
--  Four new tables and two new enums. Nothing existing is altered: Product,
--  InventoryItem, SalesOrderItem, PurchaseBillItem and EnquiryProduct keep
--  every column and constraint they had, and no row is read or written here.
--
--  The one point of contact with the old world is RsProduct.productId, a
--  nullable bridge to the legacy Product Master. It is unused in this phase and
--  exists so the later controlled migration has somewhere to land — a mapping
--  that can be populated and verified before anything depends on it. SET NULL
--  so retiring a legacy product can never cascade into the catalogue.
--
--  Deliberately absent: any change to InventoryItem. Shopify's sellable
--  quantity lives on ShopifyVariant.inventoryQty and is a different number from
--  Procurement's manually maintained onHand, which feeds received − allocated.
--
--  No DROP, TRUNCATE, DELETE, INSERT or UPDATE. Additive only.
-- =============================================================================

-- CreateEnum
CREATE TYPE "ProductSource" AS ENUM ('SHOPIFY', 'MANUAL');

-- CreateEnum
CREATE TYPE "ShopifyProductStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DRAFT');

-- CreateTable
CREATE TABLE "RsProduct" (
    "id" TEXT NOT NULL,
    "source" "ProductSource" NOT NULL DEFAULT 'SHOPIFY',
    "shopifyProductId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ShopifyProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "productType" TEXT,
    "vendor" TEXT,
    "productId" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RsProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyVariant" (
    "id" TEXT NOT NULL,
    "rsProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "shopifyInventoryItemId" TEXT,
    "sku" TEXT,
    "title" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "costPrice" DECIMAL(12,2),
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
    "inventoryQty" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RsProductImage" (
    "id" TEXT NOT NULL,
    "rsProductId" TEXT NOT NULL,
    "shopifyImageId" TEXT,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "position" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RsProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyWebhookEvent" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "ShopifyWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RsProduct_shopifyProductId_key" ON "RsProduct"("shopifyProductId");

-- CreateIndex
CREATE INDEX "RsProduct_source_status_idx" ON "RsProduct"("source", "status");

-- CreateIndex
CREATE INDEX "RsProduct_productId_idx" ON "RsProduct"("productId");

-- CreateIndex
CREATE INDEX "RsProduct_title_idx" ON "RsProduct"("title");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariant_shopifyVariantId_key" ON "ShopifyVariant"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariant_shopifyInventoryItemId_key" ON "ShopifyVariant"("shopifyInventoryItemId");

-- CreateIndex
CREATE INDEX "ShopifyVariant_rsProductId_position_idx" ON "ShopifyVariant"("rsProductId", "position");

-- CreateIndex
CREATE INDEX "ShopifyVariant_sku_idx" ON "ShopifyVariant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "RsProductImage_shopifyImageId_key" ON "RsProductImage"("shopifyImageId");

-- CreateIndex
CREATE INDEX "RsProductImage_rsProductId_position_idx" ON "RsProductImage"("rsProductId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWebhookEvent_webhookId_key" ON "ShopifyWebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "ShopifyWebhookEvent_topic_receivedAt_idx" ON "ShopifyWebhookEvent"("topic", "receivedAt");

-- AddForeignKey
ALTER TABLE "RsProduct" ADD CONSTRAINT "RsProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyVariant" ADD CONSTRAINT "ShopifyVariant_rsProductId_fkey" FOREIGN KEY ("rsProductId") REFERENCES "RsProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsProductImage" ADD CONSTRAINT "RsProductImage_rsProductId_fkey" FOREIGN KEY ("rsProductId") REFERENCES "RsProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

