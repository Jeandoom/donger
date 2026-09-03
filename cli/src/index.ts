import { buildProgram } from "./commands.js";

void buildProgram()
  .parseAsync()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
