// The command table. `acta --help` and `acta --llms` are generated from it.
import type { Command } from "../args.ts";
import { command as newMeeting } from "./new.ts";
import { command as meetings } from "./meetings.ts";
import { command as tail } from "./tail.ts";
import { command as bookPut, showCommand as bookShow } from "./book.ts";
import { command as exportMeeting } from "./export.ts";
import { command as sync } from "./sync.ts";
import { command as doctor } from "./doctor.ts";
import { command as test } from "./test.ts";

export const COMMANDS: readonly Command[] = [newMeeting, meetings, tail, bookPut, bookShow, exportMeeting, sync, doctor, test];
