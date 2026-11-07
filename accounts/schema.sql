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
  updated_at INTEGER NOT NULL,
  email_verified_at INTEGER CHECK(email_verified_at IS NULL OR email_verified_at>0),
  password_enabled INTEGER NOT NULL DEFAULT 1 CHECK(password_enabled IN(0,1))
) STRICT;
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64),
  security_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'password' CHECK(auth_method IN('password','google')),
  google_reauth_at INTEGER CHECK(google_reauth_at IS NULL OR google_reauth_at>0),
  google_reauth_purpose TEXT CHECK(google_reauth_purpose IN('password_setup','recovery_codes'))
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
  updated_at INTEGER NOT NULL,
  notification_revision INTEGER CHECK(notification_revision IS NULL OR notification_revision>0)
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


-- Transactional mail tables
CREATE TABLE account_mail_tokens (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
 email_hash TEXT NOT NULL CHECK(length(email_hash)=64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
 security_version INTEGER NOT NULL CHECK(security_version>0),
 recovery_version INTEGER NOT NULL CHECK(recovery_version>0),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at>=created_at),
 UNIQUE(user_id,purpose)
) STRICT;
CREATE INDEX account_mail_tokens_expiry ON account_mail_tokens(expires_at);
CREATE TABLE account_mail_events (
 event_key TEXT PRIMARY KEY CHECK(length(event_key) BETWEEN 1 AND 160 AND event_key NOT GLOB '*[^A-Za-z0-9:_-]*'),
 kind TEXT NOT NULL CHECK(kind IN ('verify_email','reset_password','request_receipt','support_alert','report_notice')),
 user_id TEXT REFERENCES account_users(id) ON DELETE CASCADE,
 request_id TEXT REFERENCES account_requests(id) ON DELETE CASCADE,
 token_hash TEXT REFERENCES account_mail_tokens(token_hash) ON DELETE CASCADE,
 report_code TEXT CHECK(report_code IS NULL OR (length(report_code)=12 AND report_code GLOB 'AN-[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]-[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]')),
 recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('account','support','report')),
 recipient_hash TEXT CHECK(recipient_hash IS NULL OR (length(recipient_hash)=64 AND recipient_hash NOT GLOB '*[^0-9a-f]*')),
 state TEXT NOT NULL CHECK(state IN ('not_verified','not_configured','unsupported_address','backpressure','unavailable','queued','retrying','accepted','failed','expired','canceled')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 accepted_at INTEGER,
 failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('network','uncertain','temporary','permanent','authentication','tls','protocol','message_too_large','integrity','unavailable','canceled','expired')),
 CHECK((state='accepted' AND accepted_at IS NOT NULL) OR (state<>'accepted' AND accepted_at IS NULL)),
 CHECK((kind IN ('verify_email','reset_password') AND user_id IS NOT NULL AND token_hash IS NOT NULL AND request_id IS NULL AND report_code IS NULL AND recipient_kind='account' AND recipient_hash IS NOT NULL)
 OR (kind IN ('request_receipt','support_alert') AND user_id IS NOT NULL AND request_id IS NOT NULL AND token_hash IS NULL AND report_code IS NULL AND ((kind='request_receipt' AND recipient_kind='account') OR (kind='support_alert' AND recipient_kind='support')))
 OR (kind='report_notice' AND user_id IS NULL AND request_id IS NULL AND token_hash IS NULL AND report_code IS NOT NULL AND recipient_kind='report' AND recipient_hash IS NOT NULL))
) STRICT;
CREATE INDEX account_mail_events_request ON account_mail_events(request_id);
CREATE INDEX account_mail_events_token ON account_mail_events(token_hash);
CREATE TABLE account_mail_outbox (
 event_key TEXT PRIMARY KEY REFERENCES account_mail_events(event_key) ON DELETE CASCADE,
 key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 64 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
 nonce BLOB NOT NULL CHECK(length(nonce)=12),
 tag BLOB NOT NULL CHECK(length(tag)=16),
 ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 1 AND 98304),
 state TEXT NOT NULL CHECK(state IN ('queued','leased','retry')),
 attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 6),
 next_attempt_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 lease_id TEXT CHECK(lease_id IS NULL OR (length(lease_id)=32 AND lease_id NOT GLOB '*[^0-9a-f]*')),
 lease_until INTEGER,
 uncertain INTEGER NOT NULL CHECK(uncertain IN (0,1)),
 created_at INTEGER NOT NULL,
 CHECK((state='leased' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR (state IN ('queued','retry') AND lease_id IS NULL AND lease_until IS NULL))
) STRICT;
CREATE INDEX account_mail_outbox_ready ON account_mail_outbox(state,next_attempt_at,expires_at);
CREATE INDEX account_mail_outbox_lease ON account_mail_outbox(lease_until);
CREATE TABLE account_mail_rates (
 bucket_hash TEXT PRIMARY KEY CHECK(length(bucket_hash)=64 AND bucket_hash NOT GLOB '*[^0-9a-f]*'),
 window_start INTEGER NOT NULL,
 window_ms INTEGER NOT NULL CHECK(window_ms BETWEEN 60000 AND 86400000),
 count INTEGER NOT NULL CHECK(count>=0),
 expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX account_mail_rates_expiry ON account_mail_rates(expires_at);
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
