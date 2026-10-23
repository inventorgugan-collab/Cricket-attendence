-- Cricket Performance Lab: Phase 1 core schema.
-- Integrity rules that must hold for every client (online or replayed offline)
-- live here as constraints and triggers rather than only in application code.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Every syncable row gets a monotonically increasing change number so devices
-- can pull "everything that changed since N".
CREATE SEQUENCE change_seq;

CREATE FUNCTION bump_change_seq() RETURNS trigger AS $$
BEGIN
  NEW.change_seq := nextval('change_seq');
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin', 'coach', 'player', 'guardian');
CREATE TYPE account_status AS ENUM ('active', 'deactivated');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login          text NOT NULL UNIQUE CHECK (login = lower(login)),
  password_hash  text NOT NULL,
  role           user_role NOT NULL,
  display_name   text NOT NULL,
  status         account_status NOT NULL DEFAULT 'active',
  token_version  integer NOT NULL DEFAULT 0,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  change_seq     bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER users_seq BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
CREATE TYPE player_status AS ENUM ('active', 'inactive', 'archived');

CREATE TABLE players (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid UNIQUE REFERENCES users(id),
  full_name             text NOT NULL,
  date_of_birth         date NOT NULL,
  gender                text,
  city                  text,
  address               text,
  phone                 text,
  alt_phone             text,
  father_name           text,
  father_phone          text,
  mother_name           text,
  mother_phone          text,
  emergency_name        text,
  emergency_phone       text,
  emergency_relationship text,
  registration_date     date NOT NULL DEFAULT current_date,
  status                player_status NOT NULL DEFAULT 'active',
  -- cricket profile
  primary_role          text CHECK (primary_role IN ('batter','bowler','all_rounder','wicketkeeper','other')),
  batting_style         text CHECK (batting_style IN ('right_hand','left_hand')),
  batting_position      text,
  bowling_arm           text CHECK (bowling_arm IN ('right','left')),
  bowling_style         text,
  previous_teams        text,
  playing_level         text,
  experience            text,
  development_goals     text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  change_seq            bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER players_seq BEFORE INSERT OR UPDATE ON players FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

CREATE TABLE guardians (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid UNIQUE REFERENCES users(id),
  full_name   text NOT NULL,
  phone       text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  change_seq  bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER guardians_seq BEFORE INSERT OR UPDATE ON guardians FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

CREATE TABLE player_guardians (
  player_id     uuid NOT NULL REFERENCES players(id),
  guardian_id   uuid NOT NULL REFERENCES guardians(id),
  relationship  text NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  can_book      boolean NOT NULL DEFAULT true,
  can_consent   boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, guardian_id)
);

CREATE TYPE consent_type AS ENUM ('data_processing', 'injury_information', 'video_recording', 'video_sharing');

-- Consent is an append-only log; the latest row per (player, type) is current.
CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL REFERENCES players(id),
  consent_type  consent_type NOT NULL,
  granted       boolean NOT NULL,
  given_by_guardian_id uuid REFERENCES guardians(id),
  given_by_user_id uuid NOT NULL REFERENCES users(id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_player ON consents(player_id, consent_type, created_at DESC);

CREATE TABLE coaches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid UNIQUE REFERENCES users(id),
  full_name   text NOT NULL,
  phone       text,
  specialisations text,
  requires_booking_approval boolean NOT NULL DEFAULT false,
  status      player_status NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  change_seq  bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER coaches_seq BEFORE INSERT OR UPDATE ON coaches FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

CREATE TABLE player_coaches (
  player_id  uuid NOT NULL REFERENCES players(id),
  coach_id   uuid NOT NULL REFERENCES coaches(id),
  PRIMARY KEY (player_id, coach_id)
);

-- Weekly availability windows; used to warn when scheduling outside them.
CREATE TABLE coach_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    uuid NOT NULL REFERENCES coaches(id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- ISO, 1 = Monday
  start_time  time NOT NULL,
  end_time    time NOT NULL CHECK (end_time > start_time)
);

-- Injury records are kept apart from the profile so they can carry stricter access.
CREATE TABLE injuries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id          uuid NOT NULL REFERENCES players(id),
  title              text NOT NULL,
  severity           text NOT NULL CHECK (severity IN ('minor','major')),
  is_current         boolean NOT NULL DEFAULT true,
  injury_date        date,
  recovery_status    text,
  professional_restrictions text,
  coach_observations text,
  follow_up_date     date,
  reported_by        uuid NOT NULL REFERENCES users(id),
  source             text NOT NULL CHECK (source IN ('player_report','guardian_report','coach','admin')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  change_seq         bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER injuries_seq BEFORE INSERT OR UPDATE ON injuries FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

-- ---------------------------------------------------------------------------
-- Facilities and groups
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  address   text,
  active    boolean NOT NULL DEFAULT true
);

CREATE TABLE training_areas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES locations(id),
  name         text NOT NULL,
  kind         text,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE training_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE group_members (
  group_id   uuid NOT NULL REFERENCES training_groups(id),
  player_id  uuid NOT NULL REFERENCES players(id),
  PRIMARY KEY (group_id, player_id)
);

CREATE TABLE group_coaches (
  group_id  uuid NOT NULL REFERENCES training_groups(id),
  coach_id  uuid NOT NULL REFERENCES coaches(id),
  PRIMARY KEY (group_id, coach_id)
);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
CREATE TYPE session_type AS ENUM ('group', 'one_on_one', 'one_on_two');
CREATE TYPE session_status AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled', 'interrupted');
CREATE TYPE booking_mode AS ENUM ('fixed', 'open');

CREATE TABLE recurrences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekdays    smallint[] NOT NULL,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_type    session_type NOT NULL,
  booking_mode    booking_mode NOT NULL DEFAULT 'fixed',
  title           text,
  training_focus  text,
  location_id     uuid REFERENCES locations(id),
  area_id         uuid REFERENCES training_areas(id),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  during          tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  capacity        integer NOT NULL CHECK (capacity > 0),
  status          session_status NOT NULL DEFAULT 'scheduled',
  group_id        uuid REFERENCES training_groups(id),
  recurrence_id   uuid REFERENCES recurrences(id),
  cancellation_reason text,
  rescheduled_from uuid REFERENCES sessions(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  change_seq      bigint NOT NULL DEFAULT 0,
  CHECK (ends_at > starts_at),
  CHECK (session_type <> 'one_on_one' OR capacity = 1),
  CHECK (session_type <> 'one_on_two' OR capacity = 2),
  -- No two live sessions may share a training area at the same time.
  CONSTRAINT sessions_no_area_overlap EXCLUDE USING gist (area_id WITH =, during WITH &&)
    WHERE (status <> 'cancelled' AND area_id IS NOT NULL)
);
CREATE INDEX sessions_starts ON sessions(starts_at);
CREATE TRIGGER sessions_seq BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

-- Session coaches carry a copy of the session time range so the database can
-- reject double-booking a coach.
CREATE TABLE session_coaches (
  session_id  uuid NOT NULL REFERENCES sessions(id),
  coach_id    uuid NOT NULL REFERENCES coaches(id),
  during      tstzrange NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  change_seq  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, coach_id),
  CONSTRAINT session_coaches_no_overlap EXCLUDE USING gist (coach_id WITH =, during WITH &&) WHERE (active)
);
CREATE TRIGGER session_coaches_seq BEFORE INSERT OR UPDATE ON session_coaches FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
CREATE TYPE booking_status AS ENUM ('pending', 'waitlisted', 'confirmed', 'rejected', 'cancelled', 'completed');
CREATE TYPE booking_source AS ENUM ('request', 'direct', 'roster', 'walk_in', 'makeup');

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES sessions(id),
  player_id        uuid NOT NULL REFERENCES players(id),
  status           booking_status NOT NULL,
  source           booking_source NOT NULL,
  -- What still has to happen before a pending booking can be confirmed.
  approvals_needed text[] NOT NULL DEFAULT '{}',
  review_reasons   text[] NOT NULL DEFAULT '{}',
  is_makeup        boolean NOT NULL DEFAULT false,
  package_id       uuid,
  during           tstzrange NOT NULL,
  requested_by     uuid NOT NULL REFERENCES users(id),
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  decision_reason  text,
  waitlist_position integer,
  client_request_id uuid UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  change_seq       bigint NOT NULL DEFAULT 0,
  -- A player can't hold two confirmed bookings at overlapping times.
  CONSTRAINT bookings_no_player_overlap EXCLUDE USING gist (player_id WITH =, during WITH &&)
    WHERE (status = 'confirmed')
);
-- At most one live booking per player per session.
CREATE UNIQUE INDEX bookings_one_live ON bookings(session_id, player_id)
  WHERE status IN ('pending', 'waitlisted', 'confirmed', 'completed');
