import {openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync} from 'node:fs';
import {canonical, ensure} from './contracts.mjs';

// Process-crash protection on a filesystem supporting atomic same-directory rename.
// A leftover candidate is evidence to review, never a reason to reset the ledger.
export function writeLedgerAtomically(path, data) {
  const pending = path + '.new';
  ensure(!existsSync(pending), 'LEDGER_RECOVERY_REQUIRED', 'unreviewed pending ledger exists; do not overwrite or resend');
  const fd = openSync(pending, 'wx');
  try {writeFileSync(fd, canonical(data), 'utf8'); fsyncSync(fd);}
  finally {closeSync(fd);}
  renameSync(pending, path);
}
