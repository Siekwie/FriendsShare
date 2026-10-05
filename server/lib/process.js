// What happens when something goes wrong that nobody planned for. Kept apart from server.js so that
// it can be tried with a stand-in for the process.

// What a failure looks like in the log. Whatever the failure carries may have come from a stranger
// (an error message that repeats what was sent), so it cannot end a line and start another that
// looks like ours, and it cannot carry terminal control codes.
function describe(reason) {
  let text;
  try {
    text = reason instanceof Error ? reason.stack || reason.message || String(reason) : String(reason);
  } catch {
    text = 'something that cannot be printed';
  }
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?')
    .replace(/\n/g, '\n  ');
}

function installProcessHandlers(proc, { log, exit }) {
  // A promise that nobody waits for failed. That is a bug worth a line in the log, but not a reason
  // to cut off everybody who is connected.
  proc.on('unhandledRejection', (reason) => {
    try {
      log(`[process] unhandled rejection: ${describe(reason)}`);
    } catch {}
  });
  // An error nothing caught: what state the program is in is unknown now. Say so, and stop, so that
  // whatever supervises it (Docker's restart policy) starts it afresh and cleanly.
  proc.on('uncaughtException', (err) => {
    try {
      log(`[process] uncaught exception: ${describe(err)}`);
    } catch {}
    exit(1);
  });
}

module.exports = { installProcessHandlers, describe };
