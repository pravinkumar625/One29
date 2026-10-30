CREATE TABLE IF NOT EXISTS files (
  id VARCHAR(255) PRIMARY KEY,
  username VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  kind VARCHAR(50) NOT NULL,
  bucket VARCHAR(100) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  mime VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  created BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_user_kind ON files (username, kind);
