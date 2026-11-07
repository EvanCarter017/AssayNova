ALTER TABLE account_users ADD COLUMN email_verified_at INTEGER CHECK(email_verified_at IS NULL OR email_verified_at>0);
ALTER TABLE account_requests ADD COLUMN notification_revision INTEGER CHECK(notification_revision IS NULL OR notification_revision>0);
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
PRAGMA user_version=2;
