CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_sub  TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE user_connections (
  user_id                         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  jira_site                       TEXT NOT NULL,
  jira_email                      TEXT NOT NULL,
  jira_token_ciphertext           BYTEA NOT NULL,
  github_org                      TEXT NOT NULL DEFAULT 'Orange-Health',
  github_token_ciphertext         BYTEA NOT NULL,
  jenkins_url                     TEXT NOT NULL,
  jenkins_username                TEXT NOT NULL,
  jenkins_token_ciphertext        BYTEA NOT NULL,
  production_jenkins_ciphertext   BYTEA,
  jira_project                    TEXT NOT NULL DEFAULT 'OH',
  validated_at                    TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme                TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  use_release_branch   BOOLEAN NOT NULL DEFAULT TRUE,
  pinned_repositories  JSONB NOT NULL DEFAULT '[]',
  build_notifications  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  sid     TEXT PRIMARY KEY,
  sess    JSONB NOT NULL,
  expire  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expire_idx ON sessions (expire);

CREATE TABLE audit_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  action       TEXT NOT NULL,
  repository   TEXT,
  version_id   TEXT,
  issue_key    TEXT,
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_user_created_idx ON audit_events (user_id, created_at DESC);

CREATE TABLE release_snapshots (
  version_id       TEXT PRIMARY KEY,
  version_name     TEXT NOT NULL,
  start_date       DATE,
  release_date     DATE,
  overdue          BOOLEAN NOT NULL DEFAULT FALSE,
  ticket_count     INT NOT NULL,
  eligible_count   INT NOT NULL,
  blocked_count    INT NOT NULL,
  merged_count     INT NOT NULL,
  unmatched_count  INT NOT NULL,
  service_count    INT NOT NULL,
  dashboard        JSONB NOT NULL,
  fetched_at       TIMESTAMPTZ NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  updated_by       UUID REFERENCES users(id)
);
CREATE INDEX release_snapshots_release_date_idx ON release_snapshots (release_date);
CREATE INDEX release_snapshots_expires_at_idx ON release_snapshots (expires_at);

CREATE TABLE release_repository_states (
  version_id         TEXT NOT NULL,
  repository         TEXT NOT NULL,
  production_ready   BOOLEAN NOT NULL DEFAULT FALSE,
  state              JSONB NOT NULL,
  fetched_at         TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (version_id, repository)
);
CREATE INDEX release_repository_states_expires_at_idx ON release_repository_states (expires_at);

CREATE TABLE release_progress (
  version_id   TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL
);
