import { NodeProcessRunner } from "../gvisor/nodeProcessRunner"
import {
  CommandExecutionError,
  type CommandRunner,
  type CommandRunOptions,
} from "./commandRunner"
import type { LocalPreviewWorkspace } from "./localWorkspace"

/** Development only: host execution has no sandbox or network isolation. */
export class HostCommandRunner implements CommandRunner {
  async run(
    workspace: LocalPreviewWorkspace,
    command: string,
    args: string[],
    options: CommandRunOptions,
  ): Promise<void> {
    const result = await new NodeProcessRunner().run(command, args, {
      ...options,
      cwd: workspace.rootDir,
      // Only fixed npm.cmd commands require a shell on Windows.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    })
    if (result.timedOut || result.exitCode !== 0) {
      throw new CommandExecutionError(
        result.timedOut
          ? "The command exceeded its time limit."
          : "The command failed.",
        result.stdout,
        result.stderr,
      )
    }
  }
}
