import type { Workspace } from "@cloudflare/computer";

/**
 * The identity a commit made in this container carries when nothing nearer
 * answers for it.
 *
 * `/repo` configures the checkouts it clones and names the identity on every
 * commit it makes — see {@link file://../../repo/checkout.ts writeGitIdentity}.
 * Neither reaches a repository the container made for itself: a submodule
 * checked out by a bootstrap, a `git init`, a second clone from the shell. Those
 * have no identity at all, and git refuses to commit without one — so whatever
 * is driving the shell has to invent a name to get past the refusal, and that
 * invention is what ends up in the history.
 *
 * This is the layer underneath, so there is nothing to invent: every repository
 * in the container starts out attributed to the deployment.
 *
 * **System scope, not global.** `--global` writes `$HOME/.gitconfig`, and a
 * command run through the runtime cannot count on `HOME` being set to anything
 * in particular — nor is the identity a property of one user of the container.
 * `--system` is also the *lowest* precedence git has, which is the right place
 * for it: a checkout's own config still wins, and so does the environment
 * `/repo` and the session's launch put on a commit.
 */

/** Written to `/etc/gitconfig`; the values arrive as variables, never inline. */
export const GIT_IDENTITY_COMMAND = [
  'git config --system user.name "$GIT_NAME"',
  'git config --system user.email "$GIT_EMAIL"',
  "echo IDENTITY OK"
].join(" && ");

/** How long the write may take before it is not going to happen. */
const IDENTITY_TIMEOUT_MS = 30_000;

export interface ContainerGitIdentityDeps {
  workspace: () => Workspace;
  author: () => { name: string; email: string };
  /** Log prefix and object id, for the one line an operator can see. */
  tag: () => string;
  id: () => string;
}

/**
 * The write above, once per container.
 *
 * In memory, with {@link file://./ca-trust.ts}'s lifetime and for its reason: it
 * describes one container, and an isolate that lost it re-runs an idempotent
 * command.
 */
export class ContainerGitIdentity {
  #done = false;

  constructor(private readonly deps: ContainerGitIdentityDeps) {}

  forget(): void {
    this.#done = false;
  }

  /**
   * Configure this container if it has not been configured yet.
   *
   * **Never throws**, like the CA install and unlike the dependency setup. What
   * a failure costs is an attribution, and every later commit says plainly that
   * it has no identity to use — where a throw here would fail a workspace that
   * is otherwise entirely usable.
   */
  async ensure(): Promise<void> {
    if (this.#done) return;
    const author = this.deps.author();
    try {
      using handle = await this.deps
        .workspace()
        .runtime.exec(GIT_IDENTITY_COMMAND, {
          cwd: "/",
          encoding: "utf8",
          timeoutMs: IDENTITY_TIMEOUT_MS,
          env: { GIT_NAME: author.name, GIT_EMAIL: author.email }
        });
      const result = await handle.result();
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      this.#done = result.exitCode === 0 && output.includes("IDENTITY OK");
      if (this.#done) return;
      console.warn(
        `[${this.deps.tag()}] could not set the container's git identity`,
        {
          id: this.deps.id(),
          output: output.trim()
        }
      );
    } catch (err) {
      console.warn(
        `[${this.deps.tag()}] could not set the container's git identity`,
        {
          id: this.deps.id(),
          err: String(err)
        }
      );
    }
  }
}
