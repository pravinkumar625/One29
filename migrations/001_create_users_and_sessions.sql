CREATE TABLE IF NOT EXISTS users (
  username VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  sub VARCHAR(255),
  email VARCHAR(255),
  tagline VARCHAR(255) DEFAULT '',
  role VARCHAR(100) DEFAULT '',
  bio TEXT DEFAULT '',
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  links JSONB NOT NULL DEFAULT '{}'::jsonb,
  projects JSONB NOT NULL DEFAULT '[]'::jsonb,
  theme INTEGER NOT NULL DEFAULT 0,
  resume_public BOOLEAN NOT NULL DEFAULT false,
  created BIGINT NOT NULL,
  updated BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub ON users (sub) WHERE sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  username VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
