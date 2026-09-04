/**
 * The PURE half of SECRET input (브라우저 입력) — the decisions and the wording
 * that stand between a stored credential and a page's input field.
 *
 * The model never sees the value: it names a secret, the server resolves it, and
 * `background.js` types it. That means the only thing standing between a
 * prompt-injected "log in here" and the user's password is the POLICY that rides
 * with the value (`{ name, hosts, passwordOnly }`), re-checked HERE, at the
 * keyboard, and never only on the server — a guardrail on the far side of the
 * wire is not a guardrail (background.js's invariant 2).
 *
 * Kept apart from background.js for the same reason `axtree.js` is: everything
 * here is a function of its arguments, so `tests/browser-secret-input.test.ts`
 * can pin the rules that decide whether a credential is typed at all.
 *
 * TWO absolute rules shape every line below, and both exist because a leak here
 * is silent and permanent:
 *
 *   1. NOTHING in this file ever receives, holds, quotes, or returns the secret
 *      VALUE. Refusals and notes take a LENGTH and a NAME. The measured Chromium
 *      fact that makes length enough is in `tests/visual/password-facts.spec.ts`:
 *      a password field's accessibility value reads back as one `•` per
 *      character, so a length comparison verifies the write without the value
 *      ever being comparable as a string.
 *   2. Everything here is model-facing text, so it is ENGLISH (the language split
 *      in the root CLAUDE.md) and it says what to do NEXT — a refusal an agent
 *      cannot act on becomes a retry loop against the user's own browser.
 */

/** Consent kind for a secret write, in the unified per-(host, type) grant store. */
export const SECRET_CONSENT_TYPE = "secret";

/**
 * The grant KEY a `secret` approval is remembered under — a sentinel, not a host.
 *
 * Secret-input consent is SESSION-WIDE: the first secret typed in a browser
 * session prompts, and that one approval covers every site the owner allowed,
 * until they revoke it in the options page or close the browser. The cookie and
 * storage kinds stay PER HOST in the very same store; only this kind collapses
 * to one row, because the question it asks ("may the avatar type my stored
 * secrets in this browser session?") is not a per-site question — the per-site
 * decision was already made in Noah's settings, where the owner named the exact
 * hosts each secret may be typed on, and that allowlist is re-checked at the
 * keyboard on every single write.
 *
 * The popup still SHOWS the real host, so the approval is given with the actual
 * page in view; only the memory is keyed here. Nothing derives this key from a
 * page, so no document can steer a write into another host's grant slot: the
 * `secret` type has exactly one slot. A page whose hostname were literally "*"
 * (the URL parser does allow it) would share this ROW in the options list, but
 * only under its own `cookies`/`local`/`session` type — grants are per type, and
 * revoking the row drops all of them together.
 */
export const SECRET_SESSION_GRANT_HOST = "*";

/** Hosts named in one refusal before the list is elided — a policy may hold 20. */
const REFUSAL_HOSTS_MAX = 10;

/**
 * A secret NAME as it may appear in model-facing text. The server validates the
 * shape, but this side of the wire re-narrows it anyway: the name is printed
 * OUTSIDE the untrusted-content wrapper, next to instructions, so it must not be
 * able to carry punctuation or newlines of its own.
 */
export function safeSecretName(name) {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .slice(0, 64);
  return cleaned || "(unnamed)";
}

/** The hostname of a URL, lowercased and trailing-dot-free; "" when there is none. */
export function hostOfUrl(url) {
  try {
    return new URL(String(url ?? ""))
      .hostname.toLowerCase()
      .replace(/\.$/, "");
  } catch {
    // about:blank, about:srcdoc, a data: URL, an unparseable string: no host, so
    // no host can match — the caller refuses rather than guessing.
    return "";
  }
}

/**
 * Exact hostname match against the per-secret allowlist — the same rule the
 * server's `browserSecretHostAllowed` applies, deliberately duplicated rather
 * than shared, because the two ends check DIFFERENT things (the server checks
 * the last URL it was told about; this checks the document about to be typed
 * into) and only this one is un-bypassable.
 *
 * No wildcards, ever: a pattern that matches a sibling host is exactly how a
 * phishing page under the same domain would collect the value.
 */
export function secretHostAllowed(url, hosts) {
  const host = hostOfUrl(url);
  if (!host) return false;
  return (Array.isArray(hosts) ? hosts : []).some(
    (allowed) => String(allowed ?? "").trim().toLowerCase().replace(/\.$/, "") === host,
  );
}

