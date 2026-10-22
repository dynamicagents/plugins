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

/**
 * Where Claude Code reads a project's skills from, relative to the checkout.
 *
 * One level of it: `<dir>/<name>/SKILL.md` and no deeper, which is the layout a
 * session loads. A skill a repository keeps somewhere else of its own is not
 * collected and is not reported as missing either, because nothing here can tell
 * such a directory from any other.
 */
export const SKILLS_DIR = ".claude/skills";

/**
 * The backstop on each `SKILL.md` read: a byte ceiling, and a line count on what
 * is left after it.
 *
 * Neither is where frontmatter *ends*. {@link READ_SKILLS} stops at the closing
 * delimiter, which is the one place that decides it, and these stop a file
 * carrying no such delimiter from sending a whole skill body through the read:
 * frontmatter is at the top of a file and a body runs to tens of kilobytes, so
 * without them a directory of dozens of skills is not a read worth making.
 *
 * They are a backstop rather than a limit because a bound that cuts real
 * frontmatter costs more than a long read does: a field nobody saw is a field
 * {@link invocationOf} cannot report, and a restriction sits wherever in the
 * block its author put it, which in the prompt-only skill this was written
 * against is below a description of several lines. The longest frontmatter in
 * this workspace is 15 lines and 938 bytes, its description 831 characters of
 * that, and these bounds are several times both.
 *
 * Stopping at the delimiter is most of what the read costs, too: this
 * workspace's own set of skills arrives in 9,936 bytes, where a bounded head of
 * every file carries a page of each body along with it and costs five times
 * that.
 *
 * **Bytes are cut by `head` and lines by `awk`**, each by the tool that can do it
 * without holding the file: `head -c` is what keeps a file whose top is one
 * enormous line out of `awk`'s `$0`, and `awk` prints whole lines, so what `head`
 * cut mid-line is still a line of its own in the stream.
 */
const SKILL_HEAD_BYTES = 4_000;
const SKILL_HEAD_LINES = 120;

/**
 * How many skills the answer lists, and how long a description it carries.
 *
 * Both bound an answer the model pays for on every clone, and neither is a
 * judgement about which skills matter. They are set against a real checkout
 * rather than guessed: this workspace's own set of skills renders whole at these
 * values, in 5,731 characters, inside the sixteen thousand `maxOutputChars`
 * defaults to. A cap tight enough to bite would drop skills in ordinal order,
 * and the one dropped could be the one somebody has to name, which is the
 * failure these numbers are chosen to stay clear of.
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
 * What one command this module runs answers with.
 *
 * A structural subset of `context.ts`'s `RunResult`, for the reason
 * {@link file://./checkout.ts GitAnswer} is the home of: the dependency runs one
 * way, so the tools know about this file and this file knows only the shape of
 * an answer. Narrower than that one by `unreachable`, which nothing here reads:
 * a read that never ran and a read that ran and failed cost the same line.
 */
