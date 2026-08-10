// `pipeline event <event-type|register-mirror-binding|write-liveness|clear-liveness>
//   [--project-root=/abs] [k=v ...]`
//
// Faithful port of writer.py:main's dispatch. ALWAYS returns 0 (never block the
// caller). Subcommand dispatch first (register-mirror-binding / write-liveness /
// clear-liveness), else event-emit.

import {
  emitEvent,
  registerMirrorBinding,
  writeLiveness,
  clearLiveness,
} from '../lib/event';

const USAGE =
  'usage: pipeline event <event-type|register-mirror-binding|write-liveness|clear-liveness> ' +
  '[--project-root=/abs/path] [k=v ...]\n';

export function runEvent(args: string[]): number {
  if (args.length < 1) {
    process.stderr.write(USAGE);
    return 0; // never block caller
  }

  const first = args[0];
  // `--help`/`-h` as the first token is a request for usage, not an event type
  // to journal — without this, `pipeline event --help` used to write a real
  // `--help` event to the journal (emitEvent never validates the type) and
  // print nothing.
  if (first === '--help' || first === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const rest = args.slice(1);

  if (first === 'register-mirror-binding') return registerMirrorBinding(rest);
  if (first === 'write-liveness') return writeLiveness(rest);
  if (first === 'clear-liveness') return clearLiveness(rest);

  // Default: any other first token is the event type.
  return emitEvent(first, rest);
}