/** The allowed-host list as one readable clause, elided past REFUSAL_HOSTS_MAX. */
export function hostList(hosts) {
  const list = (Array.isArray(hosts) ? hosts : [])
    .map((host) => String(host ?? "").trim().slice(0, 253))
    .filter(Boolean);
  if (!list.length) return "(none)";
  const shown = list.slice(0, REFUSAL_HOSTS_MAX).join(", ");
  const rest = list.length - REFUSAL_HOSTS_MAX;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * Is this element an `<input type=password>`? The ONLY shape a `passwordOnly`
 * secret may be typed into.
 *
 * It is a DOM-shape question, not an accessibility one, and that is deliberate:
 * `role="textbox"` is page-controlled, while the `type` attribute is what makes
 * Chromium mask the value — the very fact the length-only verification and the
 * "the snapshot shows bullets, not the secret" promise both rest on
 * (password-facts.spec.ts). A shape that could not be read at all answers false:
 * unknown is not a password field.
 */
export function isPasswordInputShape(shape) {
  if (shape?.nodeName !== "INPUT") return false;
  return String(shape?.attrs?.type ?? "").trim().toLowerCase() === "password";
}

/** `<input type=text>` / `<div role=textbox>` — an element named without its content. */
export function shapeBrief(shape) {
  if (!shape?.nodeName) return "(an element this bridge could not describe)";
  const tag = String(shape.nodeName).toLowerCase().slice(0, 32);
  const type = String(shape?.attrs?.type ?? "").trim().toLowerCase().slice(0, 32);
  const role = String(shape?.attrs?.role ?? "").trim().toLowerCase().slice(0, 32);
  return `<${tag}${type ? ` type=${type}` : ""}${role ? ` role=${role}` : ""}>`;
}

/**
 * The tab itself is on a host the secret is not allowed on. The agent must NOT
 * retry here, and must not fall back to typing a credential literally — there is
 * no credential it could type, which is the point of the whole design.
 */
export function secretTabHostRefusal({ name, hosts, url }) {
  const host = hostOfUrl(url);
  return (
    `Secret \`${safeSecretName(name)}\` may be entered only on: ${hostList(hosts)} — this tab is on ` +
    `${host || "a page with no hostname"}. NOTHING was typed. Navigate to an allowed site first and do not ` +
    "retry here; if the user needs this secret on this site, they can add the host under " +
    "설정 → 권한·연결 → 시크릿 → 브라우저 입력."
  );
}

/**
 * The TAB is allowed but the element lives in an embedded frame from another
 * host. This is the attack the frame check exists for: a page on an allowed host
 * can embed a login-looking iframe from anywhere, and the tab URL says nothing
 * about who would receive the keystrokes.
 */
export function secretFrameHostRefusal({ name, hosts, frameUrl, tabUrl }) {
  const frameHost = hostOfUrl(frameUrl);
  const tabHost = hostOfUrl(tabUrl);
  return (
    `Secret \`${safeSecretName(name)}\` may be entered only on: ${hostList(hosts)} — the tab is on ` +
    `${tabHost || "an unnamed host"}, but this field is inside an embedded frame served by ` +
    `${frameHost || "a document with no hostname"}, which is not allowed. NOTHING was typed. A page can embed ` +
    "a login form from anywhere, so the frame's own host decides. Report which frame you landed on rather " +
    "than retrying."
  );
}

/**
 * The frame could not be attributed at all. Fail CLOSED: "somewhere in this tab"
 * is not an answer when the question is who receives a credential.
 */
export function secretFrameUnknownRefusal({ name }) {
  return (
    `Secret \`${safeSecretName(name)}\` was NOT typed: the bridge could not determine which document this ` +
    "field belongs to, so it cannot confirm the field is on an allowed host. This happens when the element " +
    "is being re-rendered or its frame is closing. Take a fresh mcp__browser__snapshot and try once more; if " +
    "it repeats, report it instead of retrying — the check is deliberately fail-closed."
  );
}

/**
 * `passwordOnly` is on and the target is not a password input. Named with the
 * element's shape so the agent can tell "I aimed at the username field" from
 * "this site renders its password box as a custom control".
 */
export function secretPasswordOnlyRefusal({ name, shape }) {
  return (
    `Secret \`${safeSecretName(name)}\` is restricted to password fields, and this element is ` +
    `${shapeBrief(shape)}. NOTHING was typed. Aim at the page's actual <input type=password> — take a fresh ` +
    "mcp__browser__snapshot if you are not sure which uid that is. Never type the secret into another field " +
    "and never ask the user for the value; if this site really needs it in a non-password field, the user " +
    "can turn off 비밀번호 필드에만 for this secret under 설정 → 권한·연결 → 시크릿 → 브라우저 입력."
  );
}

/**
 * The target is a control that holds no TEXT — a slider, a number input, a date
 * part. Every one of those has its own write path, and every one of those paths
 * VERIFIES by quoting what the control landed on, which a secret write may never
 * do. Refusing is also the honest answer: a credential does not belong in one.
 */
export function secretNonTextRefusal({ name, shape }) {
  return (
    `Secret \`${safeSecretName(name)}\` was NOT typed: ${shapeBrief(shape)} is not a text field — this ` +
    "bridge drives sliders, number inputs and date parts through paths that read the landed value back, " +
    "which a secret write is never allowed to do. Aim at the site's real credential field and take a fresh " +
    "mcp__browser__snapshot if you are not sure which uid that is."
  );
}

/**
 * The policy arrived but the value did not. Only a broken relay produces this,
 * and it must be LOUD: the silent alternative is typing an empty string into a
 * login form and reporting success.
 */
export function secretValueMissingRefusal({ name }) {
  return (
    `Secret \`${safeSecretName(name)}\` was NOT typed: its value did not reach the browser extension, so ` +
    "there was nothing to enter. Nothing was typed into the field. Report this to the user — it is a bridge " +
    "fault, not something a retry fixes."
  );
}

/** The user said no. A decline is an answer; retrying it is pestering. */
export const SECRET_CONSENT_DECLINED =
  "The user declined to let a stored secret be typed on this site, so NOTHING was typed. Do not retry — " +
  "tell the user which secret and which site you meant, and let them decide.";

/** No answer inside the popup's budget. Unlike a decline, this one is retryable. */
export const SECRET_CONSENT_UNANSWERED =
  "The user did not answer the secret-input prompt in time, so NOTHING was typed. Tell the user a " +
  "confirmation popup appears in their browser the first time a secret is typed in this browser session " +
  "(one approval then covers every allowed site), and retry when they are ready.";

/** Another consent popup already holds the single slot. */
export const SECRET_CONSENT_ALREADY_OPEN =
  "A confirmation popup is already open in the user's browser, so nothing was typed. Wait for their answer " +
  "instead of retrying.";

/** The popup itself could not open — so the un-bypassable gate never ran. */
export function secretConsentOpenFailed(error) {
  return (
    `The secret-input consent popup could not be opened (${String(error?.message || error)}), so NOTHING was ` +
    "typed. Report this to the user rather than retrying."
  );
}

/**
 * The insert-at-cursor case. There is no read-back at all here — deliberately:
 * the ordinary short-write path takes none either, and a read-back on a secret
 * buys nothing a length cannot give. The note exists because the agent otherwise
 * has NO way to know the write happened: it never held the value, and `text` was
 * empty on the wire.
 */
export function secretEnteredNote({ name, sent }) {
  return (
    `Secret \`${safeSecretName(name)}\` was entered at the cursor (${sent} characters). Its value is never ` +
    "shown here or in the snapshot — a password field renders as bullets."
  );
}

/** A clearing write whose LENGTH matched: the old content is gone, the secret is in. */
export function secretVerifiedNote({ name, sent }) {
  return (
    `Secret \`${safeSecretName(name)}\` replaced the field's contents (${sent} characters, verified by ` +
    "length — the value itself is never read back)."
  );
}

/** A clearing write into an element that exposes no readable value. */
export function secretUnverifiedNote({ name, sent }) {
  return (
    `Secret \`${safeSecretName(name)}\` was entered (${sent} characters), but this element exposes no ` +
    "readable value, so the replacement could NOT be verified. Check the field in the returned snapshot " +
    "(a password field shows one bullet per character) before submitting."
  );
}

/**
 * A clearing write whose read-back is the WRONG LENGTH — the old content
 * survived, or the page rewrote what was typed. Both lengths are named because
 * that is the whole of what can honestly be said; the values are never compared.
 *
 * A note and never a throw, for the same reason the ordinary diverged write is a
 * note: the write DID land, and reporting a landed credential write as a failure
 * invites a retry that types it a second time.
 */
export function secretLengthMismatchNote({ name, sent, read }) {
  return (
    `Secret \`${safeSecretName(name)}\` was entered (${sent} characters) but the field reads back ${read} ` +
    "characters, so its previous contents were NOT fully replaced (or the page rewrote the input). Do NOT " +
    "submit this form: clear the field with the page's own clear control, then try once more. The value " +
    "itself is never read back or shown."
  );
}
