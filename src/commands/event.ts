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

export function runEvent(args: string[]): number {
  if (args.length < 1) {
    process.stderr.write(
      'usage: pipeline event <event-type|register-mirror-binding|write-liveness|clear-liveness> ' +
        '[--project-root=/abs/path] [k=v ...]\n',
    );
    return 0; // never block caller
  }

  const first = args[0];
  const rest = args.slice(1);

  if (first === 'register-mirror-binding') return registerMirrorBinding(rest);
  if (first === 'write-liveness') return writeLiveness(rest);
  if (first === 'clear-liveness') return clearLiveness(rest);

  // Default: any other first token is the event type.
  return emitEvent(first, rest);
}
