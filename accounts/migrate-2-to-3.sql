ALTER TABLE account_users ADD COLUMN password_enabled INTEGER NOT NULL DEFAULT 1 CHECK(password_enabled IN(0,1));
ALTER TABLE account_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password' CHECK(auth_method IN('password','google'));
ALTER TABLE account_sessions ADD COLUMN google_reauth_at INTEGER CHECK(google_reauth_at IS NULL OR google_reauth_at>0);
ALTER TABLE account_sessions ADD COLUMN google_reauth_purpose TEXT CHECK(google_reauth_purpose IN('password_setup','recovery_codes'));
CREATE TABLE account_identities (
  provider TEXT NOT NULL CHECK(provider='google'),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255 AND subject NOT GLOB '*[^!-~]*'),
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(provider,subject),
  UNIQUE(user_id,provider)
) STRICT;
CREATE INDEX account_identities_user ON account_identities(user_id);
CREATE TABLE account_google_flows (
  state_hash TEXT PRIMARY KEY CHECK(length(state_hash)=64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  browser_hash TEXT NOT NULL UNIQUE CHECK(length(browser_hash)=64 AND browser_hash NOT GLOB '*[^0-9a-f]*'),
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash)=64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  intent TEXT NOT NULL CHECK(intent IN('login','link','reauth')),
  safe_next TEXT NOT NULL CHECK(safe_next IN('/account','/submit-sample','/contact','/contact?request=report-recovery')),
  initiating_user_id TEXT REFERENCES account_users(id) ON DELETE CASCADE,
  initiating_session_hash TEXT REFERENCES account_sessions(token_hash) ON DELETE CASCADE CHECK(initiating_session_hash IS NULL OR (length(initiating_session_hash)=64 AND initiating_session_hash NOT GLOB '*[^0-9a-f]*')),
  initiating_csrf_hash TEXT NOT NULL CHECK(length(initiating_csrf_hash)=64 AND initiating_csrf_hash NOT GLOB '*[^0-9a-f]*'),
  expected_security_version INTEGER,
  expected_recovery_version INTEGER,
  expected_subject TEXT CHECK(expected_subject IS NULL OR (length(expected_subject) BETWEEN 1 AND 255 AND expected_subject NOT GLOB '*[^!-~]*')),
  reauth_purpose TEXT CHECK(reauth_purpose IN('password_setup','recovery_codes')),
  resolved_user_id TEXT REFERENCES account_users(id) ON DELETE CASCADE,
  resolved_security_version INTEGER,
  resolved_recovery_version INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN('started','exchanging','ready','failed')),
  ready_at INTEGER,
  subject TEXT CHECK(length(subject) BETWEEN 1 AND 255 AND subject NOT GLOB '*[^!-~]*'),
  email TEXT CHECK(length(email)<=160),
  email_verified INTEGER CHECK(email_verified IN(0,1)),
  name TEXT CHECK(length(name)<=100),
  hd TEXT CHECK(length(hd)<=253),
  CHECK((intent='login' AND initiating_user_id IS NULL AND initiating_session_hash IS NULL AND expected_security_version IS NULL AND expected_recovery_version IS NULL) OR (intent IN('link','reauth') AND initiating_user_id IS NOT NULL AND initiating_session_hash IS NOT NULL AND expected_security_version IS NOT NULL AND expected_recovery_version IS NOT NULL AND expected_security_version>0 AND expected_recovery_version>0)),
  CHECK((intent='reauth' AND expected_subject IS NOT NULL AND reauth_purpose IS NOT NULL) OR (intent<>'reauth' AND expected_subject IS NULL AND reauth_purpose IS NULL)),
  CHECK((resolved_user_id IS NULL AND resolved_security_version IS NULL AND resolved_recovery_version IS NULL) OR (resolved_user_id IS NOT NULL AND resolved_security_version IS NOT NULL AND resolved_recovery_version IS NOT NULL AND resolved_security_version>0 AND resolved_recovery_version>0)),
  CHECK((status='ready' AND ready_at IS NOT NULL AND subject IS NOT NULL AND email IS NOT NULL AND email_verified IS NOT NULL AND name IS NOT NULL AND hd IS NOT NULL) OR (status<>'ready' AND ready_at IS NULL AND subject IS NULL AND email IS NULL AND email_verified IS NULL AND name IS NULL AND hd IS NULL))
) STRICT;
CREATE INDEX account_google_flows_expiry ON account_google_flows(expires_at,status);
CREATE INDEX account_google_flows_user ON account_google_flows(initiating_user_id);
CREATE INDEX account_google_flows_resolved ON account_google_flows(resolved_user_id);
CREATE INDEX account_google_flows_session ON account_google_flows(initiating_session_hash);
PRAGMA user_version=3;
