/**
 * What the container is given instead of a credential.
 *
 * Claude Code does not validate it locally: a run with this exact value
 * succeeds, and the container only ever sends the placeholder. The egress
 * gateway swaps in the real credential on the way out, so a `postinstall` script
 * that dumps the environment learns this and nothing else.
 *
 * Shaped like a real token deliberately: something that looks obviously fake
 * invites a future reader to "fix" it by putting the real one there.
 */
export const CREDENTIAL_PLACEHOLDER = "sk-ant-oat01-" + "0".repeat(24);
