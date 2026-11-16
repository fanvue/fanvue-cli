// One CLI process asking for an access token. The race test runs two of these at once.
import { refreshTokens } from "../../src/auth/oauth.ts";
import { Session } from "../../src/auth/session.ts";
import { CliError } from "../../src/runtime/errors.ts";
import { fileStore } from "./file-store.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const STORE_PATH = required("STORE_PATH");
const LOCK_PATH = required("LOCK_PATH");
const TOKEN_URL = required("TOKEN_URL");
const NO_LOCK = process.env.NO_LOCK;

const session = new Session({
  store: fileStore(STORE_PATH),
  profile: "default",
  // A per-process lock path is the same as having no lock: this is the red half of the test.
  lockPath: NO_LOCK ? `${LOCK_PATH}.${process.pid}` : LOCK_PATH,
  refresh: (current) =>
    refreshTokens({ tokenUrl: TOKEN_URL, clientId: "fanvue-cli" }, current.refreshToken),
});

try {
  console.log(await session.accessToken());
} catch (error) {
  console.log(error instanceof CliError ? error.code : String(error));
  process.exit(1);
}
