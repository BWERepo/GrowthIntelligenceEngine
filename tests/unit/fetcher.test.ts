import { describe, expect, it } from "vitest";
import { createPoliteFetcher } from "@/lib/discovery/fetch.server";

type Handler = (url: string) => Response;
function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const h = routes[url];
    return h ? h(url) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const html = (body: string) => new Response(`<html><head><title>T</title></head><body>${body}</body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const noSleep = async () => {};

describe("polite fetcher", () => {
  it("reads robots.txt first and refuses disallowed pages", async () => {
    const f = fakeFetch({
      "https://biz.com/robots.txt": () => new Response("User-agent: *\nDisallow: /private", { status: 200 }),
      "https://biz.com/private/page": () => html("secret"),
    });
    const r = await createPoliteFetcher(f.fn, noSleep).fetchPage("https://biz.com/private/page");
    expect(r).toMatchObject({ ok: false, reason: "robots" });
    expect(f.calls).toEqual(["https://biz.com/robots.txt"]);
  });

  it("fetches an allowed page and checks robots.txt once per host", async () => {
    const f = fakeFetch({
      "https://biz.com/robots.txt": () => new Response("", { status: 404 }),
      "https://biz.com/a": () => html('<p>Hello A</p><a href="tel:8655550100">call</a>'),
      "https://biz.com/b": () => html("<p>Hello B</p>"),
    });
    const fetcher = createPoliteFetcher(f.fn, noSleep);
    const a = await fetcher.fetchPage("https://biz.com/a");
    await fetcher.fetchPage("https://biz.com/b");
    expect(a.ok && a.text).toContain("Hello A");
    expect(a.ok && a.contact.phones).toEqual(["8655550100"]);
    expect(a.ok && a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.calls.filter((c) => c.endsWith("robots.txt"))).toHaveLength(1);
  });

  it("treats an unreachable robots.txt (server error) as disallow", async () => {
    const f = fakeFetch({ "https://down.com/robots.txt": () => new Response("", { status: 503 }), "https://down.com/": () => html("x") });
    expect(await createPoliteFetcher(f.fn, noSleep).fetchPage("https://down.com/")).toMatchObject({ ok: false, reason: "robots" });
  });

  it("does not follow a redirect to a private address", async () => {
    const f = fakeFetch({
      "https://biz.com/robots.txt": () => new Response("", { status: 404 }),
      "https://biz.com/go": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    });
    expect(await createPoliteFetcher(f.fn, noSleep).fetchPage("https://biz.com/go")).toMatchObject({ ok: false, reason: "not_public" });
    expect(f.calls).not.toContain("http://169.254.169.254/latest/meta-data");
  });

  it("skips files that are not web pages", async () => {
    const f = fakeFetch({
      "https://biz.com/robots.txt": () => new Response("", { status: 404 }),
      "https://biz.com/file": () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    expect(await createPoliteFetcher(f.fn, noSleep).fetchPage("https://biz.com/file")).toMatchObject({ ok: false, reason: "not_html" });
  });
});
