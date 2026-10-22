/**
 * What skills a checkout carries, and how a prompt may reach each one.
 *
 * A Claude Code session reads the skills of the repository it is running in, and
 * the agent that briefs that session has no other way to learn they are there:
 * the session is a separate process with a context of its own, so a skill it
 * should follow has to be named in the prompt it is given. This is what lets
 * `repo_clone` answer with the list.
 *
 * **Why it is here rather than in the plugin that owns a session.** This package
 * fails any subpath whose module graph reaches a sibling's, so the plugin that
 * holds the checkout is the only one that can read it. What belongs to the
 * session's own domain is the *policy*, which is to say when a skill should be
 * named, and that stays with the host writing the prompt. This module reports
 * what is in the checkout and what each skill's own frontmatter says about
 * reaching it.
 *
 * The split inside the module is the one {@link file://./checkout.ts checkout.ts}
 * uses: a runner arrives as a parameter and everything that reads is pure, so
 * the parsing and the rendering are tested without a container.
 */

/** Where Claude Code reads a project's skills from, relative to the checkout. */
export const SKILLS_DIR = ".claude/skills";

/**
 * How much of each `SKILL.md` is collected: whole lines first, then a byte
 * ceiling on them.
 *
 * Frontmatter is at the top of the file and a skill body runs to tens of
 * kilobytes, so a bound is what keeps a directory of dozens of skills to a read
 * worth making. Both are measured rather than guessed: the longest frontmatter
 * in this workspace is 15 lines and 938 bytes, so each bound is more than twice
 * the observed worst case. A block longer than either loses its closing
 * delimiter, and {@link readSkillInventory} reads what arrived rather than
 * dropping the skill.
 *
 * Neither bound is where frontmatter *ends*: that is
 * {@link readFrontmatter}'s, and the one place it is decided. These stop the
 * read from carrying a whole skill body along with it.
 *
 * **Lines are cut before bytes**, because a byte ceiling stops mid-line and a
 * last line with no newline on it puts the next record's name onto the end of
 * another skill's prose. Cutting lines first leaves that reachable only by a
 * file whose top is one enormous line, which {@link READ_SKILLS} closes from
 * the other side.
 */
const SKILL_HEAD_LINES = 40;
const SKILL_HEAD_BYTES = 2_000;

/**
 * How many skills the answer lists, and how long a description it carries.
 *
 * Both bound an answer the model pays for on every clone, and neither is a
 * judgement about which skills matter. They are set against a real checkout
 * rather than guessed: this workspace's own set of skills renders whole at these
 * values, in roughly seven kilobytes, inside the sixteen thousand characters
 * `maxOutputChars` defaults to. A cap tight enough to bite would drop skills in
 * ordinal order, and the one dropped could be the one somebody has to name,
 * which is the failure these numbers are chosen to stay clear of.
 *
 * A description here is a line that helps decide whether to open the skill, not
 * a substitute for reading it.
 *
 * Exported for the specs, which assert the bound rather than restate the
 * number. Nothing outside this package reads them: `./index.ts` is what the
 * subpath publishes, and it exports neither.
 */
export const MAX_SKILLS_LISTED = 40;
export const MAX_DESCRIPTION_CHARS = 200;

/**
 * What one command this module runs answers with. A structural subset of
 * `context.ts`'s `RunResult` rather than an import of it, so the dependency runs
 * one way: the tools know about this file, and this file knows only the shape of
 * an answer.
 */