CREATE INDEX bookings_session ON bookings(session_id);
CREATE INDEX bookings_player ON bookings(player_id);
CREATE TRIGGER bookings_seq BEFORE INSERT OR UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

-- Capacity is checked under a lock on the session row, so two simultaneous
-- requests for the last place can't both be confirmed.
CREATE FUNCTION enforce_booking_capacity() RETURNS trigger AS $$
DECLARE
  cap integer;
  taken integer;
BEGIN
  IF NEW.status <> 'confirmed' OR (TG_OP = 'UPDATE' AND OLD.status = 'confirmed') THEN
    RETURN NEW;
  END IF;
  SELECT capacity INTO cap FROM sessions WHERE id = NEW.session_id FOR UPDATE;
  SELECT count(*) INTO taken FROM bookings
    WHERE session_id = NEW.session_id AND status IN ('confirmed', 'completed') AND id <> NEW.id;
  IF taken >= cap THEN
    RAISE EXCEPTION 'session % is full', NEW.session_id USING ERRCODE = 'P0001', HINT = 'capacity';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bookings_capacity BEFORE INSERT OR UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_capacity();

-- Keep copied time ranges in step when a session is rescheduled or cancelled.
CREATE FUNCTION sync_session_ranges() RETURNS trigger AS $$
BEGIN
  IF NEW.during IS DISTINCT FROM OLD.during THEN
    UPDATE session_coaches SET during = NEW.during WHERE session_id = NEW.id;
    UPDATE bookings SET during = NEW.during WHERE session_id = NEW.id;
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE session_coaches SET active = false WHERE session_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER sessions_sync_ranges AFTER UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sync_session_ranges();

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------
CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'late', 'excused', 'not_applicable');

