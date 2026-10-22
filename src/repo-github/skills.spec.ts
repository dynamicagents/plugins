import { describe, it, expect } from "vitest";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_SKILLS_LISTED,
  READ_SKILLS,
  readSkillInventory,
  skillInventory,
  skillInventoryText,
  SKILLS_DIR,
  type RepoSkill,
  type ShellAnswer
} from "./skills.js";

/**
 * The skill inventory, in the two halves it is built in: what the container's
 * output means, and what the model is told about it.
 *
 * No container here, for the reason `checkout.spec.ts` has none: the runner is a
 * parameter precisely so the reading is testable without one. What cannot be
 * asserted from here is that the script itself collects what this file assumes,
 * so the stream these cases build is shaped the way `READ_SKILLS` writes one: a
 * directory at column zero, its file's lines indented by one tab, and a blank
 * line closing the record.
 */

/** One skill's record, as {@link READ_SKILLS} writes it. */
function record(dir: string, file: string): string {
  const indented = file
    .split("\n")
    .map((line) => `\t${line}`)
    .join("\n");
  return `${dir}\n${indented}\n\n`;
}

/** A whole stream, from `[directory, file]` pairs. */
function stream(...records: [string, string][]): string {
  return records.map(([dir, file]) => record(dir, file)).join("");
}

const skillsIn = (...records: [string, string][]): RepoSkill[] =>
  readSkillInventory(stream(...records));

const PLAIN = `---
name: wrangler
description: Run or troubleshoot Wrangler CLI commands.
---

# Wrangler`;

describe("reading a skill's frontmatter", () => {
  it("takes the name and the description", () => {
    expect(skillsIn([`${SKILLS_DIR}/wrangler`, PLAIN])).toEqual([
      {
        name: "wrangler",
        description: "Run or troubleshoot Wrangler CLI commands.",
        invocation: "either"
      }
    ]);
  });

  /**
   * The form this workspace's own skills are written in, and the reason this
   * module parses rather than greps: a `grep description:` would carry the first
   * line of one of these and silently drop the rest.
   */
  it("folds a block description onto one line", () => {
    const folded = `---
name: swarm
description: >-
  Dispatches many independent items in parallel: create a table, fan out to
  subagents, aggregate results.

  One row = one unit of work.
---`;
    expect(skillsIn([`${SKILLS_DIR}/swarm`, folded])[0]?.description).toBe(
      "Dispatches many independent items in parallel: create a table, fan out to " +
        "subagents, aggregate results. One row = one unit of work."
    );
  });

  it("folds a literal block the same way", () => {
    const literal = `---
name: two-liner
description: |
  First line.
  Second line.
---`;
    expect(skillsIn([`${SKILLS_DIR}/two-liner`, literal])[0]?.description).toBe(
      "First line. Second line."
    );
  });

  it("takes one pair of quotes off a scalar", () => {
    const quoted = `---
name: "ai-sdk"
description: 'Answer questions about the AI SDK.'
---`;
    expect(skillsIn([`${SKILLS_DIR}/ai-sdk`, quoted])[0]).toEqual({
      name: "ai-sdk",
      description: "Answer questions about the AI SDK.",
      invocation: "either"
    });
  });

  /**
   * The failure this guards is silent and specific: a skill's frontmatter
   * carries nested mappings, and a child key spelled `name` would otherwise
   * rename the skill, so a prompt would name something that does not exist.
   */
  it("reads top-level keys only, so a nested mapping cannot rename a skill", () => {
    const nested = `---
name: swarm
description: Fans work out across rows.
metadata:
  name: not-the-skill
  description: not the description
  entrypoint: scripts/index.ts
---`;
    expect(skillsIn([`${SKILLS_DIR}/swarm`, nested])[0]).toEqual({
      name: "swarm",
      description: "Fans work out across rows.",
      invocation: "either"
    });
  });

  it("falls back to the directory when there is no frontmatter", () => {
    expect(skillsIn([`${SKILLS_DIR}/undocumented`, "# Just a body"])).toEqual([
      { name: "undocumented", invocation: "either" }
    ]);
  });

  /**
   * The bound on the read can cut a block before its closing delimiter. The
   * skill is still there and still nameable, so what arrived is read rather
   * than thrown away.
   */
  it("reads a frontmatter block the read cut short", () => {
    const cut = `---
name: long-one
description: The part that arrived`;
    expect(skillsIn([`${SKILLS_DIR}/long-one`, cut])[0]).toEqual({
      name: "long-one",
      description: "The part that arrived",
      invocation: "either"
    });
  });

  it("keeps a carriage return out of a name", () => {
    const crlf = `---\r\nname: windows-written\r\ndescription: Written on Windows.\r\n---`;
    expect(skillsIn([`${SKILLS_DIR}/windows-written`, crlf])[0]).toEqual({
      name: "windows-written",
      description: "Written on Windows.",
      invocation: "either"
    });
  });

  it("separates skills by the shape of the stream, not by a separator line", () => {
    // A body that contains what a separator would have looked like.
    const body = `---
name: tricky
description: A skill whose body talks about other skills.
---

Some prose mentioning ${SKILLS_DIR}/other and a line of its own.`;
    const skills = skillsIn(
      [`${SKILLS_DIR}/tricky`, body],
      [`${SKILLS_DIR}/other`, PLAIN]
    );
    expect(skills.map((skill) => skill.name)).toEqual(["tricky", "wrangler"]);
  });
});