export interface ShellAnswer {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** The runner {@link skillInventory} borrows from `repoContext`. */
export type ShellRunner = (script: string, cwd: string) => Promise<ShellAnswer>;

/**
 * Collect the head of every skill's `SKILL.md`, each file's lines indented by
 * one tab under the line naming its directory.
 *
 * **The tab is what makes the stream unambiguous.** A line at column zero names
 * a skill's directory and every line of that skill's file is indented by one, so
 * nothing in a file can be read as the start of another record. The obvious
 * alternative, a separator line of its own, is a string a folded description
 * could legally contain, and the failure would be a skill silently merged into
 * its neighbour.
 *
 * It reads through whatever `.claude/skills/<name>` is. A checkout may commit
 * each entry as a symlink to a directory it keeps elsewhere, which is how this
 * workspace holds its own, and `head` follows one.
 *
 * A glob that matches nothing stays literal in a POSIX shell, so the `-f` test
 * is what makes an absent `.claude/skills` an empty answer rather than an error.
 *
 * **The newline after each file is not tidiness.** A byte ceiling can leave a
 * last line with no newline on it, and then the next `printf` writes that
 * skill's directory onto the end of the previous skill's prose: one record lost,
 * one name unreadable, and nothing failing. The `printf` guarantees that a name
 * always starts a line, whatever the file above it ended with.
 *
 * `tab` is spelled through `printf` because `sed`'s own `\t` is GNU's and not
 * POSIX's, and a published package does not get to assume a host's image. No
 * model input reaches any of it: every path is this module's own constant.
 */
export const READ_SKILLS = `tab="$(printf '\\t')"
for d in ${SKILLS_DIR}/*/; do
  [ -f "$d/SKILL.md" ] || continue
  printf '%s\\n' "\${d%/}"
  head -n ${SKILL_HEAD_LINES} "$d/SKILL.md" | head -c ${SKILL_HEAD_BYTES} | sed "s/^/$tab/"
  printf '\\n'
done`;

/**
 * How a prompt may reach a skill, as its frontmatter decides.
 *
 * The distinction is not cosmetic, and it is the reason this module reports more
 * than a name and a description. `disable-model-invocation` takes the skill away
 * from the model's own skill tool, which leaves naming it as `/<name>` the only
 * way in; `user-invocable: false` removes that command, which leaves prose. A
 * host that cannot tell the two apart writes a prompt that silently does
 * nothing.
 */
export type SkillInvocation = "either" | "command" | "prose" | "neither";

/** One skill a checkout carries. */
export interface RepoSkill {
  /** What a prompt names it by: its frontmatter `name`, else its directory. */
  name: string;
  description?: string;
  invocation: SkillInvocation;
}

/**
 * The skills in a checkout, as a sentence the model reads, or why they could not
 * be read.
 *
 * A failed read is reported and never raised: the clone it is appended to
 * succeeded, and a missing inventory is worth a line rather than an error that
 * sends the model to investigate git.
 */
export async function skillInventory(
  shell: ShellRunner,
  dir: string
): Promise<string> {
  const read = await shell(READ_SKILLS, dir);
  if (!read.success) {
    return (
      `The skills under \`${SKILLS_DIR}\` in this checkout could not be read: ` +
      `${read.stderr.trim() || read.stdout.trim() || "the read failed"}`
    );
  }
  return skillInventoryText(readSkillInventory(read.stdout));
}

/**
 * {@link READ_SKILLS}'s output, read back.
 *
 * Unindented lines name directories and indented ones belong to the file above
 * them, so the shape of the stream is what separates the records. A blank
 * unindented line is the trailing newline of the stream, never the end of a
 * record.
 */
export function readSkillInventory(stdout: string): RepoSkill[] {
  const skills: RepoSkill[] = [];
  let dir: string | undefined;
  let head: string[] = [];
  const flush = (): void => {
    if (dir !== undefined) skills.push(skillOf(dir, head));
    head = [];
  };
  for (const raw of stdout.split("\n")) {
    // A checkout written on Windows is still a checkout, and a stray `\r` would
    // otherwise end up inside a name.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("\t")) {
      head.push(line.slice(1));
      continue;
    }
    if (line.trim() === "") continue;
    flush();
    dir = line.trim();
  }
  flush();
  return skills;
}

/** One skill, from its directory and the head of its `SKILL.md`. */
function skillOf(dir: string, head: readonly string[]): RepoSkill {
  const front = readFrontmatter(head);
  const described = front.description?.trim();
  return {
    // The directory is the fallback because it is what Claude Code falls back
    // to: a file whose frontmatter did not parse is still a skill, reachable
    // under the name of the directory holding it.
    name: front.name?.trim() || directoryName(dir),
    ...(described ? { description: described } : {}),
    invocation: invocationOf(front)
  };
}

function directoryName(dir: string): string {
  const at = dir.lastIndexOf("/");
  return at < 0 ? dir : dir.slice(at + 1);
}

/** What the two invocation fields leave open. See {@link SkillInvocation}. */
function invocationOf(front: Record<string, string>): SkillInvocation {
  const model = !isTrue(front["disable-model-invocation"]);
  const person = !isFalse(front["user-invocable"]);
  if (model && person) return "either";
  if (person) return "command";
  if (model) return "prose";
  return "neither";
}

/**
 * The YAML 1.1 spellings of a boolean, because that is what a frontmatter author
 * writes. Anything else reads as absent, which leaves the field's default: a
 * skill is model-invocable and user-invocable unless it says otherwise, so an
 * unreadable value never takes a way in away.
 */
