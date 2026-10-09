/**
 * Pure license-expression classification used by scripts/check-licenses.mjs.
 *
 * Kept separate from the CLI so the policy decisions can be unit tested without scanning
 * node_modules. Behaviour is deliberately conservative: an expression passes only when every
 * SPDX token in it is reviewed (OR is treated like AND), `WITH` exceptions are only accepted when
 * the full expression is listed in the policy, and any reference-only token fails the package.
 */
export function createLicenseClassifier(policy) {
  const allowed = new Set(policy.allowed ?? []);
  const allowedWithNotice = new Set(policy.allowedWithNotice ?? []);
  const referenceOnly = new Set(policy.referenceOnly ?? []);

  function splitExpression(expression) {
    if (
      allowed.has(expression) ||
      allowedWithNotice.has(expression) ||
      referenceOnly.has(expression)
    ) {
      return [expression];
    }

    if (/\bWITH\b/i.test(expression)) {
      return [expression];
    }

    return expression
      .replace(/[()]/g, " ")
      .split(/\s+(?:OR|AND)\s+/i)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  function classify(expression) {
    const tokens = splitExpression(expression);

    if (tokens.some((token) => referenceOnly.has(token))) {
      return { ok: false, reason: "reference-only", tokens, notice: false };
    }

    if (
      tokens.length > 0 &&
      tokens.every((token) => allowed.has(token) || allowedWithNotice.has(token))
    ) {
      return {
        ok: true,
        reason: "allowed",
        tokens,
        notice: tokens.some((token) => allowedWithNotice.has(token)),
      };
    }

    return { ok: false, reason: "unreviewed", tokens, notice: false };
  }

  return { splitExpression, classify };
}
