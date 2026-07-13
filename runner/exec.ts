import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RunResult = { stdout: string; stderr: string };

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<RunResult>;
}

export class RealCommandRunner implements CommandRunner {
  async run(
    cmd: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ) {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return { stdout, stderr };
  }
}
