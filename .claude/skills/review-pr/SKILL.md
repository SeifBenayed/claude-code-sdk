---
name: review-pr
description: Review a pull request for bugs, security issues, and improvements. Use when the user asks to review a PR, review changes, or check code quality of a branch.
allowed-tools: Bash, Read, Grep, Glob
---

# Pull Request Review

Review the current branch's changes compared to the base branch.

## Steps

1. Determine the base branch:
   - Try `main`, then `master`, then ask
   - Run `git log --oneline <base>..HEAD` to see all commits in this PR
2. Run `git diff <base>...HEAD` to see the full diff
3. For large diffs, review file-by-file using `git diff <base>...HEAD -- <file>`
4. For each changed file, check for:
   - **Bugs**: logic errors, off-by-one, null/undefined access, race conditions
   - **Security**: injection, XSS, auth bypass, hardcoded secrets, SSRF
   - **Performance**: N+1 queries, unbounded loops, missing indexes, memory leaks
   - **Error handling**: missing try/catch, swallowed errors, unclear error messages
   - **Style**: inconsistency with the rest of the codebase
   - **Tests**: missing tests for new functionality or edge cases
5. Provide a structured review:

   **Summary** — What the PR does (1-2 sentences)

   **Issues** — Bugs, security, or correctness problems that should be fixed before merge

   **Suggestions** — Non-blocking improvements worth considering

   **Verdict** — Approve / Request Changes / Needs Discussion

Be specific — reference file paths and line numbers. Suggest concrete fixes, not vague advice.

$ARGUMENTS
