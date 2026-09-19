-- =============================================================================
--  Drop the legacy Product master and InventoryItem.
--
--  This is the prepared, audited removal from database/prisma/drop-legacy-product.sql,
--  promoted to a migration unchanged apart from two informational SELECTs whose
--  output `migrate deploy` discards. The rows they would have printed are
--  recorded here instead, so the migration itself is the record:
--
--    Product
--      cmu6ojfp2000al058o0b7ce06  "10 Inch Pure Kansa Dinner Set – 5 Pieces"  isActive=true
--      cmtxc73ap000jyblifyfa9mea  "kansa thali"                              isActive=true
--
--    InventoryItem
--      cmtxc73ap000kybliydzaup1m  productId=cmtxc73ap000jyblifyfa9mea  onHand=0
--      cmu6ojfp2000bl0584l0znxfi  productId=cmu6ojfp2000al058o0b7ce06  onHand=0
--
--  Both onHand values are zero, so no stock figure is lost. Nothing reads either
--  table: the last reference went with the RS Products identity migration, and
--  the purchase and sales lines that once pointed here keep their own
--  productName, which is the wording written on the document.
--
--  NOT TOUCHED by this migration: RsProduct, ShopifyVariant (and therefore
--  crmStockQty), PurchaseBill, PurchaseBillItem, PurchaseAllocation, SalesOrder,
--  SalesOrderItem, Customer, Vendor, and every other table.
-- =============================================================================

DO $$
DECLARE
  refs int;
BEGIN
  SELECT count(*) INTO refs
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND ccu.table_name = 'Product'
    AND tc.table_name <> 'InventoryItem';

  IF refs > 0 THEN
    RAISE EXCEPTION
      'Product is still referenced by % foreign key(s) outside InventoryItem. Re-run the dependency audit before dropping.', refs;
  END IF;
END $$;

-- Child first, so the drop needs no CASCADE and cannot quietly take something
-- unexpected with it.
DROP TABLE "InventoryItem";
DROP TABLE "Product";
