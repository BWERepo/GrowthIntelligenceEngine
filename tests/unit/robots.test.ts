import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, robotsUnavailable } from "@/lib/discovery/robots";

describe("robots.txt", () => {
  const rules = parseRobots(`
# comment
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.php$

User-agent: BWEGrowthBot
User-agent: OtherBot
Disallow: /no-bwe/
`);
  it("uses the group that names our bot instead of the * group", () => {
    expect(isAllowed(rules, "/no-bwe/page")).toBe(false);
    expect(isAllowed(rules, "/private/x")).toBe(true); // our group does not disallow it
    expect(isAllowed(rules, "/private/x", "SomeoneElse")).toBe(false);
  });
  it("longest match wins, Allow wins a tie, * and $ work", () => {
    expect(isAllowed(rules, "/private/public-page", "SomeoneElse")).toBe(true);
    expect(isAllowed(rules, "/index.php", "SomeoneElse")).toBe(false);
    expect(isAllowed(rules, "/index.php?x=1", "SomeoneElse")).toBe(true);
  });
  it("an empty Disallow allows everything", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/anything")).toBe(true);
  });
  it("a missing robots.txt (4xx) allows; a server error or network failure disallows", () => {
    expect(isAllowed(robotsUnavailable(404), "/x")).toBe(true);
    expect(isAllowed(robotsUnavailable(503), "/x")).toBe(false);
    expect(isAllowed(robotsUnavailable(null), "/x")).toBe(false);
  });
});
