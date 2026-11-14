// robots.txt rules (RFC 9309): groups by user-agent, Allow/Disallow with "*"
// and "$" patterns, longest match wins, Allow wins a tie. Pure.

export const USER_AGENT_TOKEN = "BWEGrowthBot";

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

export type RobotsRules = { groups: Group[] };

export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return { groups };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Whether `pathWithQuery` (e.g. "/contact?x=1") may be fetched by `agent`. */
export function isAllowed(rules: RobotsRules, pathWithQuery: string, agent = USER_AGENT_TOKEN): boolean {
  const name = agent.toLowerCase();
  const specific = rules.groups.filter((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  const applicable = specific.length ? specific : rules.groups.filter((g) => g.agents.includes("*"));
  let best: Rule | null = null;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (!patternToRegExp(rule.pattern).test(pathWithQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * What to do when robots.txt itself could not be read (RFC 9309 section 2.3.1):
 * 4xx means there are no restrictions; a server error or network failure means
 * assume everything is disallowed.
 */
export function robotsUnavailable(status: number | null): RobotsRules {
  if (status !== null && status >= 400 && status < 500) return { groups: [] };
  return { groups: [{ agents: ["*"], rules: [{ allow: false, pattern: "/" }] }] };
}
