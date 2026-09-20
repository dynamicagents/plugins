import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { parseRepo, repoLocation, UNSAFE_BRANCH } from "./url.js";
import { refreshCheckout, writeGitIdentity } from "./checkout.js";
import type { RepoContext } from "./context.js";

/** Putting a checkout on disk, fresh or refreshed. */
export function cloneTools(ctx: RepoContext): ToolSet {
  const {
    config,
    workdir,
    author,
    allowedHosts,
    bounded,
    notifyCheckout,
    logFailure,
    plain,
    runGit,
    fetchOrigin
  } = ctx;

  return {
    repo_clone: tool({
      description:
        "Clone a git repository into the workspace. Returns the checkout path and the branch you landed on. If the repository is already checked out from an earlier task, it is fetched and reset to the remote instead — unless it has uncommitted changes, which are left alone for you to inspect.",
      inputSchema: z.object({
        url: z.string().describe("HTTPS repository URL"),
        branch: z
          .string()
          .optional()
          .describe("Branch to check out (default: the repo's default)"),
        depth: z
          .number()
          .optional()
          .describe(
            "Shallow-clone depth. Omit for full history; needed if you must rebase."
          )
      }),
      execute: async ({ url, branch, depth }) => {
        // The gate, before anything runs. `url` is model input, and a clone is
        // the one command that hands a credential to a host it names.
        const location = repoLocation(url);
        if (!location || !allowedHosts.includes(location.host)) {
          return (
            `refusing to clone from "${location?.host ?? url}" — this agent may ` +
            `only clone over https from: ${allowedHosts.join(", ")}`
          );
        }
        // Everything past this point travels the canonical form, so what the
        // host clones, what lands in `.git/config`, and what `afterCheckout`
        // records are one string. Refusals above still quote what the model
        // actually sent.
        const { host, url: target } = location;

        // Refused rather than worked around. A URL that passes the host check
        // but names no repository is what a model copies out of a browser —
        // `.../tree/main`, `.../pull/4` — and carrying on means cloning without
        // telling `beforeCheckout` which repository this is, so a host keying its
        // filesystem per repository never switches and the checkout lands in
        // whichever workspace was already open.
        //
        // Not silently trimmed to the first two segments either, tempting as it
        // is: that reads `.../orgs/x/repositories` as the repository `x`, and
        // quietly reinterpreting the target is the wrong instinct for the one
        // tool that offers a credential to a host on the model's say-so. A
        // refusal costs one turn and says exactly what to send instead.
        const parsed = parseRepo(target, allowedHosts);
        if (!parsed) {
          return (
            `refusing to clone "${url}" — it does not name a repository. ` +
            `A clone URL is https://<host>/<owner>/<repo>, so if this came out of ` +
            `a browser, drop everything after the repository name (the /tree/…, ` +
            `/pull/… or /blob/… part) and try again.`
          );
        }

        // The same guard `repo_push` applies, at the second door a branch name
        // enters by. `refreshCheckout` runs `git checkout "$REPO_BRANCH"`, and
        // quoting stops word-splitting but *not* option parsing: a `branch` of
        // `--detach` arrives as an option, git detaches HEAD, the `reset` that
        // follows fails against `origin/--detach`, and the checkout a later task
        // inherits has moved for reasons nothing reported.
        //
        // Checked here rather than in `refreshCheckout` because this is where
        // model input arrives and where the message can say what to send instead.
        // It also covers the fresh-clone path, where the name reaches
        // isomorphic-git as a ref: no argv there, so no option to parse, but an
        // unresolvable ref is a worse error than this sentence.
        if (branch !== undefined && UNSAFE_BRANCH.test(branch))
          return `"${branch}" is not a plain branch name — use something like "main"`;

        const dir = `${workdir}/${parsed.repo}`;

        // Before anything runs, and before `dir` is touched: a host keying its
        // filesystem per repository needs to have switched by now. See
        // `beforeCheckout` for why this cannot wait for the clone to finish.
        //
        // A throw here stops the clone, which is the exact opposite of how
        // `afterCheckout` is treated — and the asymmetry is the point rather than
        // an inconsistency. This hook *chooses the workspace*; carrying on past a
        // failed one would put the checkout wherever the last task left the
        // selection, which is the failure the hook exists to prevent. By the time
        // `afterCheckout` runs there is a checkout on disk and the model needs to
        // be told about it, so that one is caught and logged.
        try {
          config.beforeCheckout?.({
            url: target,
            host,
            owner: parsed.owner,
            repo: parsed.repo
          });
        } catch (err) {
          console.error("[repo] beforeCheckout failed", {
            url,
            repo: `${parsed.owner}/${parsed.repo}`,
            err: String(err)
          });
          return (
            `could not select a workspace for ${parsed.owner}/${parsed.repo}: ` +
            `${String(err)}\nNothing was cloned — going ahead would have put the ` +
            `checkout in whichever workspace was already open.`
          );
        }

        // The workspace outlives the task, so this path may already hold the
        // checkout a previous task left — see `refreshCheckout`.
        const existing = await plain("rev-parse --git-dir", dir);
        // A failed probe means "nothing here, clone it" — but only when git
        // answered. A command that never ran means nothing, and the distinction
        // is not academic: a replaced container is precisely the case where this
        // call fails and the *next* one lands on a working replacement. Read as
        // "empty", it points `git clone` at a directory that already holds the
        // checkout — which fails with `destination path already exists` and skips
        // the refresh that was the right answer all along.
        if (existing.unreachable)
          return bounded(`could not clone ${url}: ${existing.stderr}`);
        if (existing.success) {
          const refreshed = await refreshCheckout({
            dir,
            url: target,
            branch,
            author,
            plain,
            fetchOrigin
          });
          if (refreshed.branch) {
            await notifyCheckout({
              dir,
              url: target,
              host,
              repo: `${parsed.owner}/${parsed.repo}`,
              branch: refreshed.branch,
              fresh: false
            });
          }
          return refreshed.message;
        }

        // `depth` is bounded here rather than trusted from the schema. It no
        // longer reaches a shell, so this is arithmetic rather than quoting: a
        // fractional or negative depth is not something to hand to git.
        const result = await runGit(() =>
          config.git.clone({
            url: target,
            dir,
            allowedHosts,
            ...(branch ? { branch } : {}),
            ...(depth ? { depth: Math.max(1, Math.floor(depth)) } : {})
          })
        );
        if (!result.success) {
          logFailure("repo_clone", result);
          return bounded(`clone failed: ${result.stderr || result.stdout}`);
        }

        // Identity has to exist before the first commit. Written through the
        // container, and deliberately: the commits it names are made there, by
        // `repo_commit`, with no credential in sight — only the three operations
        // that talk to the forge moved.
        //
        // Why a refresh rewrites it, and what answers for a repository this
        // plugin never cloned, is on
        // {@link file://./checkout.ts writeGitIdentity}.
        await writeGitIdentity(plain, dir, author);

        // Two gits now share one `.git`, and this is where they could disagree.
        //
        // The container's git and the host's isomorphic-git read and write the
        // same index. isomorphic-git understands version 2 and the extensions
        // git writes for its own caches are not part of that contract, so a
        // repository that picked up an untracked cache or a split index — from a
        // `feature.manyFiles` default, or a user config in some future image —
        // would be written by one and misread by the other. Pinned at clone
        // time, repo-locally, where it costs three commands and cannot surprise
        // anyone later.
        //
        // Unchecked deliberately, like the upstream-tracking pair in
        // `repo_push`: git's own defaults are already these values, so a failure
        // here means the config could not be written at all, which the very next
        // command will say far more clearly than this one could.
        await plain(`config index.version 2`, dir);
        await plain(`config core.untrackedCache false`, dir);
        await plain(`config core.splitIndex false`, dir);

        // The clone reports the branch it landed on, so nothing has to ask git
        // afterwards — and a failed question would fire `afterCheckout` with no
        // branch at all, starting an install against a checkout nobody can name.
        const landed = result.stdout.trim() || branch;
        if (!landed) {
          logFailure("repo_clone", result);
          return bounded(
            `cloned to ${dir}, but could not read which branch it landed on`
          );
        }
        await notifyCheckout({
          dir,
          url: target,
          host,
          repo: `${parsed.owner}/${parsed.repo}`,
          branch: landed,
          fresh: true
        });
        return `cloned to ${dir} on branch ${landed}`;
      }
    })
  };
}
