CREATE TABLE IF NOT EXISTS seat_current (
  term text NOT NULL, section text NOT NULL, course text NOT NULL,
  available integer, capacity integer, waitlist integer,
  observed_at timestamptz NOT NULL, PRIMARY KEY (term, section)
);
CREATE TABLE IF NOT EXISTS seat_history (
  term text NOT NULL, section text NOT NULL, observed_at timestamptz NOT NULL,
  available integer, capacity integer, waitlist integer,
  PRIMARY KEY (term, section, observed_at)
);
CREATE TABLE IF NOT EXISTS sync_status (
  term text PRIMARY KEY, observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS watches (
  id text PRIMARY KEY, token_hash bytea NOT NULL, term text NOT NULL,
  section text NOT NULL, threshold integer NOT NULL, endpoint_key bytea NOT NULL,
  subscription jsonb NOT NULL, locale text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '120 days',
  UNIQUE (endpoint_key, term, section, threshold)
);
CREATE INDEX IF NOT EXISTS watches_by_section ON watches(term, section);
CREATE INDEX IF NOT EXISTS watches_expiration ON watches(expires_at);
CREATE TABLE IF NOT EXISTS deliveries (
  watch_id text NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL, available integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0, due timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(watch_id, observed_at)
);
CREATE INDEX IF NOT EXISTS pending_deliveries ON deliveries(due);
