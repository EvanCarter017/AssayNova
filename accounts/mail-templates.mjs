import { createHash } from 'node:crypto';
import { requestDetails, requestKind, REQUEST_KINDS } from '../dist/account-requests.js';
import { validMailbox } from './mail-config.mjs';

const subjects = Object.freeze({ verify_email: 'Verify your AssayNova email', reset_password: 'Reset your AssayNova password', request_receipt: 'AssayNova request receipt', support_alert: 'AssayNova submitted request', report_notice: 'AssayNova report publication notice' });
export function mailTemplate(event, { config, recipient, token, record, revision, user, reportCode }) {
  if (!config.enabled || !validMailbox(recipient) || !Object.hasOwn(subjects, event.kind)) throw new Error('Mail template is unavailable.');
  const origin = config.publicOrigin, domain = config.smtp.from.split('@')[1].toLowerCase();
  let body;
  if (event.kind === 'verify_email' || event.kind === 'reset_password') {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Mail action is unavailable.');
    const path = event.kind === 'verify_email' ? '/verify-email' : '/reset-password';
    body = `Open this link, then explicitly confirm the action on AssayNova:\n\n${origin}${path}#token=${token}\n\n${event.kind === 'verify_email' ? 'This link expires in 24 hours.' : 'This link expires in 15 minutes. Resetting your password replaces recovery codes and signs out all sessions.'}\n\nIf you did not request this, ignore this message. Contact ${config.smtp.supportTo} for help.`;
  } else if (event.kind === 'request_receipt') {
    body = `Your ${REQUEST_KINDS[requestKind(record)]} request is recorded by AssayNova.\nReference: ${record.id}\n\nManage your request: ${origin}/account\n\nThis receipt does not confirm laboratory acceptance, sample receipt or analysis completion.`;
  } else if (event.kind === 'support_alert') {
    body = `A ${REQUEST_KINDS[requestKind(record)]} request was explicitly submitted.\nReference: ${record.id}\nSubmission snapshot revision: ${revision}\nAccount mailbox verified: ${user.email_verified_at ? 'yes' : 'no'}\n\nClaimed form/testing email below is unverified contact information. It is not a delivery destination or proof of report ownership.\n\n${JSON.stringify(requestDetails(record), null, 2)}\n\nNo report was searched for or attached. Manual identity verification remains required before sharing a report.`;
  } else {
    if (!/^AN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reportCode)) throw new Error('Report notice is unavailable.');
    body = `Your AssayNova certificate of analysis is available.\nLookup Code: ${reportCode}\n\nView your report: ${origin}/coa/${reportCode}\n\nFor help, contact ${config.smtp.supportTo}.`;
  }
  return { version: 1, to: recipient, messageId: '<' + createHash('sha256').update(event.event_key).digest('hex') + '@' + domain + '>', date: new Date(event.created_at).toUTCString(), subject: subjects[event.kind], body };
}
