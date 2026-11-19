import { describe, expect, it } from "vitest";
import { facebookPageUrl, findOwnWebsite, hostMatchesName, nameTokens, snippetText } from "@/lib/discovery/facebook";
import { candidatesFromResults, excludedHost } from "@/lib/discovery/queries";
import { buildUserPrompt } from "@/lib/discovery/classification";

const r = (url: string, snippet: string | null = "Plumbing in Knoxville, TN. Call us.") => ({ url, title: "Smoky Mountain Plumbing | Knoxville TN", snippet, publishedAt: null });

describe("Facebook-only prospects", () => {
  it("recognizes a business's own Facebook page and nothing else", () => {
    expect(facebookPageUrl("https://www.facebook.com/SmokyMtnPlumbing/")).toBe("https://facebook.com/SmokyMtnPlumbing");
    expect(facebookPageUrl("https://m.facebook.com/SmokyMtnPlumbing?ref=x")).toBe("https://facebook.com/SmokyMtnPlumbing");
    expect(facebookPageUrl("https://www.facebook.com/p/Smoky-Plumbing-100063/")).toBe("https://facebook.com/p/Smoky-Plumbing-100063");
    for (const u of [
      "https://www.facebook.com/groups/knoxville",
      "https://www.facebook.com/events/123",
      "https://www.facebook.com/SmokyMtnPlumbing/posts/456",
      "https://www.facebook.com/profile.php?id=1",
      "https://www.facebook.com/marketplace",
      "https://smokyplumbing.com/",
    ]) expect(facebookPageUrl(u)).toBeNull();
  });

  it("keeps Facebook pages only for prospecting searches, and only with a snippet", () => {
    const results = [r("https://www.facebook.com/SmokyMtnPlumbing"), r("https://www.facebook.com/NoSnippetBiz", null), r("https://www.facebook.com/groups/x"), r("https://smithdental.com/")];
    expect(candidatesFromResults(results).map((c) => c.normalizedUrl)).toEqual(["https://smithdental.com"]);
    const withFb = candidatesFromResults(results, { facebookPages: true });
    expect(withFb.map((c) => c.normalizedUrl)).toEqual(["https://facebook.com/SmokyMtnPlumbing", "https://smithdental.com"]);
    expect(withFb[0]!.publishedAt).toBeNull();
  });

  it("uses the search title and snippet as the only text", () => {
    expect(snippetText({ title: "A", snippet: "B" })).toBe("A\nB");
    expect(snippetText({ title: "A", snippet: null })).toBeNull();
    const prompt = buildUserPrompt({ signalType: "prospecting", industries: [], locations: [] }, { url: "https://facebook.com/x", title: "A", text: "A\nB" }, { searchSnippet: true });
    expect(prompt).toMatch(/page itself was not opened/);
    expect(buildUserPrompt({ signalType: "prospecting", industries: [], locations: [] }, { url: "https://x.com", title: "A", text: "B" })).not.toMatch(/not opened/);
  });

  it("matches a website to the business name loosely", () => {
    expect(nameTokens("Smoky Mountain Plumbing, LLC")).toEqual(["smoky", "mountain", "plumbing"]);
    expect(hostMatchesName("smokymountainplumbing.com", "Smoky Mountain Plumbing LLC")).toBe(true);
    expect(hostMatchesName("mountain-plumbing-knox.net", "Smoky Mountain Plumbing")).toBe(true);
    expect(hostMatchesName("yellowpages.com", "Smoky Mountain Plumbing")).toBe(false);
    expect(hostMatchesName("knoxvilleplumbers.com", "Smoky Mountain Plumbing")).toBe(false);
    expect(hostMatchesName("bellasalon.com", "Bella's")).toBe(true);
    expect(hostMatchesName("joe.com", "Joe")).toBe(false);
  });

  it("finds an own website among search results, skipping Facebook and excluded sites", () => {
    const res = [r("https://www.facebook.com/SmokyMountainPlumbing"), r("https://www.yelp.com/biz/smoky-mountain-plumbing"), r("https://www.smokymountainplumbing.com/")];
    expect(findOwnWebsite(res, "Smoky Mountain Plumbing", excludedHost)).toBe("https://www.smokymountainplumbing.com/");
    expect(findOwnWebsite(res.slice(0, 2), "Smoky Mountain Plumbing", excludedHost)).toBeNull();
  });
});
