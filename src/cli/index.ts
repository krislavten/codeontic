#!/usr/bin/env node
import { run } from "./run.js";

const io = {
  log: (line: string) => {
    process.stdout.write(`${line}\n`);
  },
  error: (line: string) => {
    process.stderr.write(`${line}\n`);
  },
};

run(process.argv.slice(2), io)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err: unknown) => {
    io.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
