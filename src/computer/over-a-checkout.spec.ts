import { describe, it, expect } from "vitest";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { openWorkspaceFs } from "../workspace/open.js";
import { computer, computerWorkspace, type ComputerConfig } from "./index.js";
import { workspaceNamespace } from "../../test/workspace/do.js";
import { testPluginContext } from "../../test/helpers.js";

/**
 * Think's file tools over a real workspace object.
 *
 * `read`, `write` and `delete` are Think's, reaching the container's tree
 * through `computerWorkspace`; `grep`, `find`, `list` and `edit` are this
 * plugin's. The tree is checkout-sized, with a `.git` beside the source that
 * the walks prune — the fixture the migration's cost measurement ran on.
 */
describe("the file tools over a checkout", () => {
  const root = "/workspace/app";
  const line = (i: number) => `export const value${i} = ${i}; // padding\n`;
  const body = (i: number) =>
    Array.from({ length: 60 }, (_, k) => line(i * 100 + k)).join("");

  const run = (tool: unknown, input: unknown) =>
    (tool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
      input,
      { toolCallId: "t", messages: [] }
    );

  it("serves Think's tools and ours from the durable tree", async () => {
    // Named here rather than by `freshWorkspace`, which makes its name unique:
    // the workspace reaches the object by name, as an agent's would.
    const name = `think-tools-${crypto.randomUUID()}`;
    const stub = workspaceNamespace.get(workspaceNamespace.idFromName(name));
    {
      using ws = await openWorkspaceFs(stub);
      await ws.fs.mkdir(`${root}/.git/objects`, { recursive: true });
      for (let d = 0; d < 40; d++)
        await ws.fs.mkdir(`${root}/src/m${d}`, { recursive: true });
      for (let i = 0; i < 1_200; i++)
        await ws.fs.writeFile(`${root}/src/m${i % 40}/f${i}.ts`, body(i));
      for (let i = 0; i < 3_000; i++)
        await ws.fs.writeFile(`${root}/.git/objects/${i}`, "blob");
    }

    const config: ComputerConfig = {
      binding: workspaceNamespace as unknown as ComputerConfig["binding"],
      workspaceName: () => name
    };
    const workspace = computerWorkspace(config);
    const think = createWorkspaceTools(workspace, { bash: false });
    const ours = computer(config).tools!(
      testPluginContext({ workspace: () => workspace })
    );
    const file = `${root}/src/m7/f7.ts`;

    const read = (await run(think.read, { path: file })) as {
      totalLines: number;
    };
    expect(read.totalLines).toBe(61);

    await run(think.write, {
      path: `${root}/src/new/a.ts`,
      content: body(9_999)
    });
    expect(await workspace.readFile(`${root}/src/new/a.ts`)).toBe(body(9_999));

    await run(think.edit, {
      path: file,
      old_string: "value700 = 700",
      new_string: "value700 = -1"
    });
    expect(
      await run(ours.edit, {
        path: file,
        old_string: "value701 = 701",
        new_string: "value701 = -1"
      })
    ).toBe(`edited ${file}`);
    expect(await workspace.readFile(file)).toContain("value700 = -1");
    expect(await workspace.readFile(file)).toContain("value701 = -1");

    expect(
      await run(ours.grep, { query: "value119959 =", path: `${root}/src` })
    ).toContain("f1199.ts");

    // Think's `find`, over the workspace's `glob`, which prunes `.git`.
    const found = (await run(think.find, {
      pattern: `${root}/**/f11*.ts`
    })) as { files: string[] };
    expect(found.files).toContain(`${root}/src/m30/f1150.ts`);
    expect(found.files.some((f) => f.includes(".git"))).toBe(false);

    const listed = (await run(think.list, { path: `${root}/src` })) as {
      entries: string[];
    };
    expect(listed.entries).toContain("m7/");

    await run(think.delete, { path: `${root}/src/new/a.ts` });
    expect(await workspace.stat(`${root}/src/new/a.ts`)).toBeNull();
  }, 60_000);
});
