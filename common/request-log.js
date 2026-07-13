import { promises as fs } from 'fs';
import path from 'path';

// Appends one line per incoming HTTP request and per outbound callback POST to
// a log file. Writes are serialized through a promise chain so concurrent jobs
// never interleave a line, and every call is fire-and-forget: a logging failure
// is reported to the console but never breaks request handling.
export function createRequestLog(logFilePath) {
  let writeChain = Promise.resolve();
  let dirReady = null;

  function append(line) {
    writeChain = writeChain.then(async () => {
      try {
        if (!dirReady) {
          dirReady = fs.mkdir(path.dirname(logFilePath), { recursive: true });
        }
        await dirReady;
        await fs.appendFile(logFilePath, `${line}\n`);
      } catch (err) {
        console.error(`[RequestLogWriteFailed] ${err?.message || err}`);
      }
    });
    return writeChain;
  }

  function stamp(iso, direction, status, detail) {
    return append(`${iso} [${direction}] ${status} ${detail}`);
  }

  // status: numeric HTTP response code; note: optional trailing context.
  function logIncoming(iso, status, method, pathname, note = '') {
    const suffix = note ? ` — ${note}` : '';
    return stamp(iso, 'Incoming', status, `${method} ${pathname}${suffix}`);
  }

  // status: 'ERR' on network failure, otherwise the receiver's HTTP status.
  function logOutgoing(iso, status, url, note = '') {
    const suffix = note ? ` — ${note}` : '';
    return stamp(iso, 'Outgoing', status, `POST ${url}${suffix}`);
  }

  return { logIncoming, logOutgoing };
}
