---
name: integration-tests-debugging
description: Run, debug, and troubleshoot integration tests for the STARLIMS VS Code extension.
---

# Integration Tests Debugging Skill

Use this skill when you need to run or debug integration tests in this workspace.

## Goal

Help developers quickly validate extension changes by running the right npm tasks, launching the Extension Development Host, and diagnosing failures with the least amount of friction.

## Workspace Facts

- This is a VS Code extension written in TypeScript.
- Integration tests are expected to run through the extension test harness.
- The repo provides background watch tasks for the extension and test build.
- The development host is the main place to debug extension behavior.

## Recommended Flow

1. Install dependencies if needed: `npm install`
2. Check code quality first: `npm run lint`
3. Build the extension: `npm run compile`
4. Compile tests when test code changed: `npm run compile-tests`
5. Run the full pretest pipeline: `npm run pretest`
6. Launch the extension in a debugger with `F5` or the VS Code debug configuration

## Useful Tasks

- `npm: watch` keeps the extension bundle rebuilding.
- `npm: watch-tests` keeps test files rebuilding.
- `tasks: watch-tests` runs both watch tasks together.

## Debugging Checklist

- Confirm the extension host window opens successfully.
- Check the VS Code Developer Tools console for runtime errors.
- Review the Output panel for extension logs.
- Verify the expected test files were compiled before execution.
- Re-run the specific failing test or scenario after fixing the issue.

## Common Failure Causes

- Missing dependencies after a clean checkout.
- Build errors in TypeScript that prevent the test bundle from compiling.
- Extension activation failures caused by configuration or startup errors.
- Environment issues when VS Code is unavailable or the host cannot launch.

## Troubleshooting Notes

- If tests fail before launch, inspect the compile output first.
- If the extension host crashes, use the debugger and Developer Tools to capture the stack trace.
- If the problem is intermittent, keep the watch tasks running and reproduce in the Extension Development Host.

## Output To Prefer

When answering, include:

- the command or task to run,
- what part of the workflow it affects,
- the most likely next debugging step if it fails.
