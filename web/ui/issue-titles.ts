// Issue titles for the bounty cards. The contract stores only the repository and the issue
// number, so the page reads each title from GitHub in the visitor's own browser (their own rate
// limit, not the server's) and keeps it for a day. A title is display only: nothing is decided
// from it, and a missing one falls back to "owner/repo#12".
import { useEffect, useState } from "react";
import { cleanTitle } from "./github-issue.ts";

const KEY = "proven:issue-titles";
const TTL_MS = 24 * 60 * 60 * 1000;
type Cache = Record<string, { title: string; at: number }>;

const ref = (repo: string, issue: number) => `${repo}#${issue}`;

function readCache(): Cache {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Cache) : {};
  } catch {
    return {};
  }
}
function writeCache(cache: Cache) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Private windows and full storage: titles are simply read again next time.
  }
}

/** Reads one title. Null when GitHub cannot say (rate limit, private repository, network). */
export async function fetchTitle(
  repo: string,
  issue: number,
  transport: typeof fetch = fetch,
): Promise<string | null> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  try {
    const reply = await transport(
      `https://api.github.com/repos/${repo}/issues/${issue}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!reply.ok) return null;
    const body = (await reply.json()) as { title?: unknown };
    return typeof body.title === "string" ? cleanTitle(body.title) : null;
  } catch {
    return null;
  }
}

/** Titles keyed by "owner/repo#12" for the given issues, filled in as they arrive. */
export function useIssueTitles(issues: { repo: string; issue: number }[]) {
  const [titles, setTitles] = useState<Record<string, string>>(() => {
    const cache = readCache();
    return Object.fromEntries(
      Object.entries(cache).map(([k, v]) => [k, v.title]),
    );
  });
  const wanted = [...new Set(issues.map((i) => ref(i.repo, i.issue)))].join(
    ",",
  );
  useEffect(() => {
    let live = true;
    const cache = readCache();
    const due = issues.filter((i) => {
      const hit = cache[ref(i.repo, i.issue)];
      return !hit || Date.now() - hit.at > TTL_MS;
    });
    void (async () => {
      for (const i of due) {
        const title = await fetchTitle(i.repo, i.issue);
        if (!live || title === null) continue;
        cache[ref(i.repo, i.issue)] = { title, at: Date.now() };
        writeCache(cache);
        setTitles((t) => ({ ...t, [ref(i.repo, i.issue)]: title }));
      }
    })();
    return () => {
      live = false;
    };
    // The list of wanted issues is the dependency, not the array's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return (repo: string, issue: number) => titles[ref(repo, issue)];
}
