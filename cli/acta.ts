#!/usr/bin/env bun
// acta CLI entry. The command table is cli/cli.ts; this file only serves it
// (kept apart because Bun would auto-serve a default-exported CLI as HTTP).
import { cli } from "./cli.ts";

cli.serve();
