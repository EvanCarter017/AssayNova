CREATE TABLE account_users (
  id TEXT PRIMARY KEY CHECK(length(id)=32),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  password_salt TEXT NOT NULL CHECK(length(password_salt)=32),
  password_hash TEXT NOT NULL CHECK(length(password_hash)=64),
  security_version INTEGER NOT NULL CHECK(security_version>0),
  recovery_version INTEGER NOT NULL CHECK(recovery_version>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64),
  security_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX account_sessions_user ON account_sessions(user_id);
CREATE TABLE account_challenges (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE account_recovery_codes (
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK(length(code_hash)=64),
  PRIMARY KEY(user_id,code_hash)
) STRICT;
CREATE TABLE account_requests (
  id TEXT PRIMARY KEY CHECK(length(id)=32),
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX account_requests_user ON account_requests(user_id,updated_at DESC,id);
CREATE TABLE account_idempotency (
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  request_id TEXT REFERENCES account_requests(id) ON DELETE SET NULL,
  PRIMARY KEY(user_id,request_key)
) STRICT;
CREATE TABLE account_rates (
  bucket_hash TEXT PRIMARY KEY CHECK(length(bucket_hash)=64),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version=1;
