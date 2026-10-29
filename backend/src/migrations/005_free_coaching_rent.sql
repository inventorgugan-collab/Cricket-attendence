-- Players the academy coaches for free (scholarships, family, trials). Their
-- sessions are still counted, but no money is expected for them.
ALTER TABLE players ADD COLUMN free_coaching boolean NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN free_reason text;

-- Rent is the biggest regular cost, so it gets its own line in the month report.
ALTER TABLE expenses DROP CONSTRAINT expenses_category_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_category_check
  CHECK (category IN ('rent', 'ground', 'equipment', 'travel', 'staff', 'utilities', 'other'));
