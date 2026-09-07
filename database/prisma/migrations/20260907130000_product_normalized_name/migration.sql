-- Product.normalizedName: one catalogue entry per logical product.
--
-- `name` is unique on the raw string, which only ever caught byte-identical
-- spellings: "Kansa Dinner Set" and "kansa dinner set" were free to become two
-- products with two separate InventoryItem rows. This column folds case and
-- removes every space, and its unique index is what actually enforces the rule
-- — in the database, so two concurrent inserts cannot both win.
--
-- Written by hand rather than generated. Prisma's own output for a required
-- column is a single `ADD COLUMN ... NOT NULL`, which fails outright against
-- the 16 rows already present. The steps below add it nullable, fill it,
-- assert the result, and only then tighten the constraint.
--
-- Additive throughout: no product is renamed, merged, deactivated or deleted,
-- and nothing outside this table is touched.

-- 1. Nullable first, so existing rows survive the DDL.
ALTER TABLE "Product" ADD COLUMN "normalizedName" TEXT;

-- 2. Backfill. Mirrors normalizeProductName() in @rs/shared exactly:
--    btrim → lower → remove all whitespace.
UPDATE "Product"
SET "normalizedName" = regexp_replace(lower(btrim("name")), '\s+', '', 'g');

-- 3. Refuse to continue if the fold collapsed two products into one key.
--    A collision here means a real product-identity decision that a person has
--    to make; resolving it automatically would silently pool two products'
--    stock. The audit before this migration found none, and this is the guard
--    that keeps that true at apply time on any database.
DO $$
DECLARE collisions INT;
BEGIN
  SELECT count(*) INTO collisions FROM (
    SELECT "normalizedName" FROM "Product"
    GROUP BY "normalizedName" HAVING count(*) > 1
  ) dupes;

  IF collisions > 0 THEN
    RAISE EXCEPTION
      'Product.normalizedName has % colliding group(s). Resolve them by hand before applying this migration.',
      collisions;
  END IF;
END $$;

-- 4. Every row now has a value, so the column can be required.
ALTER TABLE "Product" ALTER COLUMN "normalizedName" SET NOT NULL;

-- 5. The constraint the application relies on as its final authority.
CREATE UNIQUE INDEX "Product_normalizedName_key" ON "Product"("normalizedName");
