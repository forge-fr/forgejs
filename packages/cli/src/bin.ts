#!/usr/bin/env node
import { runCli } from './runner.js';

const result = await runCli(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
});

if (result.exitCode !== 0) {
  process.exitCode = result.exitCode;
}
