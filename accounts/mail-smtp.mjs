import net from 'node:net';
import tls from 'node:tls';
import { validMailbox, validMailHost } from './mail-config.mjs';
import { validMailPayload } from './mail-crypto.mjs';

class SMTPError extends Error {
  constructor(code, outcome = 'cooldown', uncertain = false) { super('SMTP submission could not be confirmed.'); this.code = code; this.outcome = outcome; this.uncertain = uncertain; }
}
export function formatSMTPMessage(payload, from, support) {
  if (!validMailPayload(payload) || !validMailbox(from) || !validMailbox(support)) throw new SMTPError('protocol', 'failed');
  const body = Buffer.from(payload.body.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  const headers = [`From: AssayNova <${from}>`, `To: <${payload.to}>`, `Reply-To: <${support}>`, `Date: ${payload.date}`, `Message-ID: ${payload.messageId}`, `Subject: ${payload.subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  const message = Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body + '\r\n', 'ascii');
  if (message.length > 131072 || message.toString('ascii').split('\r\n').some(line => Buffer.byteLength(line) > 998)) throw new SMTPError('message_too_large', 'failed');
  return message;
}
function replies(socket, budget, timeout) {
  let buffer = Buffer.alloc(0), waiting = null, failure = null, code = null, lines = [], replyBytes = 0;
  const reject = error => { failure ||= error; if (waiting) { clearTimeout(waiting.timer); waiting.reject(failure); waiting = null; } socket.destroy(); };
  const data = chunk => {
    budget.bytes += chunk.length;
    if (budget.bytes > 262144 || !waiting) { reject(new SMTPError('protocol')); return; }
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n');
      const newline = buffer.indexOf(10);
      if (newline >= 0 && (newline === 0 || buffer[newline - 1] !== 13) || end < 0 && buffer.length > 510) { reject(new SMTPError('protocol')); return; }
      if (end < 0) return;
      if (end + 2 > 512) { reject(new SMTPError('protocol')); return; }
      const line = buffer.subarray(0, end).toString('latin1'); buffer = buffer.subarray(end + 2); replyBytes += end + 2;
      const match = /^([2-5]\d\d)([ -])([\x20-\xff]*)$/.exec(line);
      if (!match || code !== null && code !== Number(match[1]) || lines.length >= 64 || replyBytes > 32768) { reject(new SMTPError('protocol')); return; }
      code = Number(match[1]); lines.push(match[3]);
      if (match[2] === ' ') {
        if (buffer.length) { reject(new SMTPError('protocol')); return; }
        const result = { code, lines }; const active = waiting; waiting = null; clearTimeout(active.timer); code = null; lines = []; replyBytes = 0; active.resolve(result); return;
      }
    }
  };
  const error = () => reject(new SMTPError('network', 'retry'));
  const close = () => { if (waiting) reject(new SMTPError('network', 'retry')); };
  socket.on('data', data); socket.on('error', error); socket.on('close', close);
  return {
    read() { if (failure) return Promise.reject(failure); if (waiting || buffer.length) return Promise.reject(new SMTPError('protocol')); return new Promise((resolve, reject) => { waiting = { resolve, reject, timer: setTimeout(() => { failure = new SMTPError('network', 'retry'); const active = waiting; waiting = null; active.reject(failure); socket.destroy(); }, timeout) }; }); },
    empty() { if (failure || buffer.length || waiting || socket.readableLength) throw failure || new SMTPError('protocol'); },
    dispose() { socket.off('data', data); socket.off('error', error); socket.off('close', close); if (waiting) { clearTimeout(waiting.timer); waiting.reject(new SMTPError('network', 'retry')); waiting = null; } }
  };
}
const phase = (socket, event, timeout, code) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(new SMTPError(code, code === 'network' ? 'retry' : 'cooldown')), timeout);
  const ok = () => finish(), bad = () => finish(new SMTPError(code, code === 'network' ? 'retry' : 'cooldown'));
  function finish(error) { clearTimeout(timer); socket.off(event, ok); socket.off('error', bad); socket.off('close', bad); error ? reject(error) : resolve(); }
  socket.once(event, ok); socket.once('error', bad); socket.once('close', bad);
});

// Tests may inject a loopback dialer and synthetic CA in process. Production
// JSON has no CA, insecure-TLS, host-override or certificate-check escape hatch.
export function createSMTPTransport({ smtp, dial = options => net.connect(options), ca, phaseTimeout = 10000, totalTimeout = 60000 } = {}) {
  if (!smtp || !validMailHost(smtp.host) || smtp.port !== 587 || !validMailbox(smtp.username) || !validMailbox(smtp.from) || !validMailbox(smtp.supportTo) || !Number.isSafeInteger(phaseTimeout) || phaseTimeout < 1 || phaseTimeout > 10000 || !Number.isSafeInteger(totalTimeout) || totalTimeout < 1 || totalTimeout > 60000) throw new Error('SMTP transport configuration is unavailable.');
  return Object.freeze({
    async send(payload, { signal, beforeData = async () => true } = {}) {
      let socket, reader, dataStarted = false, accepted = false, aborted = false; const stopped = new AbortController();
      const budget = { bytes: 0 };
      const stop = () => { aborted = true; stopped.abort(); socket?.destroy(); };
      if (signal?.aborted) return { outcome: 'canceled', code: 'canceled', uncertain: false };
      signal?.addEventListener('abort', stop, { once: true }); const overall = setTimeout(stop, totalTimeout);
      try {
        const message = formatSMTPMessage(payload, smtp.from, smtp.supportTo);
        socket = dial({ host: smtp.host, port: smtp.port });
        reader = replies(socket, budget, phaseTimeout); const greeting = reader.read(); greeting.catch(() => {});
        if (socket.connecting) await phase(socket, 'connect', phaseTimeout, 'network');
        const requireCode = (reply, codes, category = 'protocol') => {
          if (codes.includes(reply.code)) return reply;
          if (category === 'authentication' || category === 'tls') throw new SMTPError(category);
          if (reply.code >= 400 && reply.code < 500) throw new SMTPError('temporary', 'retry');
          if (category === 'message' && reply.code >= 500) throw new SMTPError('permanent', 'failed');
          throw new SMTPError('protocol');
        };
        const command = async (text, codes, category) => { if (aborted) throw new SMTPError('network', 'retry', dataStarted); const pending = reader.read(); socket.write(text + '\r\n'); return requireCode(await pending, codes, category); };
        requireCode(await greeting, [220]);
        const initial = await command('EHLO ' + new URL('https://' + smtp.from.split('@')[1]).hostname, [250]);
        if (!initial.lines.some(line => /^STARTTLS(?:\s|$)/i.test(line))) throw new SMTPError('tls');
        await command('STARTTLS', [220], 'tls'); reader.empty(); reader.dispose(); reader = null;
        socket.on('error', () => {});
        socket = tls.connect({ socket, servername: smtp.host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) });
        await phase(socket, 'secureConnect', phaseTimeout, 'tls');
        if (!socket.authorized) throw new SMTPError('tls');
        reader = replies(socket, budget, phaseTimeout);
        const secure = await command('EHLO ' + smtp.from.split('@')[1].toLowerCase(), [250]);
        const auth = secure.lines.filter(line => /^AUTH(?:\s|=)/i.test(line)).flatMap(line => line.replace(/^AUTH[ =]+/i, '').toUpperCase().split(/\s+/));
        if (auth.includes('PLAIN')) {
          const response = Buffer.from('\0' + smtp.username + '\0' + smtp.password, 'utf8').toString('base64');
          const result = await command('AUTH PLAIN ' + response, [235, 334], 'authentication'); if (result.code === 334) await command(response, [235], 'authentication');
        } else if (auth.includes('LOGIN')) {
          await command('AUTH LOGIN', [334], 'authentication'); await command(Buffer.from(smtp.username).toString('base64'), [334], 'authentication'); await command(Buffer.from(smtp.password).toString('base64'), [235], 'authentication');
        } else throw new SMTPError('authentication');
        const size = secure.lines.map(line => /^SIZE(?:\s+(\d{1,12}))?$/i.exec(line)).find(Boolean);
        if (size?.[1] && message.length > Number(size[1])) throw new SMTPError('message_too_large', 'failed');
        await command('MAIL FROM:<' + smtp.from + '>' + (size ? ' SIZE=' + message.length : ''), [250], 'message');
        await command('RCPT TO:<' + payload.to + '>', [250, 251], 'message');
        // The durable worker rechecks owner/token/report/lease immediately before
        // DATA. A later revocation cannot recall an already accepted message.
        const eligible = await Promise.race([beforeData(), new Promise(resolve => { if (stopped.signal.aborted) resolve(false); else stopped.signal.addEventListener('abort', () => resolve(false), { once: true }); })]);
        if (aborted && !signal?.aborted) throw new SMTPError('network', 'retry', dataStarted);
        if (!eligible || signal?.aborted) return { outcome: 'canceled', code: 'canceled', uncertain: false };
        await command('DATA', [354], 'message');
        const final = reader.read(); dataStarted = true;
        socket.write(message.toString('ascii').replace(/(^|\r\n)\./g, '$1..') + '.\r\n');
        requireCode(await final, [250], 'message'); accepted = true;
        try { await command('QUIT', [221]); } catch {}
        return { outcome: 'accepted', code: null, uncertain: false };
      } catch (error) {
        if (accepted) return { outcome: 'accepted', code: null, uncertain: false };
        if (signal?.aborted) return { outcome: 'canceled', code: 'canceled', uncertain: dataStarted };
        return { outcome: error instanceof SMTPError ? error.outcome : 'retry', code: dataStarted && (!(error instanceof SMTPError) || error.code === 'network') ? 'uncertain' : error instanceof SMTPError ? error.code : 'network', uncertain: dataStarted && (!(error instanceof SMTPError) || error.code === 'network') };
      } finally {
        clearTimeout(overall); signal?.removeEventListener('abort', stop); socket?.on('error', () => {}); reader?.dispose(); socket?.destroy();
      }
    }
  });
}
