#!/usr/bin/env bun
import { Command } from "commander"
import { registerCli } from "./cli/index.js"

const program = new Command()
registerCli(program)

void program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
