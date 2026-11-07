# Resend SMTP configuration

AssayNova can authenticate to `smtp.resend.com` on port `587` with the exact username `resend`. The SMTP password is the provider credential held in the existing private password file. Keep it out of source, command arguments and logs; install or replace that file opaquely through the reviewed operational process. Use a verified sending domain and verified STARTTLS. The application still requires TLS certificate and hostname verification and does not expose a private-config CA override.

Keep both `smtp.from` and `smtp.supportTo` set to `supports@assaynovalabs.com`. SMTP authentication identity is separate from the customer sender: From and envelope sender use `smtp.from`, and Reply-To and the configured support notification target use `smtp.supportTo`. Changing providers does not change customer routing or the report master's `reports@assaynovalabs.com` address.

The existing private JSON structure and file protection rules are unchanged. Set only the provider host/username and install its password privately; preserve the existing `outboxKeyFile` and its protected backup. Provider changes must not regenerate the encryption key or discard queued ciphertext. Keep `publicOrigin`, sender/support settings and the separately controlled report-notice setting as reviewed. Source support does not mean a running service has been updated or configured.

For other providers, the config loader continues to require a valid mailbox username equal to From and supportTo. The lower-level transport retains its previous acceptance of a valid mailbox username that differs from From; it does not choose sender/support routing. The only additional nonmailbox identity accepted by either layer is exactly `resend` at exactly lowercase `smtp.resend.com`.

See the official [Resend SMTP documentation](https://resend.com/docs/send-with-smtp) for the provider's credential and domain-verification requirements. AssayNova uses its existing port587 STARTTLS path.
