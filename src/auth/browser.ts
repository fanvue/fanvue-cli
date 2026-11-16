type Env = Record<string, string | undefined>;

/** Opens a URL in the default browser. Returns false over SSH or when no opener works. */
export async function openBrowser(url: string, env: Env = process.env): Promise<boolean> {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export const SSH_HINT =
  "Over SSH, forward the callback port from your own machine first, then open the link there:\n" +
  "  ssh -L 8787:127.0.0.1:8787 <this host>";
