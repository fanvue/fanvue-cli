/**
 * Exit codes, disjoint so an agent can branch on them. Agreed with the App Platform scoping.
 * Part of the CLI's contract: never reuse a number for something else.
 */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  /** Reserved for the builder commands' manifest validation. */
  manifestInvalid: 3,
  /** Not logged in, session ended, or the token lacks the scope. */
  auth: 4,
  /** Reserved: local and remote state disagree. */
  drift: 5,
  /** Reserved: some of a multi-step operation applied. */
  partial: 6,
  /** Nothing was sent: a person has to confirm, or declined. */
  needsHuman: 7,
} as const;

/** Where the problem is and how to fix it, so an agent can correct itself. */
export interface ErrorDetail {
  /** JSON Pointer into the command's input, e.g. `/body/subscriptionPrice` or `/flags/size`. */
  pointer?: string;
  /** The offending value as given. */
  value?: unknown;
  hint?: string;
  /** HTTP status, for errors the API returned. */
  status?: number;
  /** Every validation error Styx returned, when there was more than one thing wrong. */
  errors?: { code: string; message: string }[];
  /** On a 403: the scopes the command needs. */
  scopes?: string[];
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.unexpected,
    /** Stable, machine-readable: callers branch on this, never on the message. */
    readonly code = "unexpected",
    readonly detail: ErrorDetail = {},
  ) {
    super(message);
  }
}

export class UsageError extends CliError {
  constructor(message: string, code = "usage", detail: ErrorDetail = {}) {
    super(message, EXIT.usage, code, detail);
  }
}

// Some routes blank their messages for API clients and return only a bare code, e.g.
// {"error":"BAD_REQUEST"}.
const BLANKED = /^[A-Z][A-Z_]+$/;

// Styx's own schema validation answers 400 with
// {"errors":[{"code","message":"Invalid <dotted.field>: <reason>"}]}; the field is only in the text.
const INVALID_FIELD = /^Invalid ([^:]+):/;

type Explained = { message: string; code?: string; detail: ErrorDetail };

function explain(status: number, body: unknown, where: "body" | "query"): Explained {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (Array.isArray(b.errors) && b.errors.length) {
    const errors = b.errors as { code: string; message: string }[];
    const field = INVALID_FIELD.exec(errors[0]?.message ?? "")?.[1];
    return {
      message: errors.map((e) => e.message).join("; "),
      code: "validation_failed",
      detail: {
        status,
        errors,
        ...(field ? { pointer: `/${where}/${field.split(".").join("/")}` } : {}),
        hint: "Fix the field named, or check the command's flags with `--schema`.",
      },
    };
  }

  const text = [b.message, b.error_description, b.error].find(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  return byStatus(status, text) ?? byText(status, text);
}

function byStatus(status: number, text: string | undefined): Explained | undefined {
  if (status >= 500) {
    return {
      message: `Fanvue had a problem answering (HTTP ${status}${text ? `: ${text}` : ""}).`,
      code: "server_error",
      detail: {
        status,
        hint: "Try again shortly. If it keeps failing, the problem is on Fanvue's side, not in your command.",
      },
    };
  }
  if (status === 404) {
    return { message: text ?? "Not found.", code: "not_found", detail: { status } };
  }
  return undefined;
}

function byText(status: number, text: string | undefined): Explained {
  if (text && BLANKED.test(text)) {
    return {
      message: `Fanvue rejected the request (${text}) without saying why.`,
      code: text.toLowerCase(),
      detail: {
        status,
        hint: "Check the flags against `--schema`, or retry with `--dry-run` to see what was sent.",
      },
    };
  }
  if (text) return { message: text, detail: { status } };
  if (status === 401) {
    return {
      message: "Your session has expired or was revoked. Run `fanvue login`.",
      detail: { status },
    };
  }
  return { message: `Request failed (HTTP ${status}).`, detail: { status } };
}

export class ApiError extends CliError {
  constructor(
    readonly status: number,
    readonly body: unknown,
    /** Where the request carried its input, for pointing at the field Styx names. */
    where: "body" | "query" = "body",
  ) {
    const { message, code, detail } = explain(status, body, where);
    // The CLI service refuses money-moving operations for every session, whatever its scopes.
    const excluded =
      status === 403 && (body as { error?: unknown } | null)?.error === "operation_excluded";
    if (excluded) {
      detail.hint = "Use Fanvue in your browser for this; no CLI login can make it available.";
    }
    const [exitCode, fallback] =
      status === 401
        ? [EXIT.auth, "auth_required"]
        : status === 403
          ? [EXIT.auth, "forbidden"]
          : [EXIT.unexpected, `http_${status}`];
    super(
      message,
      exitCode,
      excluded
        ? "operation_excluded"
        : status === 401 || status === 403
          ? fallback
          : (code ?? fallback),
      detail,
    );
  }
}

/** Adds the command's scopes to a 403, since Fanvue's reply rarely names the missing one. */
export function withScopes(error: unknown, scopes: string[]): unknown {
  if (!(error instanceof ApiError && error.status === 403 && scopes.length)) return error;
  if (error.code === "operation_excluded") return error;
  const writes = scopes.some((s) => s.startsWith("write:"));
  error.detail.scopes = scopes;
  error.detail.hint =
    `This command needs ${scopes.join(", ")}. If your session doesn't have them, run ` +
    `\`fanvue login${writes ? " --write" : ""}\`; if it does, this account can't use the command.`;
  return error;
}

/** The JSON error printed when output isn't a terminal: `{"error": {...}}`. */
export function errorJson(error: CliError) {
  return { error: { code: error.code, message: error.message, ...error.detail } };
}