const TRUE = /^(?:true|yes|on)$/i;
const FALSE = /^(?:false|no|off)$/i;

const isTrue = (value: string | undefined): boolean =>
  value !== undefined && TRUE.test(value.trim());

const isFalse = (value: string | undefined): boolean =>
  value !== undefined && FALSE.test(value.trim());

/** The frontmatter delimiter, opening and closing. */
const DELIMITER = /^---\s*$/;

/** A value that says the scalar is the indented block below it. */
const BLOCK = /^[>|][-+]?\s*$/;

/**
 * The frontmatter block's **top-level** keys.
 *
 * Top-level is the load-bearing word. A skill's frontmatter carries nested
 * mappings (`metadata:` with children under it), and a child spelled `name:`
 * would otherwise overwrite the skill's own. Reading column zero only is what
 * keeps a nested key out, and it costs nothing: every field this module wants is
 * at the top level.
 *
 * Not a YAML implementation, and deliberately narrow. Quotes are stripped as a
 * pair and nothing inside them is unescaped, and a trailing `#` is left alone,
 * because a description legitimately contains both and guessing wrong silently
 * corrupts the text the model reads.
 */
function readFrontmatter(head: readonly string[]): Record<string, string> {
  const front: Record<string, string> = {};
  let at = head.findIndex((line) => line.trim() !== "");
  if (at < 0 || !DELIMITER.test(head[at]!)) return front;
  for (at += 1; at < head.length; at += 1) {
    const line = head[at]!;
    if (DELIMITER.test(line)) break;
    // Indented or blank: a nested key, a block scalar's own lines when one was
    // not consumed below, or spacing. None of them is a field.
    if (line.trim() === "" || /^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (BLOCK.test(value)) {
      const block = readBlock(head, at + 1);
      front[key] = block.text;
      at = block.next - 1;
      continue;
    }
    front[key] = unquote(value);
  }
  return front;
}

/**
 * A block scalar's lines, folded to one.
 *
 * Every block form is folded the same way, `|` included, and that is a
 * simplification rather than an oversight: the answer carries one clipped line
 * per skill, so a literal block's newlines are removed by the clip a moment
 * later. Reading this as YAML's folding rules would be reading it as more than
 * it is.
 */
function readBlock(
  head: readonly string[],
  from: number
): { text: string; next: number } {
  const lines: string[] = [];
  let at = from;
  for (; at < head.length; at += 1) {
    const line = head[at]!;
    if (DELIMITER.test(line)) break;
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    if (line.trim() !== "") lines.push(line.trim());
  }
  return { text: lines.join(" "), next: at };
}

/** A scalar with one matching pair of quotes taken off. */
function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value[0]!);
  return quoted ? value.slice(1, -1) : value;
}

/**
 * The inventory as the model reads it: where this looked, a line per skill, and
 * what the list left out.
 *
 * **The counts are unconditional**, the empty answer included. "No skills here"
 * and "this tool does not report skills" are different facts, and a repository
 * that keeps its skills somewhere Claude Code does not read them is the case
 * that makes the difference worth a sentence.
 */
export function skillInventoryText(skills: readonly RepoSkill[]): string {
  // Ordinal, and not a ranking: nothing here knows which skill matters to the
  // task, so the order is the one a reader can predict.
  const sorted = [...skills].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  const listed = sorted.slice(0, MAX_SKILLS_LISTED);
  const counts =
    `${skills.length} ${skills.length === 1 ? "skill" : "skills"}, ` +
    `${listed.length} listed, ${skills.length - listed.length} omitted.`;
  if (listed.length === 0) {
    return `No skills under \`${SKILLS_DIR}\` in this checkout: ${counts}`;
  }
  return [
    `Skills under \`${SKILLS_DIR}\` in this checkout:`,
    ...listed.map(skillLine),
    counts
  ].join("\n");
}

function skillLine(skill: RepoSkill): string {
  const note = {
    either: "",
    command: ` (name it as \`/${skill.name}\`)`,
    prose: " (name it in prose; it has no `/` form)",
    neither: " (no prompt can invoke it)"
  }[skill.invocation];
  const described = skill.description ? `: ${clip(skill.description)}` : "";
  return `- \`${skill.name}\`${note}${described}`;
}

/** One line of description, cut at a word rather than mid-word. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_DESCRIPTION_CHARS) return flat;
  const cut = flat.slice(0, MAX_DESCRIPTION_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}
