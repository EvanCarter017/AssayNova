import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { ca, cert, key, expiredCert } from './mail-tls-fixtures.mjs';

// All sockets stay on loopback. Transcripts deliberately omit credentials.
export async function fakeSMTP(options = {}) {
  const sockets = new Set(), states = [], messages = [];
  const fixture = options.tlsFixture || { ca, cert, key, expiredCert };
  const context = tls.createSecureContext({ key: fixture.key, cert: options.expired ? fixture.expiredCert : fixture.cert });
  const checks = { auth: false, mailFrom: false, recipient: false };
  const server = net.createServer(plain => {
    sockets.add(plain); plain.on('error', () => {}); plain.on('close', () => sockets.delete(plain));
    let socket = plain, secure = false, buffer = '', data = false, login = 0, loginUsernameMatches = false;
    const matches = (encoded, expected) => Buffer.from(encoded, 'base64').toString('utf8') === expected;
    const reply = value => {
      if (options.fragment && value !== '220 ready') { const bytes = Buffer.from(value + '\r\n'); let index = 0; const part = () => { if (socket.destroyed) return; socket.write(bytes.subarray(index, ++index)); if (index < bytes.length) setImmediate(part); }; part(); }
      else socket.write(value + '\r\n');
    };
    const incoming = chunk => {
      buffer += chunk.toString('ascii');
      for (;;) {
        if (data) {
          if (options.midData && buffer.length) { socket.destroy(); return; }
          const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) { if (options.midData && buffer.length) socket.destroy(); return; }
          messages.push(buffer.slice(0, end + 2).replace(/(^|\r\n)\.\./g, '$1.')); buffer = buffer.slice(end + 5); data = false; states.push('message');
          if (options.lostAck) { socket.destroy(); return; } reply(options.final || '250 accepted'); continue;
        }
        const end = buffer.indexOf('\r\n'); if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const verb = login ? 'AUTH_RESPONSE' : line.split(' ')[0]; states.push((secure ? 'tls:' : 'plain:') + verb);
        if (login) { if (login++ === 1) { loginUsernameMatches = options.expected ? matches(line, options.expected.username) : false; reply('334 UGFzc3dvcmQ6'); } else { if (options.expected) checks.auth = loginUsernameMatches && matches(line, options.expected.password); login = 0; reply(options.authFailure || options.expected && !checks.auth ? '535 rejected' : '235 authenticated'); } }
        else if (verb === 'EHLO') {
          if (options.malformed) { socket.write(options.malformed); continue; }
          reply(secure ? '250-test\r\n250-AUTH ' + (options.login ? 'LOGIN' : 'PLAIN') + '\r\n250 SIZE ' + (options.size || 131072) : '250-test\r\n250 ' + (options.noStartTLS ? 'SIZE 131072' : 'STARTTLS'));
        } else if (verb === 'STARTTLS') {
          if (options.refuseTLS) { reply('454 unavailable'); continue; }
          if (options.extraTLS) { socket.write('220 ready\r\n250 unsolicited\r\n'); continue; }
          reply('220 ready'); plain.off('data', incoming);
          socket = new tls.TLSSocket(plain, { isServer: true, secureContext: context }); secure = true; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.on('data', incoming);
        } else if (verb === 'AUTH') { if (!secure) throw new Error('Client attempted plaintext authentication.'); if (options.login) { login = 1; reply('334 VXNlcm5hbWU6'); } else { if (options.expected) checks.auth = matches(line.slice('AUTH PLAIN '.length), '\0' + options.expected.username + '\0' + options.expected.password); reply(options.authFailure || options.expected && !checks.auth ? '535 rejected' : '235 authenticated'); } }
        else if (verb === 'MAIL') { if (options.expected) checks.mailFrom = line.replace(/ SIZE=\d+$/, '') === 'MAIL FROM:<' + options.expected.from + '>'; reply(options.expected && !checks.mailFrom ? '550 rejected' : '250 sender'); }
        else if (verb === 'RCPT') { if (options.expected) checks.recipient = line === 'RCPT TO:<' + options.expected.to + '>'; reply(options.expected && !checks.recipient ? '550 rejected' : options.recipient || '251 recipient'); }
        else if (verb === 'DATA') { data = true; reply('354 message'); }
        else if (verb === 'QUIT') { if (options.quitLoss) socket.destroy(); else { reply('221 closing'); socket.end(); } }
        else reply('500 unexpected');
      }
    };
    socket.on('data', incoming); if (!options.silent) reply('220 synthetic loopback SMTP');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { states, messages, checks, ca: fixture.ca, dial: () => net.connect({ host: '127.0.0.1', port: server.address().port }), async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }, sockets };
}