export interface ShellAnswer {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** The runner {@link skillInventory} borrows from `repoContext`. */
export type ShellRunner = (script: string, cwd: string) => Promise<ShellAnswer>;

/**
 * Collect every skill's frontmatter block, each file's lines indented by one tab
 * under the line naming its directory.
 *
 * **The tab is what makes the stream unambiguous.** A line at column zero names
 * a skill's directory and every line of that skill's file is indented by one, so
 * nothing in a file can be read as the start of another record. The obvious
 * alternative, a separator line of its own, is a string a folded description
 * could legally contain, and the failure would be a skill silently merged into
 * its neighbour. It is written by `awk`'s own string escape, which is portable
 * where `sed`'s `\t` is GNU's, and a published package does not get to assume a
 * host's image.
 *
 * **`awk` stops at the closing delimiter**, so what arrives is the whole block
 * and not a guess at how long one is. {@link readFrontmatter} reports a block
 * that arrived without it, and {@link invocationOf} is why that matters: a
 * restriction sits in whichever line of the block its author put it on, so a
 * read that stops early is a read that cannot speak for the skill. The `NR == 1`
 * test is the other half of the saving: a file with no block at all costs one
 * line rather than the bound.
 *
 * **A file this cannot read costs its own record and no other.** The loop's exit
 * status is the last `printf`'s, so a failed read leaves the directory line with
 * nothing indented under it, which {@link readFrontmatter} reads as a block
 * nobody has seen. Failing the whole read instead would spend every other
 * skill's inventory on one unreadable file.
 *
 * It reads through whatever `<dir>/<name>` is. A checkout may commit each entry
 * as a symlink to a directory it keeps elsewhere, which is how this workspace
 * holds its own, and the glob and `head` both follow one.
 *
 * A glob that matches nothing stays literal in a POSIX shell, so the `-f` test
 * is what makes an absent `.claude/skills` an empty answer rather than an error.
 *
 * The blank line after each record is the stream's own shape rather than a
 * property of the tool above it: a name starts a line whatever the file below it
 * ended with. No model input reaches any of this; every path is this module's
 * own constant.
 */
export const READ_SKILLS = `for d in ${SKILLS_DIR}/*/; do
  [ -f "$d/SKILL.md" ] || continue
  printf '%s\\n' "\${d%/}"
  head -c ${SKILL_HEAD_BYTES} "$d/SKILL.md" | awk -v lines=${SKILL_HEAD_LINES} '
    { print "\\t" $0 }
    NR == 1 { if ($0 !~ /^---[[:space:]]*$/) exit; next }
    /^---[[:space:]]*$/ { exit }
    NR >= lines { exit }
  '
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
 *
 * `unknown` is the one that is not a reading of the frontmatter but a statement
 * about the read: the block did not arrive whole, so the fields that decide this
 * are fields nobody has seen. It is reported rather than guessed because both
 * guesses are wrong in a case that happens. The permissive one advertises a
 * prompt-only skill as one a model picks up by itself, which is the silent
 * failure above; the strict one takes a way in away from a skill that has it.
 */
export type SkillInvocation =
  "either" | "command" | "prose" | "neither" | "unknown";

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
    // Clipped the way a description is, and for the same reason: this is one
    // line of an answer about a clone that worked. What `context.ts` hands a
    // tool for a command that never ran is a paragraph on whether retrying a
    // lost `git push` is safe, which is the right thing to tell a model whose
    // push vanished and the wrong thing to attach to a checkout that is on disk.
    const why = read.stderr.trim() || read.stdout.trim();
    return (
      `The skills under \`${SKILLS_DIR}\` in this checkout could not be read: ` +
      `${why ? clip(why) : "the read failed"}`
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
 *
 * **A record starts only on a path under {@link SKILLS_DIR}**, which is the one
 * thing the indentation alone does not settle. Directory names come from a
 * cloned repository, and one carrying a newline writes a second line at column
 * zero: without the path, that line opens a record of its own and the skill
 * above it loses the frontmatter that follows to a name nobody wrote. A
 * directory name holds no `/`, so what the second line cannot be is a path,
 * which is what closes it.
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
    if (!line.startsWith(`${SKILLS_DIR}/`)) continue;
    flush();
    dir = line.trim();
  }
  flush();
  return skills;
}

/** One skill, from its directory and the head of its `SKILL.md`. */
function skillOf(dir: string, head: readonly string[]): RepoSkill {
  const front = readFrontmatter(head);
  const described = front.fields.description?.trim();
  return {
    // The directory is the fallback because it is the only name left: a block
    // that did not parse, or did not arrive at all, still leaves a directory
    // with a `SKILL.md` in it, and a reader given its name can go and look.
    name: front.fields.name?.trim() || directoryName(dir),
    ...(described ? { description: described } : {}),
    invocation: invocationOf(front)
  };
}

function directoryName(dir: string): string {
  const at = dir.lastIndexOf("/");
  return at < 0 ? dir : dir.slice(at + 1);
}

