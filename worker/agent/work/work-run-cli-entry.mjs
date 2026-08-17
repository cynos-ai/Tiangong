import { runWorkRunRecoveryCommand } from "./work-run-recovery-cli.mjs";

runWorkRunRecoveryCommand(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`tiangong-work-run: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