describe("how a prompt may reach a skill", () => {
  const front = (fields: string) => `---
name: subject
description: A subject.
${fields}
---`;

  it.each([
    ["nothing said", "", "either"],
    ["the model is shut out", "disable-model-invocation: true", "command"],
    ["the command is hidden", "user-invocable: false", "prose"],
    [
      "both",
      "disable-model-invocation: true\nuser-invocable: false",
      "neither"
    ],
    // YAML 1.1 spellings, because that is what an author writes.
    ["yes for true", "disable-model-invocation: yes", "command"],
    ["no for false", "user-invocable: no", "prose"]
  ])("reads %s as %s", (_case, fields, invocation) => {
    expect(skillsIn([`${SKILLS_DIR}/subject`, front(fields)])[0]).toMatchObject(
      { invocation }
    );
  });

  /**
   * A value nothing recognises leaves the field's default rather than guessing,
   * because every guess here takes a way in away from a skill that has it.
   */
  it("leaves both ways open on a value it does not recognise", () => {
    expect(
      skillsIn([
        `${SKILLS_DIR}/subject`,
        front("disable-model-invocation: maybe")
      ])[0]
    ).toMatchObject({ invocation: "either" });
  });
});

describe("the answer the model reads", () => {
  const skill = (name: string, over: Partial<RepoSkill> = {}): RepoSkill => ({
    name,
    description: `What ${name} does.`,
    invocation: "either",
    ...over
  });

  it("lists skills in ordinal order with the three counts", () => {
    const text = skillInventoryText([skill("beta"), skill("alpha")]);
    expect(text.split("\n")).toEqual([
      `Skills under \`${SKILLS_DIR}\` in this checkout:`,
      "- `alpha`: What alpha does.",
      "- `beta`: What beta does.",
      "2 skills, 2 listed, 0 omitted."
    ]);
  });

  it("says a checkout has none, with the counts, rather than saying nothing", () => {
    expect(skillInventoryText([])).toBe(
      `No skills under \`${SKILLS_DIR}\` in this checkout: 0 skills, 0 listed, 0 omitted.`
    );
  });

  it("caps the list and says how many it left out", () => {
    const many = Array.from({ length: MAX_SKILLS_LISTED + 3 }, (_, i) =>
      // Padded so the order is the ordinal one a reader can predict.
      skill(`skill-${String(i).padStart(3, "0")}`)
    );
    const text = skillInventoryText(many);
    const listed = text.split("\n").filter((line) => line.startsWith("- "));

    expect(listed).toHaveLength(MAX_SKILLS_LISTED);
    expect(listed[0]).toContain("skill-000");
    expect(text).toContain(
      `${MAX_SKILLS_LISTED + 3} skills, ${MAX_SKILLS_LISTED} listed, 3 omitted.`
    );
  });

  it("clips a long description at a word", () => {
    const long = `${"word ".repeat(MAX_DESCRIPTION_CHARS).trim()} end`;
    const line = skillInventoryText([
      skill("verbose", { description: long })
    ]).split("\n")[1]!;

    expect(line.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS + 40);
    // A whole word before the ellipsis: a cut mid-word would end "wor…".
    expect(line).toMatch(/word…$/);
  });

  it("names the command form for a skill the model cannot pick up itself", () => {
    expect(
      skillInventoryText([
        skill("security-audit-discovery", { invocation: "command" })
      ])
    ).toContain(
      "- `security-audit-discovery` (name it as `/security-audit-discovery`): "
    );
  });

  it.each([
    ["prose", "name it in prose; it has no `/` form"],
    ["neither", "no prompt can invoke it"]
  ])("says how a %s skill is reached", (invocation, note) => {
    expect(
      skillInventoryText([
        skill("subject", { invocation: invocation as RepoSkill["invocation"] })
      ])
    ).toContain(note);
  });

  it("leaves the description off a skill that has none", () => {
    expect(
      skillInventoryText([{ name: "bare", invocation: "either" }])
    ).toContain("- `bare`\n");
  });
});

describe("reading the checkout", () => {
  const answer = (over: Partial<ShellAnswer> = {}): ShellAnswer => ({
    success: true,
    stdout: "",
    stderr: "",
    ...over
  });

  it("runs the read in the checkout and renders what it found", async () => {
    const calls: { script: string; cwd: string }[] = [];
    const text = await skillInventory(async (script, cwd) => {
      calls.push({ script, cwd });
      return answer({ stdout: stream([`${SKILLS_DIR}/wrangler`, PLAIN]) });
    }, "/workspace/r");

    expect(calls).toEqual([{ script: READ_SKILLS, cwd: "/workspace/r" }]);
    expect(text).toContain("- `wrangler`: Run or troubleshoot");
  });

  /**
   * The clone this is appended to succeeded. A failed read is worth a line and
   * never an error, which would send the model to investigate git.
   */
  it("reports a failed read rather than raising it", async () => {
    const text = await skillInventory(
      async () => answer({ success: false, stderr: "head: not found" }),
      "/workspace/r"
    );

    expect(text).toBe(
      `The skills under \`${SKILLS_DIR}\` in this checkout could not be read: head: not found`
    );
  });

  it("says what it can when a failed read said nothing", async () => {
    const text = await skillInventory(
      async () => answer({ success: false }),
      "/workspace/r"
    );

    expect(text).toContain("could not be read: the read failed");
  });
});
