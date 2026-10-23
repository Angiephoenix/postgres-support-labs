import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { LedgerError } from './contracts.ts';
import { runGuided } from './guided.ts';

export async function guidedTerminal() {
  if (!stdin.isTTY || !stdout.isTTY) throw new LedgerError('Guided mode needs an interactive terminal. Use the JSON commands for scripts.');
  let muted = false, closed = false;
  const abort = new AbortController();
  // Keep unvalidated input out of terminal scrollback, including rejected secrets.
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) stdout.write(chunk); done(); } });
  const rl = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  rl.on('close', () => { closed = true; abort.abort(); });
  rl.on('SIGINT', () => { abort.abort(); rl.close(); });
  try {
    stdout.write('Input is hidden while typing. Validated intake and review text will be shown before saving.\n');
    await runGuided({
      say(text) { stdout.write(text + '\n'); },
      async ask(prompt) {
        if (closed) return null;
        muted = false;
        const pending = rl.question(prompt, { signal: abort.signal });
        muted = true;
        try { return await pending; }
        catch (error) { if (abort.signal.aborted) return null; throw error; }
        finally { muted = false; stdout.write('\n'); }
      },
    });
  } finally { muted = false; rl.close(); output.end(); }
}
