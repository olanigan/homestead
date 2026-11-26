#!/usr/bin/env bun
import { Command } from "commander"
import { registerCli } from "./cli/index.js"

const program = new Command()
registerCli(program)

const normalizedArgs = process.argv.map((arg) => {
  if (arg === "-ngl" || arg.startsWith("-ngl=")) return arg.replace(/^-ngl/, "--ngl")
  if (arg === "-ub" || arg.startsWith("-ub=")) return arg.replace(/^-ub/, "--ub")
  if (arg === "-np" || arg.startsWith("-np=")) return arg.replace(/^-np/, "--np")
  return arg
})

void program.parseAsync(normalizedArgs).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
