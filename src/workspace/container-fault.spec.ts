import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import {
  ContainerBackend,
  WorkspaceContainerAPI
} from "@cloudflare/computer/backends/container";
import { freshWorkspace } from "../../test/workspace/do.js";
import { deploymentFault } from "./container-fault.js";

/**
 * Which container failures are the deployment's fault, and which are ordinary.
 *
 * The distinction decides what a caller *says*, never whether it retries —
 * every call site keeps the control flow it had. So the cost of a false
 * positive is an operator sent to redeploy over a container that was only
 * starting, and the cost of a false negative is an hour of logs naming a
 * symptom. Both directions are asserted below.
 *
 * What is being matched is the backend's formatting rather than our own, so a
 * fixture written from memory would pass against a string the library never
 * emits. The ones below are the backend's stage message inside the workspace's
 * reconnect wrapper, with the values a deployment that hit each one saw; the
 * unprepared image is produced by the library itself, further down.
 */

/** A host that reached a container built before the daemon authenticated. */
const AUTH =
  'WorkspaceTransportError: Workspace backend "container-shell": shell.exec ' +
  "failed after 1 reconnect retry: initial=ContainerBackend(container-shell) " +
  "[stage=auth]: container served an unauthenticated request to /api with " +
  "405, so this workspace would run without authorization.; last=" +
  "ContainerBackend(container-shell) [stage=auth]: container served an " +
  "unauthenticated request to /api with 405, so this workspace would run " +
  "without authorization. A container or image predating RPC_CLIENT_SECRET " +
  "has to be recycled.";

/** The same host after the container application was deleted underneath it. */
const NO_APP =
  'WorkspaceTransportError: Workspace backend "container-shell": shell.exec ' +
  "failed after 1 reconnect retry: initial=ContainerBackend(container-shell): " +
  "connect failed at stage=health port=8080 attempt=2/2 restarts=1 " +
  'timeoutMs=30000 priorExit="There is no container application ; last=' +
  "ContainerBackend(container-shell): connect failed at stage=health " +
  "port=8080 attempt=2/2 restarts=1 timeoutMs=30000 priorExit=" +
  '"There is no container application assigned to this Durable Object ' +
  'namespace" lastError=computerd health probe time';

/** A container that was simply not up yet — the case that must stay retryable. */
const STARTING =
  'WorkspaceTransportError: Workspace backend "container-shell": shell.exec ' +
  "failed after 1 reconnect retry: initial=ContainerBackend(container-shell): " +
  "connect failed at stage=health port=8080 attempt=2/2 restarts=1 " +
  "timeoutMs=30000 lastError=computerd health probe timed out; last=" +
  "ContainerBackend(container-shell): connect failed at stage=health " +
  "port=8080 attempt=2/2 restarts=1 timeoutMs=30000 lastError=computerd " +
  "health probe timed out";

/**
 * What a command gets when the Worker prepared `images` and none of them is the
 * one this object starts — none at all, for an application on the platform's
 * scheduling policy.
 *
 * Produced rather than written out: the real backend drives the real container
 * host, inside a real workspace, so the message is the library's own and so is
 * the wrapper around it. The one stand-in is the runtime's container, which the
 * pool cannot supply — and this failure is raised before the container would
 * have been asked for anything.
 */
async function unpreparedImage(
  name: string,
  images: Record<string, string>
): Promise<unknown> {
  return await runInDurableObject(freshWorkspace(name), async (_i, state) => {
    const kept = new Map<string, unknown>();
    const ctx = {
      container: {
        running: false,
        images,
        start: () => {},
        monitor: () => new Promise<void>(() => {}),
        destroy: async () => {}
      },
      storage: {
        get: async (key: string) => kept.get(key),
        put: async (key: string, value: unknown) => void kept.set(key, value),
        delete: async (key: string) => kept.delete(key)
      }
    } as unknown as DurableObjectState;
    const host = new WorkspaceContainerAPI(ctx);
    const workspace = new Workspace({
      storage: state.storage as unknown as DurableObjectStorageLike,
      backends: [
        new ContainerBackend({
          container: () => ({ getWorkspaceContainer: () => host }),
          workspace: { binding: "TEST_WORKSPACE", id: state.id.toString() }
        })
      ]
    });
    await workspace.ready();
    try {
      await (await workspace.runtime.exec("true")).result();
      return undefined;
    } catch (err) {
      return err;
    }
  });
}

describe("when a container failure is classified", () => {
  it("names the image when the container cannot authenticate", () => {
    expect(deploymentFault(new Error(AUTH))?.summary).toContain("image");
  });

  it("names the container application when there is none", () => {
    expect(deploymentFault(new Error(NO_APP))?.summary).toContain(
      "container application"
    );
  });

  it("names the image map when the application prepared none", async () => {
    const err = await unpreparedImage("fault-no-images", {});
    expect(String(err)).toMatch(/no prepared images/);
    expect(deploymentFault(err)?.summary).toContain("image");
  });

  it("names the image map when it lacks the image this object starts", async () => {
    const err = await unpreparedImage("fault-other-image", {
      base: "registry.cloudflare.com/account/base@sha256:0"
    });
    expect(String(err)).toMatch(/prepared images: base/);
    expect(deploymentFault(err)?.summary).toContain("image");
  });

  it("says redeploying is what clears it, in each", async () => {
    // The remedy reaches a model through the install record, so it has to name
    // the act rather than describe the state.
    const unprepared = await unpreparedImage("fault-remedy", {});
    for (const err of [new Error(AUTH), new Error(NO_APP), unprepared])
      expect(deploymentFault(err)?.remedy).toMatch(/redeploy/);
  });

  it("leaves a container that was still starting alone", () => {
    // The guard that keeps every test above from passing against a classifier
    // that answers yes: this message is the same shape, from the same backend,
    // at the same stage, and a retry is exactly what clears it.
    expect(deploymentFault(new Error(STARTING))).toBeUndefined();
  });

  it("leaves an ordinary failure alone", () => {
    expect(deploymentFault(new Error("EEXEC_LOST"))).toBeUndefined();
  });

  it("survives a thrown value that is not an Error", () => {
    // `String(err)` is the only thing read, so nothing here may assume a shape.
    expect(deploymentFault(undefined)).toBeUndefined();
    expect(deploymentFault({ code: "nope" })).toBeUndefined();
  });
});
