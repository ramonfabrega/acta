# The acta plugin

What a Claude Code session needs to own a meeting: the CLI as one skill, and
the hook that makes the session that minted a meeting its brain.

- `skills/acta/SKILL.md`: the command table, generated from the CLI
  (`bun run plugin:skill`; `test/plugin/plugin.test.ts` fails on drift)
  behind a preamble on how the brain arms Monitor.
- `hooks/hooks.json` + `hooks/acta-new.ts`: a `PostToolUse` hook on `Bash`.
  When the command was `acta new`, it reads the meeting id off the answer,
  the operator token off passage, and returns `additionalContext` with the
  exact `Monitor` call to make. A hook cannot call Monitor; the session
  does, and re-arms it every thirty minutes (`docs/BRAIN.md`).

The repo root is the marketplace (`.claude-plugin/marketplace.json` lists
`./plugin`). Installed the fleet way, the checkout is the installed copy:

```sh
claude plugin marketplace add ~/code/fun/acta
claude plugin install acta@acta        # or enabledPlugins in settings.json
/reload-plugins                        # after editing the skill or the hook
```

Elsewhere, from GitHub:

```
/plugin install acta --marketplace ramonfabrega/acta
```

Validate with `claude plugin validate .` (the marketplace) and
`claude plugin validate plugin` (the plugin). `acta skills add` is the other
route: incur writes one skill per verb into `~/.agents/skills/acta-<verb>`
for sessions that do not have the plugin.
