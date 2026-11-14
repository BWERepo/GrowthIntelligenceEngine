// Read-only IMAP reader for reply detection. A deliberately small client
// (copied in spirit from BWE's email-log-imap.server.ts): EXAMINE only, BODY.PEEK
// only, so nothing is ever marked read, moved or deleted.
import { connect } from "cloudflare:sockets";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type ImapResponse = { text: string; literals: Uint8Array[] };

class ImapConnection {
  private buffer = new Uint8Array(0);
  private tagCount = 0;
  constructor(
    private reader: ReadableStreamDefaultReader<Uint8Array>,
    private writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}
  private async fill() {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new Error("IMAP connection closed unexpectedly.");
    const next = new Uint8Array(this.buffer.length + value.length);
    next.set(this.buffer);
    next.set(value, this.buffer.length);
    this.buffer = next;
  }
  private async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = decoder.decode(this.buffer.subarray(0, i));
          this.buffer = this.buffer.slice(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }
  private async readBytes(count: number) {
    while (this.buffer.length < count) await this.fill();
    const bytes = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return bytes;
  }
  async readResponse(): Promise<ImapResponse> {
    let text = "";
    const literals: Uint8Array[] = [];
    for (;;) {
      const line = await this.readLine();
      text += line;
      const literal = /\{(\d+)\}$/.exec(line);
      if (!literal) return { text, literals };
      literals.push(await this.readBytes(Number(literal[1])));
    }
  }
  async command(command: string, label = command.split(" ")[0]): Promise<ImapResponse[]> {
    const tag = `A${++this.tagCount}`;
    await this.writer.write(encoder.encode(`${tag} ${command}\r\n`));
    const untagged: ImapResponse[] = [];
    for (;;) {
      const response = await this.readResponse();
      if (response.text.startsWith(`${tag} `)) {
        const status = response.text.slice(tag.length + 1);
        // The label, not the command, so a LOGIN failure never echoes the password.
        if (!/^OK\b/i.test(status)) throw new Error(`IMAP ${label} failed: ${status.slice(0, 120)}`);
        return untagged;
      }
      untagged.push(response);
    }
  }
}

const quoted = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

export type FetchedMessage = { messageId: string | null; inReplyTo: string | null; references: string | null; from: string; subject: string; date: Date | null; autoSubmitted: boolean; text: string };

/** Header and first part of the text of one raw message. Pure, so it is unit tested. */
export function parseMessage(headerText: string, bodyText: string): FetchedMessage {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const get = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(unfolded)?.[1]?.trim() ?? null;
  const from = get("From") ?? "";
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const date = get("Date");
  const parsed = date ? new Date(date) : null;
  const auto = get("Auto-Submitted");
  return {
    messageId: get("Message-ID"),
    inReplyTo: get("In-Reply-To"),
    references: get("References"),
    from: address.trim().toLowerCase(),
    subject: get("Subject") ?? "",
    date: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    autoSubmitted: (!!auto && !/^no$/i.test(auto)) || /^(bulk|auto_reply|junk)$/i.test(get("Precedence") ?? ""),
    text: bodyText,
  };
}

/**
 * Finds recent messages in INBOX from any of the given addresses. One search
 * per address (bounded by the caller). Nothing is changed on the server.
 */
export async function findMessagesFrom(
  cfg: { host: string; user: string; pass: string },
  addresses: string[],
  sinceDays: number,
  now = new Date(),
): Promise<FetchedMessage[]> {
  if (addresses.length === 0) return [];
  const socket = connect({ hostname: cfg.host, port: 993 }, { secureTransport: "on" });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const imap = new ImapConnection(reader, writer);
  const found: FetchedMessage[] = [];
  try {
    try {
      await socket.opened;
    } catch (e) {
      throw new Error(`IMAP connection to ${cfg.host} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const greeting = await imap.readResponse();
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text)) throw new Error("IMAP greeting was not OK.");
    await imap.command(`LOGIN ${quoted(cfg.user)} ${quoted(cfg.pass)}`, "LOGIN");
    await imap.command("EXAMINE INBOX");
    const since = imapDate(new Date(now.getTime() - sinceDays * 86_400_000));
    for (const address of addresses) {
      const res = await imap.command(`UID SEARCH SINCE ${since} FROM ${quoted(address)}`);
      const uids = res.flatMap((r) => (/^\* SEARCH\b(.*)$/i.exec(r.text)?.[1] ?? "").trim().split(/\s+/)).filter(Boolean).slice(-10);
      for (const uid of uids) {
        const headers = await imap.command(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES AUTO-SUBMITTED PRECEDENCE)])`);
        const head = headers.find((r) => r.literals.length > 0)?.literals[0];
        const body = await imap.command(`UID FETCH ${uid} (BODY.PEEK[TEXT]<0.2000>)`);
        const text = body.find((r) => r.literals.length > 0)?.literals[0];
        if (head) found.push(parseMessage(decoder.decode(head), text ? decoder.decode(text) : ""));
      }
    }
    await imap.command("LOGOUT").catch(() => {});
    return found;
  } finally {
    for (const close of [() => writer.close(), () => reader.cancel(), () => socket.close()]) {
      try {
        await close();
      } catch {
        /* best-effort teardown */
      }
    }
  }
}
