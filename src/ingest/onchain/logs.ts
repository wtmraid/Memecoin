/**
 * Solana program logs are a flat list across nested CPIs. This walks the
 * `invoke [n]` / `success` / `failed` markers so each line can be attributed to the
 * program that actually emitted it — otherwise any program could spoof another's events.
 */
export interface FramedLine {
  programId: string;
  depth: number;
  line: string;
}

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const EXIT = /^Program (\w+) (success|failed)/;

export function frameLogs(logs: string[]): FramedLine[] {
  const stack: string[] = [];
  const out: FramedLine[] = [];
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    const ex = EXIT.exec(line);
    if (ex && stack[stack.length - 1] === ex[1]) {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    if (top) out.push({ programId: top, depth: stack.length, line });
  }
  return out;
}

const DATA_PREFIX = 'Program data: ';

/** Base64 payloads of `Program data:` lines (Anchor `emit!`) emitted by `programId`. */
export function programDataFor(logs: string[], programId: string): Buffer[] {
  const out: Buffer[] = [];
  for (const f of frameLogs(logs)) {
    if (f.programId === programId && f.line.startsWith(DATA_PREFIX)) {
      out.push(Buffer.from(f.line.slice(DATA_PREFIX.length), 'base64'));
    }
  }
  return out;
}

/** True if `programId` itself logged a line matching `marker`. */
export function programLogged(logs: string[], programId: string, marker: RegExp): boolean {
  return frameLogs(logs).some((f) => f.programId === programId && marker.test(f.line));
}