CREATE TABLE attendance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES sessions(id),
  player_id        uuid NOT NULL REFERENCES players(id),
  booking_id       uuid REFERENCES bookings(id),
  status           attendance_status NOT NULL,
  original_status  attendance_status NOT NULL,
  note             text,
  recorded_by      uuid NOT NULL REFERENCES users(id),
  recorded_at      timestamptz NOT NULL,      -- when the coach marked it (device time)
  received_at      timestamptz NOT NULL DEFAULT now(),
  admin_locked     boolean NOT NULL DEFAULT false,
  version          integer NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  change_seq       bigint NOT NULL DEFAULT 0,
  UNIQUE (session_id, player_id)
);
CREATE TRIGGER attendance_seq BEFORE INSERT OR UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

-- Append-only history: the original mark, every correction and every override.
CREATE TABLE attendance_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id   uuid NOT NULL REFERENCES attendance(id),
  kind            text NOT NULL CHECK (kind IN ('initial','correction','override','session_cancelled')),
  previous_status attendance_status,
  new_status      attendance_status NOT NULL,
  reason          text,
  changed_by      uuid NOT NULL REFERENCES users(id),
  changed_by_role user_role NOT NULL,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attendance_events_att ON attendance_events(attendance_id, received_at);

CREATE TABLE coach_attendance (
  session_id   uuid NOT NULL REFERENCES sessions(id),
  coach_id     uuid NOT NULL REFERENCES coaches(id),
  status       attendance_status NOT NULL,
  recorded_by  uuid NOT NULL REFERENCES users(id),
  recorded_at  timestamptz NOT NULL,
  note         text,
  PRIMARY KEY (session_id, coach_id)
);

-- ---------------------------------------------------------------------------
-- Training packages (entitlements only, no money)
-- ---------------------------------------------------------------------------
CREATE TABLE packages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id       uuid NOT NULL REFERENCES players(id),
  kind            text NOT NULL CHECK (kind IN ('fixed','flexible')),
  name            text NOT NULL,
  starts_on       date NOT NULL,
  expires_on      date NOT NULL CHECK (expires_on >= starts_on),
  total_sessions  integer CHECK (total_sessions IS NULL OR total_sessions >= 0),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced','cancelled')),
  replaced_by     uuid REFERENCES packages(id),
  notes           text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  change_seq      bigint NOT NULL DEFAULT 0,
  CHECK ((kind = 'fixed') = (total_sessions IS NOT NULL))
);
CREATE INDEX packages_player ON packages(player_id);
CREATE TRIGGER packages_seq BEFORE INSERT OR UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

