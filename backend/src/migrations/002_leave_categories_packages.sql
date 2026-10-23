-- Coach leave, session categories with coach priority, custom-time session
-- requests, and packages made of several parts (e.g. 9 one-on-one + 3 S&C).

-- ---------------------------------------------------------------------------
-- Session categories: what kind of training a session is. Packages count
-- sessions per category, and each category can have a coach priority order.
-- ---------------------------------------------------------------------------
CREATE TABLE session_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name          text NOT NULL,
  -- The session format used when a player requests this category at a time of their choosing.
  session_type  session_type NOT NULL,
  default_minutes integer NOT NULL DEFAULT 60 CHECK (default_minutes BETWEEN 15 AND 480),
  requestable   boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0
);

INSERT INTO session_categories (code, name, session_type, default_minutes, requestable, sort_order) VALUES
  ('one_on_one', 'One-on-one', 'one_on_one', 60, true, 1),
  ('one_on_two', 'One-on-two', 'one_on_two', 60, false, 2),
  ('group', 'Group training', 'group', 90, false, 3),
  ('strength_conditioning', 'Strength & conditioning', 'one_on_one', 60, true, 4);

ALTER TABLE sessions ADD COLUMN category_id uuid REFERENCES session_categories(id);
ALTER TABLE sessions ADD COLUMN origin text NOT NULL DEFAULT 'scheduled' CHECK (origin IN ('scheduled', 'request'));
UPDATE sessions s SET category_id = c.id FROM session_categories c WHERE c.code = s.session_type::text;
ALTER TABLE sessions ALTER COLUMN category_id SET NOT NULL;

-- Sessions created without a category get the one matching their format.
CREATE FUNCTION default_session_category() RETURNS trigger AS $$
BEGIN
  IF NEW.category_id IS NULL THEN
    SELECT id INTO NEW.category_id FROM session_categories WHERE code = NEW.session_type::text;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER sessions_default_category BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION default_session_category();

-- Which coaches take a category, in the order they are offered work.
CREATE TABLE category_coaches (
  category_id  uuid NOT NULL REFERENCES session_categories(id),
  coach_id     uuid NOT NULL REFERENCES coaches(id),
  priority     integer NOT NULL,
  PRIMARY KEY (category_id, coach_id)
);

-- ---------------------------------------------------------------------------
-- Coach leave. Planned leave and same-day emergencies are both recorded, never
-- deleted; cancelling leave keeps the row.
-- ---------------------------------------------------------------------------
CREATE TABLE coach_leave (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id      uuid NOT NULL REFERENCES coaches(id),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
  during        tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  kind          text NOT NULL CHECK (kind IN ('planned', 'emergency')),
  reason        text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  recorded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_by  uuid REFERENCES users(id),
  cancelled_at  timestamptz
);
CREATE INDEX coach_leave_during ON coach_leave USING gist (coach_id, during) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Packages made of parts. A fixed package with no parts is one shared pool
-- usable for any session, as before.
-- ---------------------------------------------------------------------------
CREATE TABLE package_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      uuid NOT NULL REFERENCES packages(id),
  category_id     uuid NOT NULL REFERENCES session_categories(id),
  total_sessions  integer NOT NULL CHECK (total_sessions >= 0),
  UNIQUE (package_id, category_id)
);

ALTER TABLE credit_ledger ADD COLUMN category_id uuid REFERENCES session_categories(id);

-- Reusable package designs the admin sets up once, e.g. "12-session pack".
CREATE TABLE package_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('fixed', 'flexible')),
  validity_days  integer NOT NULL CHECK (validity_days BETWEEN 1 AND 730),
  items          jsonb NOT NULL DEFAULT '[]',   -- [{ "categoryId": uuid, "total": int }]
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Coaches who passed a requested session on to the next coach in line, so it
-- is never offered back to them.
ALTER TABLE sessions ADD COLUMN passed_coach_ids uuid[] NOT NULL DEFAULT '{}';
