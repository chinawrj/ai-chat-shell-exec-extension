---
name: skill-creator
description: Create or update reusable Skills in the AI Chat Shell Exec local catalog. Use for local SKILL.md authoring, not one-off prompts, generic custom instructions, or platform-native plugin configuration.
---

# Skill Creator

Create Skills that add useful, non-obvious guidance without taking over unrelated work or expanding the user's authorization.

## Resolve the Destination

The shell server captured the authoritative configuration when this Skill was loaded:

- Configuration source: `$AI_HELPER_SKILL_ROOT_SOURCE`
- Resolved Skill roots JSON: `$AI_HELPER_SKILL_ROOTS_JSON`

Use only those resolved roots. They already reflect `AI_HELPER_SKILL_PATHS`, the single-root compatibility variable `AI_HELPER_SKILL_PATH`, or the host default when neither variable exists. Do not read a tmux pane's environment, hardcode a conventional default directory, or reuse a path remembered from an earlier session.

1. If the roots JSON is empty, stop and report that the shell server has an explicitly empty or invalid Skill-root configuration.
2. If the user names a destination, use it only when it is one of the resolved roots or is contained by one. A path outside the resolved roots belongs to a different workflow.
3. If exactly one root is available, use it.
4. If multiple roots are available, update the unique existing Skill when exactly one matching Skill is found inside them; otherwise ask the user which resolved root should receive the new Skill.

Create or update `<resolved-root>/<skill-name>/SKILL.md` and `<resolved-root>/<skill-name>/install.sh`. Keep the folder name equal to the frontmatter `name`. Reject traversal, symlinked roots or files, and destinations outside the resolved root.

## Design the Skill

- Use lowercase letters, digits, and hyphens for `name`; keep it under 64 characters.
- Write a concise `description` that says what the Skill does and when it applies. Add exclusions only when they prevent likely misrouting.
- Assume the AI is already capable. Include only context, decisions, constraints, or procedures that materially improve the requested work.
- Preserve the user's scope and choices. A Skill does not grant permission for external writes, deployments, messages, purchases, or destructive actions.
- Match instruction specificity to actual risk. Prefer outcomes and decision criteria unless a fixed sequence prevents a concrete failure.
- Keep the main `SKILL.md` self-contained and short. Add `scripts/`, `references/`, or `assets/` only when they have a concrete reusable purpose, and link conditional references from `SKILL.md`.
- Do not add a README, changelog, placeholder file, or example resource unless the user asks for it or the workflow truly needs it.

## Create or Update

1. Inspect an existing Skill with the same name before writing. Across multiple configured roots, fail on duplicate names instead of choosing one arbitrarily.
2. For an update, preserve useful instructions and unrelated supported metadata. Change only what the request requires.
3. For a new Skill, start with YAML frontmatter containing `name` and `description`, followed by the focused Markdown instructions.
4. Ensure the Skill directory has a real, non-symlinked `install.sh`. It must be non-interactive, use a shebang plus `set -eu`, return zero only after all required setup succeeds, and return nonzero on failure. The shell server guarantees that the installer's working directory is the Skill directory but executes an immutable snapshot elsewhere, so resolve Skill-relative files through `$PWD` or cwd-relative paths; never derive the Skill directory from `$0` or `dirname "$0"`. When the Skill needs no setup, use `test -f "$PWD/SKILL.md"` and then exit successfully. Do not hide network access, privilege escalation, destructive changes, or credential requirements in the installer.
5. Use the available file-editing mechanism; do not construct an unsafe shell command from an unvalidated name or path.
6. Run the installer in an isolated or reversible test case. If the Skill includes other scripts, test them too. If it includes references, verify that every referenced path exists and is discoverable from `SKILL.md`.

## Validate

Before reporting completion:

- Confirm the file is UTF-8, begins with valid YAML frontmatter, and its `name` matches both the requested name and folder.
- Confirm the description is sufficiently discriminating for discovery and the body contains no unfinished scaffold text.
- Confirm the final file is a real file contained by a real configured root, not a symlink.
- Tell the user that a new or changed Skill remains unavailable to the AI until they open `View Skills` in the extension and click `Install`. Do not try to trigger installation through an AI helper.
- After the user confirms installation, request a fresh installed catalog list with the standard Skill helper:

  ```text
  ai-helper-skill-start
  cmd: list
  ai-helper-skill-end
  ```

  A challenge is intentionally omitted: this is inspection, not memory acknowledgement. Do not invent `cmd: rescan`. Require a healthy response with exactly one record for the Skill name, and resolve duplicate-name or validation errors instead of accepting a partial catalog.
- For an update, confirm the raw `SKILL.md` SHA changed only when its contents changed.
- Report the resolved destination, files created or changed, and validation performed.