ALTER TABLE bookings ADD CONSTRAINT bookings_package FOREIGN KEY (package_id) REFERENCES packages(id);

-- Every credit movement is a ledger row; balances are sums, never overwritten.
CREATE TABLE credit_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id     uuid NOT NULL REFERENCES packages(id),
  player_id      uuid NOT NULL REFERENCES players(id),
  delta          integer NOT NULL,
  reason         text NOT NULL CHECK (reason IN ('attendance','attendance_reversal','adjustment','makeup_grant')),
  session_id     uuid REFERENCES sessions(id),
  attendance_id  uuid REFERENCES attendance(id),
  note           text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_package ON credit_ledger(package_id);
CREATE INDEX credit_ledger_attendance ON credit_ledger(attendance_id);

-- ---------------------------------------------------------------------------
-- Journals and coaching notes
-- ---------------------------------------------------------------------------
CREATE TABLE player_journal_entries (
  id            uuid PRIMARY KEY,
  player_id     uuid NOT NULL REFERENCES players(id),
  session_id    uuid REFERENCES sessions(id),
  entry_date    date NOT NULL,
  skills        text,
  drills        text,
  volume        jsonb NOT NULL DEFAULT '{}',   -- reps, sets, balls, overs
  went_well     text,
  to_improve    text,
  reflections   text,
  goals         text,
  difficulties  text,
  created_by    uuid NOT NULL REFERENCES users(id),
  updated_by    uuid NOT NULL REFERENCES users(id),
  version       integer NOT NULL DEFAULT 1,
  deleted       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  change_seq    bigint NOT NULL DEFAULT 0
);
CREATE INDEX journal_player ON player_journal_entries(player_id, entry_date DESC);
CREATE TRIGGER journal_seq BEFORE INSERT OR UPDATE ON player_journal_entries FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

CREATE TABLE coach_notes (
  id                    uuid PRIMARY KEY,
  session_id            uuid REFERENCES sessions(id),
  player_id             uuid REFERENCES players(id),   -- null = whole-session note
  coach_id              uuid NOT NULL REFERENCES coaches(id),
  objectives            text,
  drills_completed      text,
  technical_corrections text,
  tactical_awareness    text,
  match_simulation      text,
  mental_skills         text,
  fitness               text,
  follow_up_drills      text,
  next_targets          text,
  shared_with_player    boolean NOT NULL DEFAULT false,
  created_by            uuid NOT NULL REFERENCES users(id),
  updated_by            uuid NOT NULL REFERENCES users(id),
  version               integer NOT NULL DEFAULT 1,
  deleted               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  change_seq            bigint NOT NULL DEFAULT 0,
  CHECK (session_id IS NOT NULL OR player_id IS NOT NULL)
);
CREATE INDEX coach_notes_player ON coach_notes(player_id);
CREATE INDEX coach_notes_session ON coach_notes(session_id);
CREATE TRIGGER coach_notes_seq BEFORE INSERT OR UPDATE ON coach_notes FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

-- Full previous versions of edited free-text records, so nothing is lost.
CREATE TABLE record_revisions (
  id          bigserial PRIMARY KEY,
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  version     integer NOT NULL,
  data        jsonb NOT NULL,
  edited_by   uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_revisions_entity ON record_revisions(entity, entity_id);

-- ---------------------------------------------------------------------------
-- Notifications and announcements
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  pushed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE push_tokens (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('android','ios')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  audience    user_role[] NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Settings, audit, sync
-- ---------------------------------------------------------------------------
CREATE TABLE academy_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  actor_role  user_role,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  mutation_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);
CREATE INDEX audit_created ON audit_log(created_at DESC);

-- Each offline mutation is applied at most once, keyed by the id the device made.
CREATE TABLE sync_mutations (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  type         text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('applied','rejected','conflict')),
  result       jsonb NOT NULL,
  client_time  timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_conflicts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mutation_id   uuid NOT NULL REFERENCES sync_mutations(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  entity        text NOT NULL,
  entity_id     uuid,
  reason        text NOT NULL,
  client_data   jsonb NOT NULL,
  server_data   jsonb,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_by   uuid REFERENCES users(id),
  resolution    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX sync_conflicts_open ON sync_conflicts(status, created_at);
