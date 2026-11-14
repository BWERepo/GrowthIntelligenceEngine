// Builds BWE's own unsubscribe link: the same signed token BWE's /unsubscribe page
// verifies, so a click lands on BWE's global suppression list. Needs the same
// UNSUBSCRIBE_SECRET as BWE. (Copied from BWE's unsubscribe.server.ts.)
function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function unsubscribeUrl(secret: string | undefined, baseUrl: string, email: string): Promise<string> {
  if (!secret) throw new Error("Missing setting: UNSUBSCRIBE_SECRET (must equal BWE's), so no unsubscribe link can be made.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ e: email.trim().toLowerCase(), v: 1 })));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${baseUrl.replace(/\/$/, "")}/unsubscribe?t=${encodeURIComponent(`${payload}.${b64url(sig)}`)}`;
}
