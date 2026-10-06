import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { GITHUB_PAGE_SIZE } from "./context.js";
import type { RepoContext } from "./context.js";

/** A pull request's CI: what has run on its head commit, and how it ended. */

/** One check, wherever GitHub reported it from. */
interface Check {
  name: string;
  outcome: "pending" | "failed" | "passed";
  /** What it ended as, for a failure: `failure`, `timed_out`, `error`… */
  detail?: string;
  url?: string;
}

/** A check run's conclusion that is not a failure. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  details_url?: string;
}

interface CommitStatus {
  context?: string;
  state?: string;
  target_url?: string | null;
}

/**
 * Both of GitHub's CI APIs, because a repository may report through either:
 * Actions and apps through check runs, older integrations through statuses.
 */
function readChecks(runs: CheckRun[], statuses: CommitStatus[]): Check[] {
  const fromRuns = runs.map((run): Check => {
    const name = run.name ?? "(unnamed check)";
    const url = run.html_url ?? run.details_url;
    if (run.status !== "completed")
      return { name, outcome: "pending", ...(url ? { url } : {}) };
    const conclusion = run.conclusion ?? "unknown";
    return PASSING_CONCLUSIONS.has(conclusion)
      ? { name, outcome: "passed" }
      : {
          name,
          outcome: "failed",
          detail: conclusion,
          ...(url ? { url } : {})
        };
  });
  const fromStatuses = statuses.map((status): Check => {
    const name = status.context ?? "(unnamed status)";
    const url = status.target_url ?? undefined;
    switch (status.state) {
      case "success":
        return { name, outcome: "passed" };
      case "pending":
        return { name, outcome: "pending", ...(url ? { url } : {}) };
      default:
        return {
          name,
          outcome: "failed",
          detail: status.state ?? "unknown",
          ...(url ? { url } : {})
        };
    }
  });
  return [...fromRuns, ...fromStatuses];
}

function listed(checks: Check[]): string {
  return checks
    .map(
      (c) =>
        `- ${c.name}${c.detail ? ` (${c.detail})` : ""}${c.url ? ` ${c.url}` : ""}`
    )
    .join("\n");
}

export function checkTools(ctx: RepoContext): ToolSet {
  const { bounded, github, githubRepo } = ctx;

  return {
    repo_pr_checks: tool({
      description:
        "Say how a pull request's checks stand on its latest commit — CI that is still running, failed or passed — in the repository you have checked out. Use it to know whether CI has finished and what failed, without waiting inside a session for it.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number")
      }),
      execute: async ({ dir, number }) => {
        const target = await githubRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        const pr = await github(
          "repo_pr_checks",
          `/repos/${owner}/${repo}/pulls/${number}`
        );
        if (!pr.ok) return bounded(pr.message);
        const sha = (pr.data as { head?: { sha?: string } }).head?.sha;
        if (!sha) return `#${number} is not a pull request in ${owner}/${repo}`;
        const short = sha.slice(0, 7);

        const runs = await github(
          "repo_pr_checks",
          `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=${GITHUB_PAGE_SIZE}`
        );
        if (!runs.ok) return bounded(runs.message);
        // The combined status holds the latest per context, so one page is
        // every context there is.
        const statuses = await github(
          "repo_pr_checks",
          `/repos/${owner}/${repo}/commits/${sha}/status?per_page=${GITHUB_PAGE_SIZE}`
        );
        if (!statuses.ok) return bounded(statuses.message);

        const runData = runs.data as {
          total_count?: number;
          check_runs?: CheckRun[];
        };
        const statusData = statuses.data as {
          total_count?: number;
          statuses?: CommitStatus[];
        };
        const checks = readChecks(
          runData.check_runs ?? [],
          statusData.statuses ?? []
        );
        if (checks.length === 0) {
          return (
            `No checks have reported on #${number}'s latest commit (${short}). ` +
            "CI that runs on pushes registers within a minute or so of one; " +
            "after that, this repository runs none for this pull request."
          );
        }

        const failed = checks.filter((c) => c.outcome === "failed");
        const pending = checks.filter((c) => c.outcome === "pending");
        const passed = checks.length - failed.length - pending.length;
        // Either API can run past a page, and what is past it may be the one
        // failure, so an unread page is never "all passed".
        const unread = [
          [runData.total_count ?? 0, "check runs"],
          [statusData.total_count ?? 0, "commit statuses"]
        ]
          .filter(([total]) => (total as number) > GITHUB_PAGE_SIZE)
          .map(
            ([total, what]) =>
              `Only the first ${GITHUB_PAGE_SIZE} of ${total} ${what} were read.`
          );
        const truncated = unread.length > 0;

        return bounded(
          [
            `Checks on #${number} at ${short}: ${failed.length} failed, ` +
              `${pending.length} still running, ${passed} passed.`,
            ...(failed.length ? ["", "Failed:", listed(failed)] : []),
            ...(pending.length ? ["", "Still running:", listed(pending)] : []),
            ...(truncated ? ["", ...unread] : []),
            ...(!failed.length && !pending.length && !truncated
              ? ["", "Every check has finished and passed."]
              : [])
          ].join("\n")
        );
      }
    })
  };
}
