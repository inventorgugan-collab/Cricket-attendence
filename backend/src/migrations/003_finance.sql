-- Fees, payments, coach pay and expenses. Visible to the academy admin only.
-- Amounts are whole paise (₹1 = 100). Nothing financial is ever deleted:
-- a mistake is voided with a reason, and the void is kept.

ALTER TABLE package_templates ADD COLUMN price_paise bigint CHECK (price_paise >= 0);
ALTER TABLE packages ADD COLUMN price_paise bigint CHECK (price_paise >= 0);

-- What a player (or their family) owes.
CREATE TABLE fees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL REFERENCES players(id),
  package_id    uuid REFERENCES packages(id),
  description   text NOT NULL,
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  due_on        date NOT NULL,
  waived_at     timestamptz,
  waived_by     uuid REFERENCES users(id),
  waive_reason  text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fees_player ON fees(player_id);

CREATE TYPE payment_method AS ENUM ('cash', 'upi', 'bank', 'card', 'cheque', 'other');

-- Money received.
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL REFERENCES players(id),
  fee_id        uuid REFERENCES fees(id),
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  paid_on       date NOT NULL,
  method        payment_method NOT NULL,
  reference     text,
  note          text,
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  voided_by     uuid REFERENCES users(id),
  void_reason   text
);
CREATE INDEX payments_paid_on ON payments(paid_on);
CREATE INDEX payments_fee ON payments(fee_id);

-- What a coach is paid per session: a default, and optionally a different
-- rate for one kind of session (e.g. one-on-ones).
CREATE TABLE coach_rates (
  coach_id      uuid NOT NULL REFERENCES coaches(id),
  category_id   uuid REFERENCES session_categories(id),
  amount_paise  bigint NOT NULL CHECK (amount_paise >= 0),
  updated_by    uuid NOT NULL REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (coach_id, category_id)
);

-- Money paid out to coaches ("settled").
CREATE TABLE coach_payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id      uuid NOT NULL REFERENCES coaches(id),
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  -- The month the payment is for (first day of that month).
  for_month     date NOT NULL CHECK (extract(day FROM for_month) = 1),
  paid_on       date NOT NULL,
  method        payment_method NOT NULL,
  reference     text,
  note          text,
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  voided_by     uuid REFERENCES users(id),
  void_reason   text
);
CREATE INDEX coach_payouts_month ON coach_payouts(for_month);

-- Other money going out: ground hire, balls, equipment, travel.
CREATE TABLE expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category      text NOT NULL CHECK (category IN ('ground', 'equipment', 'travel', 'staff', 'utilities', 'other')),
  description   text NOT NULL,
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  spent_on      date NOT NULL,
  method        payment_method NOT NULL,
  reference     text,
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  voided_by     uuid REFERENCES users(id),
  void_reason   text
);
CREATE INDEX expenses_spent_on ON expenses(spent_on);
