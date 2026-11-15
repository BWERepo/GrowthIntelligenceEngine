// Minimal SMTP sender over a Cloudflare TCP socket, for approved outreach.
// Copied (and trimmed to plain text) from BWE's lead-email-smtp.server.ts so GIE
// sends from the same lead mailbox; BWE stays the source of the credential.
import { connect } from "cloudflare:sockets";

export type MailboxConfig = { host: string; port: number; user: string; pass: string };

/** The lead mailbox, from the same variable names BWE uses. Throws naming the missing one. */
export function mailboxFromEnv(source: Record<string, string | undefined> = process.env): MailboxConfig {
  const host = source.LEAD_EMAIL_SMTP_HOST || "smtp.gmail.com";
  const port = Number(source.LEAD_EMAIL_SMTP_PORT) || 465;
  const user = source.LEAD_EMAIL_SMTP_USER;
  const pass = source.LEAD_EMAIL_SMTP_PASSWORD;
  if (!user) throw new Error("Missing mail setting: LEAD_EMAIL_SMTP_USER.");
  if (!pass) throw new Error("Missing mail setting: LEAD_EMAIL_SMTP_PASSWORD.");
  return { host, port, user, pass };
}

/** The plus-address BWE's email log reads copies from ("+log" production, "+log-staging" staging). */
export function logBccAddress(user: string, gieSchema: string): string {
  const [local = "", domain = ""] = user.split("@");
  const tag = gieSchema === "gie_staging" ? "log-staging" : "log";
  return `${local.split("+")[0] ?? local}+${tag}@${domain}`.toLowerCase();
}

export type OutgoingMail = {
  fromName: string;
  /** Address shown in the From line; the SMTP login stays the envelope sender. Defaults to the login. */
  fromEmail?: string;
  replyTo?: string;
  to: string;
  bcc?: string;
  subject: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. Values must not contain line breaks. */
  headers?: Record<string, string>;
};

const noBreaks = (v: string, what: string) => {
  if (/[\r\n]/.test(v)) throw new Error(`Refusing to send: line break in ${what}.`);
  return v;
};

function base64Body(text: string): string {
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  return (b64.match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/** Subjects with non-ASCII characters are sent as RFC 2047 encoded words. */
function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

export function buildMessage(mail: OutgoingMail, fromEmail: string, messageId: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  const headers = [
    `From: "${noBreaks(mail.fromName, "sender name").replace(/"/g, "'")}" <${noBreaks(mail.fromEmail ?? fromEmail, "from")}>`,
    ...(mail.replyTo ? [`Reply-To: ${noBreaks(mail.replyTo, "reply-to")}`] : []),
    `To: ${noBreaks(mail.to, "recipient")}`,
    `Subject: ${encodeSubject(noBreaks(mail.subject, "subject"))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    ...Object.entries(mail.headers ?? {}).map(([k, v]) => `${k}: ${noBreaks(v, k)}`),
  ];
  return [...headers, "", base64Body(mail.text)].join("\r\n");
}

async function readResponse(reader: ReadableStreamDefaultReader<Uint8Array>, state: { buffer: string }): Promise<{ code: number; text: string }> {
  const decoder = new TextDecoder();
  for (;;) {
    const lines = state.buffer.split("\r\n");
    const complete = lines.slice(0, -1);
    const last = complete[complete.length - 1];
    const match = last ? /^(\d{3})([ -])/.exec(last) : null;
    if (match && match[2] === " ") {
      state.buffer = lines[lines.length - 1] ?? "";
      return { code: Number(match[1]), text: complete.join("\n") };
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("SMTP connection closed unexpectedly.");
    state.buffer += decoder.decode(value, { stream: true });
  }
}

const expect = (r: { code: number; text: string }, code: number, step: string) => {
  // Never echo the server's text for AUTH steps: it can repeat the login.
  if (r.code !== code) throw new Error(`SMTP ${step} failed (${r.code})${step.startsWith("AUTH") ? "" : `: ${r.text.slice(0, 200)}`}`);
};

/** Sends one plain-text message. Returns the Message-ID it used (with angle brackets). */
export async function sendMail(mailbox: MailboxConfig, mail: OutgoingMail): Promise<{ messageId: string }> {
  const fromEmail = mailbox.user;
  const socket = connect({ hostname: mailbox.host, port: mailbox.port }, { secureTransport: "on" });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const state = { buffer: "" };
  const line = (s: string) => writer.write(new TextEncoder().encode(`${s}\r\n`));
  try {
    try {
      await socket.opened;
    } catch (e) {
      throw new Error(`SMTP connection to ${mailbox.host}:${mailbox.port} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    expect(await readResponse(reader, state), 220, "greeting");
    await line(`EHLO ${fromEmail.split("@")[1] || "localhost"}`);
    expect(await readResponse(reader, state), 250, "EHLO");
    await line("AUTH LOGIN");
    expect(await readResponse(reader, state), 334, "AUTH LOGIN");
    await line(Buffer.from(mailbox.user, "utf-8").toString("base64"));
    expect(await readResponse(reader, state), 334, "AUTH username");
    await line(Buffer.from(mailbox.pass, "utf-8").toString("base64"));
    expect(await readResponse(reader, state), 235, "AUTH password");
    await line(`MAIL FROM:<${fromEmail}>`);
    expect(await readResponse(reader, state), 250, "MAIL FROM");
    for (const addr of [mail.to, ...(mail.bcc ? [mail.bcc] : [])]) {
      await line(`RCPT TO:<${noBreaks(addr, "recipient")}>`);
      expect(await readResponse(reader, state), 250, `RCPT TO <${addr}>`);
    }
    await line("DATA");
    expect(await readResponse(reader, state), 354, "DATA");
    const id = crypto.randomUUID();
    await writer.write(new TextEncoder().encode(`${buildMessage(mail, fromEmail, id)}\r\n.\r\n`));
    expect(await readResponse(reader, state), 250, "message body");
    await line("QUIT");
    return { messageId: `<${id}@${fromEmail.split("@")[1] || "localhost"}>` };
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