/** What the two invocation fields leave open. See {@link SkillInvocation}. */
function invocationOf(front: Frontmatter): SkillInvocation {
  // A block that did not arrive whole is a block whose remaining fields nobody
  // has seen, and an absent field is a default only among fields that were
  // read. A restriction sits wherever in the block its author put it, below the
  // description as often as above it, so reading the defaults here would let
  // the length of a skill's prose decide whether its restriction is reported.
  if (!front.whole) return "unknown";
  const model = !isTrue(front.fields["disable-model-invocation"]);
  const person = !isFalse(front.fields["user-invocable"]);
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

/**
 * A value that says the scalar is the lines below it: a block indicator, or
 * nothing at all. An empty value is the plain multi-line form,
 * `description:` with its text indented under it, and it folds the same way.
 */
const BLOCK = /^(?:[>|][-+]?\s*)?$/;

/** What {@link readFrontmatter} read, and whether that was the whole block. */
interface Frontmatter {
  fields: Record<string, string>;
  /**
   * False when nothing arrived, and when the head ran out before the closing
   * delimiter. {@link invocationOf} is what turns on it: among fields that were
   * read, an absent one is a default; among fields nobody saw, it is unknown.
   */
  whole: boolean;
}

/**
 * The frontmatter block's **top-level** keys.
 *
 * Top-level is the load-bearing word. A skill's frontmatter carries nested
 * mappings (`metadata:` with children under it), and a child spelled `name:`
 * would otherwise overwrite the skill's own. Reading column zero only is what
 * keeps a nested key out, and it costs nothing: every field this module wants is
 * at the top level.
 *
 * Not a YAML implementation, and deliberately narrow: nothing inside quotes is
 * unescaped, and every block form folds to one line. What it does carry is the
 * YAML that changes an answer here, which is {@link commentOff}'s.
 */
function readFrontmatter(head: readonly string[]): Frontmatter {
  const fields: Record<string, string> = {};
  // Nothing arrived at all, which is what a `SKILL.md` the read could not open
  // looks like from here: the directory was named and no line followed it.
  if (head.length === 0) return { fields, whole: false };
  let at = head.findIndex((line) => line.trim() !== "");
  // No block to read. Nothing was cut short either, so what the fields below
  // default to is a reading of this file rather than a guess about it.
  if (at < 0 || !DELIMITER.test(head[at]!)) return { fields, whole: true };
  for (at += 1; at < head.length; at += 1) {
    const line = head[at]!;
    if (DELIMITER.test(line)) return { fields, whole: true };
    // Indented or blank: a nested key, a block scalar's own lines when one was
    // not consumed below, or spacing. A whole-line comment is not a field
    // either, and reading one as a key is how a commented-out field comes back.
    if (line.trim() === "" || /^[\s#]/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = commentOff(line.slice(colon + 1).trim());
    if (BLOCK.test(value)) {
      const block = readBlock(head, at + 1);
      fields[key] = block.text;
      at = block.next - 1;
      continue;
    }
    fields[key] = unquote(value);
  }
  return { fields, whole: false };
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

/**
 * Where a YAML comment starts in a plain scalar: a `#` at the value's start, or
 * one with whitespace in front of it. Nowhere else, which is what keeps `C#` and
 * `#tag` inside a value.
 */
const COMMENT = /(?:^|\s)#/;

/** What may follow a quoted scalar's closing quote, and all that may. */
const AFTER_QUOTE = /^\s+#/;

/**
 * One scalar's text with a YAML comment taken off, quotes left as they are.
 *
 * Both halves of YAML's rule change an answer here.
 * `disable-model-invocation: true # named from the prompt` is a restriction
 * whose value is not the string `true`, so left whole it reads as a spelling
 * nothing recognises and hands the skill back the way in it just gave up; and
 * `name: audit # the command` would otherwise be offered as `/audit # the
 * command`. Inside quotes nothing starts a comment, and a description carries a
 * hash legitimately, so a quoted value is read to its closing quote and only a
 * comment may follow it.
 *
 * A plain value that loses text to a ` #` has lost it in Claude Code's reading
 * of the same file, which is the test for whether cutting it is right: this
 * module reads a field the way the parser that acts on it does, or it reports
 * something nobody wrote.
 */
function commentOff(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.lastIndexOf(quote);
    // A scalar whose quote closes, with nothing after it or a comment. Anything
    // else never was a quoted scalar, and is left to `unquote` to read as it
    // stands.
    if (close > 0 && AFTER_QUOTE.test(value.slice(close + 1)))
      return value.slice(0, close + 1);
    return value;
  }
  const at = value.search(COMMENT);
  return at < 0 ? value : value.slice(0, at).trimEnd();
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
    neither: " (no prompt can invoke it)",
    unknown: " (how to reach it is unknown: its frontmatter did not read whole)"
  }[skill.invocation];
  const described = skill.description ? `: ${clip(skill.description)}` : "";
  return `- \`${skill.name}\`${note}${described}`;
}

/**
 * One line, cut at a word rather than mid-word.
 *
 * The bound is a description's, and a failed read's reason takes the same one:
 * both are one line of an answer whose subject is the clone.
 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_DESCRIPTION_CHARS) return flat;
  const cut = flat.slice(0, MAX_DESCRIPTION_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}
