import { describe, expect, it } from "vitest";
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
 * The messages are verbatim from a deployment that hit each one, because what is
 * being matched is the backend's formatting rather than our own — a fixture
 * written from memory would pass against a string the library never emits.
 */

/** A host that reached a container built before the daemon authenticated. */
const AUTH =
  'WorkspaceTransportError: Workspace backend "container-shell": shell.exec ' +
  "failed after 1 reconnect retry: initial=CloudflareContainerBackend" +
  "(container-shell) [stage=auth]: container served an unauthenticated request " +
  "to /api with 405, so this workspace would run without auth; last=" +
  "CloudflareContainerBackend(container-shell) [stage=auth]: container served " +
  "an unauthenticated request to /api with 405, so this workspace would run " +
  "without authorization. A container or image predating RPC_CLIENT_SECRET has " +
  "to be recycled.";

/** The same host after the container application was deleted underneath it. */
const NO_APP =
  'WorkspaceTransportError: Workspace backend "container-shell": shell.exec ' +
  "failed after 1 reconnect retry: initial=CloudflareContainerBackend" +
  "(container-shell): connect failed at stage=health port=8080 attempt=2/2 " +
  'restarts=1 timeoutMs=30000 priorExit="There is no container application ' +
  'assigned to this Durable Object namespace" lastError=computerd health probe ' +
  "timed out";

/** A container that was simply not up yet — the case that must stay retryable. */
const STARTING =
  'WorkspaceTransportError: Workspace backend "container-shell": shell.exec ' +
  "failed after 1 reconnect retry: initial=CloudflareContainerBackend" +
  "(container-shell): connect failed at stage=health port=8080 attempt=2/2 " +
  "restarts=1 timeoutMs=30000 lastError=computerd health probe timed out";

describe("when a container failure is classified", () => {
  it("names the image when the container cannot authenticate", () => {
    expect(deploymentFault(new Error(AUTH))?.summary).toContain("image");
  });

  it("names the container application when there is none", () => {
    expect(deploymentFault(new Error(NO_APP))?.summary).toContain(
      "container application"
    );
  });

  it("says redeploying is what clears it, in both", () => {
    // The remedy reaches a model through the install record, so it has to name
    // the act rather than describe the state.
    for (const message of [AUTH, NO_APP])
      expect(deploymentFault(new Error(message))?.remedy).toMatch(/redeploy/);
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
