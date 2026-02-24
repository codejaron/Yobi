import { exec } from "node:child_process";
import { promisify } from "node:util";
import { SandboxGuard } from "@main/tools/guard/sandbox";

const execAsync = promisify(exec);

function trimOutput(output: string, limit: number): string {
  if (output.length <= limit) {
    return output;
  }

  return `${output.slice(0, limit)}\n...[truncated]`;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  shell?: string;
}

export interface ExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class ShellExecutor {
  constructor(private readonly sandboxGuard: SandboxGuard) {}

  async run(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.sandboxGuard.ensureExecAllowed(command);

    const startedAt = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options?.cwd,
        timeout: options?.timeoutMs ?? 15_000,
        maxBuffer: options?.maxBufferBytes ?? 1_000_000,
        shell: options?.shell ?? "/bin/zsh"
      });

      return {
        command,
        cwd: options?.cwd ?? process.cwd(),
        stdout: trimOutput(stdout ?? "", 10_000),
        stderr: trimOutput(stderr ?? "", 10_000),
        exitCode: 0,
        durationMs: Date.now() - startedAt
      };
    } catch (error: any) {
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";

      return {
        command,
        cwd: options?.cwd ?? process.cwd(),
        stdout: trimOutput(stdout, 10_000),
        stderr: trimOutput(stderr || String(error?.message ?? error), 10_000),
        exitCode: typeof error?.code === "number" ? error.code : 1,
        durationMs: Date.now() - startedAt
      };
    }
  }
}
