/**
 * Trusting the runtime's interception CA, which only exists once intercepted.
 *
 * Intercepting HTTPS means the runtime terminates TLS with its own certificate,
 * and it mounts that CA only after `start()` and the intercept call — so the
 * image's entrypoint runs before there is anything to trust, and this runs from
 * the object instead, once per container. HTTP intercepts need none of it.
 */
export const TRUST_CA_COMMAND = [
  'ls -A /etc/cloudflare/certs 2>&1 || echo "(no /etc/cloudflare/certs)"',
  "CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  'if [ -r "$CA" ]; then',
  // Trailing operators: a newline ends a command in sh, so a leading `&&` on
  // the next line is a syntax error rather than a continuation.
  '  install -m 644 "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt &&',
  "  update-ca-certificates > /dev/null 2>&1 &&",
  '  echo TRUSTED || echo "TRUST FAILED"',
  "else",
  '  echo "NO CA AT $CA"',
  "fi"
].join("\n");
