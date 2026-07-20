# Orchestrator Flow Guidelines

Guidelines for writing `/pi-orch` orchestrator flow scripts. These rules apply to all flows in this repository and any project that consumes `pi-subagents`.

## Mandatory Rules

### 1. English Only

All code, comments, and documentation within flow files must be written in English. This includes function names, variable names, JSDoc comments, inline comments, log messages, and the final summary output returned from `flow()`. The only exception is user-facing prompts (`task` strings passed to agents or `interactiveStep` prompts), which may be written in the language appropriate for the target audience.

```typescript
// GOOD
const planResult = await ctx.runAgent({
  agent: "planner",
  task: "Stwórz plan implementacji dla systemu logowania.", // user prompt in Polish — OK
  as: "plan",
  label: "Generate implementation plan",
});

// BAD — comment in Polish
// Odpal agenta planującego
const planResult = await ctx.runAgent({ ... });
```

### 2. TypeScript

All flow files must be written in TypeScript (`.ts`). Do not use plain JavaScript.

### 3. One Function Per Step

Each logical step in the flow must be a standalone function with properly typed parameters and return values. The top-level `flow` function should read as a high-level sequence of steps, not a wall of inline logic.

```typescript
// GOOD — each step extracted into a typed function
async function validateGitClean(ctx: OrchestratorContext): Promise<string> {
  const status = execSync("git status --porcelain", { cwd: ctx.cwd, encoding: "utf-8" });
  if (status.trim() !== "") {
    throw new Error(`Repository is not clean. Uncommitted changes:\n${status.slice(0, 500)}`);
  }
  ctx.log("Git status: clean ✓");
  return status;
}

async function runScout(ctx: OrchestratorContext, prompt: string): Promise<OrchestratorRunAgentResult> {
  return ctx.runAgent({
    agent: "scout",
    task: `Analyze the following feature request and produce an implementation plan:\n\n"${prompt}"`,
    as: "scout-plan",
    label: "Scout – implementation plan",
    output: "implementation-plan.md",
  });
}

export default {
  settings: { },
  flow: async (ctx: OrchestratorContext) => {
    const prompt = parseArgs(ctx.args);
    const projectRoot = await resolveProjectRoot(ctx);
    await validateGitClean(ctx);
    const plan = await runScout(ctx, prompt);
    return buildSummary(prompt, projectRoot, plan);
  },
} satisfies OrchestratorScript;

// BAD — everything inlined in flow()
export default {
  flow: async (ctx: OrchestratorContext) => {
    // 50 lines of inline git checks, arg parsing, agent calls...
  },
} satisfies OrchestratorScript;
```

## Best Practices

These are conventions extracted from existing flows. They are not mandatory but will make your flow more consistent, maintainable, and debuggable.

### Use the right step primitive

| Primitive | When to use |
|-----------|-------------|
| `ctx.runAgent()` | Launching a subagent (scout, reviewer, worker, etc.) |
| `ctx.runStep()` | Deterministic work: file I/O, git commands, data processing |
| `ctx.interactiveStep()` | Collecting structured input from the user in a separate tab |
| `ctx.withRetry()` | Wrapping any agent call that may fail transiently |
| `ctx.runInWorktree()` | Isolating file mutations from the main working tree |

### Prefer deterministic code over agents

Every operation in a flow should use the cheapest, fastest, and most reliable primitive that can get the job done. Follow this decision hierarchy:

1. **If the operation can be done deterministically and the result can be verified deterministically → use `ctx.runStep()` with plain TypeScript code.** This includes git operations, file I/O, input validation, string manipulation, type-checking, and any computation with a known correct answer.

2. **If the operation requires judgment, reasoning, or creative generation → delegate to an agent via `ctx.runAgent()`.** Use this for tasks like code analysis, planning, code generation, review, or naming things based on human context.

3. **When an agent produces a result, verify it deterministically whenever possible.** The agent handles the fuzzy part; your code checks the output for structural correctness, constraints, and safety before proceeding.

| Operation | Primitive | Why |
|-----------|-----------|-----|
| Check if the git repo is clean | `ctx.runStep()` | Deterministic: `git status --porcelain` has a clear yes/no answer |
| Validate a branch name (length, characters, format) | `ctx.runStep()` | Deterministic: regex and length checks are exact |
| Check if a branch name already exists | `ctx.runStep()` | Deterministic: `git branch --list` tells you exactly |
| Check if a worktree path is available | `ctx.runStep()` | Deterministic: `fs.existsSync()` or `git worktree list` |
| Create a git worktree | `ctx.runStep()` | Deterministic: `git worktree add` either succeeds or fails |
| Come up with a branch name from a feature description | `ctx.runAgent()` | Creative: requires understanding the feature and choosing a concise, meaningful name |
| Analyze a codebase to find relevant files | `ctx.runAgent()` | Requires judgment: understanding what is relevant to the task |
| Generate an implementation plan | `ctx.runAgent()` | Requires reasoning: synthesizing context into a coherent plan |
| Review code for correctness | `ctx.runAgent()` | Requires judgment: spotting bugs, logic errors, edge cases |

**Example: creating a worktree for a new feature**

The flow splits the work between agent and deterministic code — the agent handles the creative naming, and the code validates everything else:

```typescript
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Deterministic: validate branch name ─────────────────────────────────

const VALID_BRANCH_RE = /^[a-z0-9]([a-z0-9._\/-]*[a-z0-9])?$/;
const MAX_BRANCH_LENGTH = 244;

function validateBranchName(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (trimmed.length === 0) {
    throw new Error("Branch name must not be empty");
  }
  if (trimmed.length > MAX_BRANCH_LENGTH) {
    throw new Error(
      `Branch name too long (${trimmed.length} chars, max ${MAX_BRANCH_LENGTH})`,
    );
  }
  if (!VALID_BRANCH_RE.test(trimmed)) {
    throw new Error(
      `Branch name "${trimmed}" contains invalid characters. ` +
      `Allowed: lowercase letters, digits, . _ - / (must start and end with alphanumeric)`,
    );
  }
  return trimmed;
}

function checkRepoClean(cwd: string): void {
  const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
  if (status.trim() !== "") {
    throw new Error(`Repository is not clean:\n${status.slice(0, 500)}`);
  }
}

function branchExists(cwd: string, name: string): boolean {
  try {
    execSync(`git rev-parse --verify "refs/heads/${name}"`, {
      cwd, encoding: "utf-8", stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function worktreePathAvailable(wtPath: string): boolean {
  return !fs.existsSync(wtPath);
}

// ── Agent: generate branch name from feature description ────────────────

async function generateBranchName(
  ctx: OrchestratorContext,
  featureDescription: string,
): Promise<string> {
  const result = await ctx.runAgent({
    agent: "delegate",
    task: [
      `Generate a short, descriptive git branch name for this feature:`,
      ``,
      `"${featureDescription}"`,
      ``,
      `Rules:`,
      `- Use lowercase letters, digits, hyphens, and forward slashes only`,
      `- Start with a category prefix (feat/, fix/, refactor/, chore/)`,
      `- Keep it under 50 characters`,
      `- Return ONLY the branch name, nothing else — no markdown, no explanation`,
    ].join("\n"),
    as: "branch-name",
    label: "Generate branch name",
  });

  // ── Deterministic validation of agent output ──────────────────────────
  const rawName = result.output.trim();
  const validated = validateBranchName(rawName);
  ctx.log(`Agent proposed: "${rawName}" → validated: "${validated}"`);
  return validated;
}

// ── Orchestrated step ───────────────────────────────────────────────────

async function createFeatureWorktree(
  ctx: OrchestratorContext,
  featureDescription: string,
): Promise<{ branchName: string; worktreePath: string }> {
  checkRepoClean(ctx.cwd);

  const branchName = await generateBranchName(ctx, featureDescription);

  if (branchExists(ctx.cwd, branchName)) {
    throw new Error(`Branch "${branchName}" already exists`);
  }

  const worktreePath = path.join(ctx.chainDir, "worktrees", branchName);
  if (!worktreePathAvailable(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  await ctx.runStep({ label: "Create worktree" }, async () => {
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
      cwd: ctx.cwd, encoding: "utf-8",
    });
  });

  ctx.log(`Worktree created: ${worktreePath} (branch: ${branchName})`);
  return { branchName, worktreePath };
}
```

Notice the pattern:
- **Agent** generates the branch name (the creative part).
- **Deterministic code** validates the output (length, characters, format), checks preconditions (clean repo, branch not taken, path available), and performs the actual worktree creation.
- The agent's output is never trusted blindly — it goes through `validateBranchName()` before being used.

### Always set `label` and `as`

- `label` — human-readable name shown in logs and flow summary tables.
- `as` — logical identifier for the step, usable in chain templates and flow.json.

```typescript
await ctx.runAgent({
  agent: "reviewer",
  task: "Review the current diff for correctness.",
  as: "correctness-review",       // machine-readable key
  label: "Correctness review",    // human-readable label
});
```

### Validate arguments early

Read `ctx.args` at the top of `flow()` and fail fast with a clear error message if required arguments are missing.

```typescript
const prompt = ctx.args.join(" ").trim();
if (!prompt) {
  throw new Error("Usage: /pi-orch <script> \"<feature description>\"");
}
```

### Use `satisfies OrchestratorScript` on the default export

This gives you type-checking on the entire export shape — settings, flow signature, and return type.

```typescript
export default {
  flow: async (ctx: OrchestratorContext) => { ... },
} satisfies OrchestratorScript;
```

### Pass data between steps via files

Use `output` + `reads` to pass structured context between agent steps. This is more reliable than relying on `{previous}` which can be truncated.

```typescript
// Step 1: produce context
await ctx.runAgent({
  agent: "scout",
  task: "Analyze the auth module.",
  as: "codebase-scan",
  label: "Codebase scan",
  output: "context.md",
});

// Step 2: consume it
await ctx.runAgent({
  agent: "planner",
  task: "Create a plan based on the provided context.",
  as: "plan",
  label: "Implementation plan",
  reads: ["context.md"],
});
```

Sometimes, instead of using `reads`, it makes more sense to dynamically embed the previous step's output directly into the prompt. This gives you control over truncation and formatting.

```typescript
const scan = await ctx.runAgent({
  agent: "scout",
  task: "Analyze the project structure.",
  as: "scan",
  label: "Project scan",
});

// Dynamically build the next prompt with the full output
await ctx.runAgent({
  agent: "planner",
  task: `Based on this scan result, create a plan:\n\n---\n${scan.output}\n---`,
  as: "plan",
  label: "Implementation plan",
});
```

### Handle agent errors explicitly

By default, `ctx.runAgent()` throws `OrchestratorAgentError` when the agent exits with a non-zero code. Use `doNotThrowOnError: true` when the flow should continue despite an agent failure.

```typescript
const result = await ctx.runAgent({
  agent: "reviewer",
  task: "Review the diff (this might fail on empty diff).",
  as: "review",
  label: "Diff review",
  doNotThrowOnError: true,
});

if (result.exitCode !== 0) {
  ctx.log(`Review skipped: ${result.error}`);
}
```

### Use `ctx.withRetry()` for transient failures

Wrap agent calls that may fail due to temporary issues (model overload, network timeouts).

```typescript
const result = await ctx.withRetry(
  { maxAttempts: 3, delayMs: 2000, backoff: "exponential" },
  async ({ attempt, lastError }) => {
    const task = lastError
      ? `Previous attempt failed: ${lastError.message}. Please retry.\n\nOriginal task: ${baseTask}`
      : baseTask;
    return ctx.runAgent({ agent: "worker", task, as: "impl", label: `Implementation (attempt ${attempt + 1})` });
  },
);
```

### Write output files to `ctx.chainDir`

All flow artifacts (context files, plans, patches, logs) should be written under `ctx.chainDir`. This keeps the working directory clean and ensures artifacts from different runs do not collide.

```typescript
import * as path from "node:path";
import * as fs from "node:fs";

const filePath = path.join(ctx.chainDir, "my-context.md");
fs.writeFileSync(filePath, content, "utf-8");
```

### Return a readable summary

The `flow()` function must return `{ output: string }`. Format this as a Markdown summary with key results, file paths, durations, and any decisions made.

```typescript
return {
  output: [
    "## Flow completed",
    "",
    `| Step | Duration | Result |`,
    `|------|----------|--------|`,
    `| Scout | ${(scoutResult.durationMs ?? 0 / 1000).toFixed(1)}s | ✅ \`context.md\` |`,
    `| Plan  | ${(planResult.durationMs ?? 0 / 1000).toFixed(1)}s | ✅ \`plan.md\` |`,
    "",
    `**Artifacts:** \`${ctx.chainDir}\``,
  ].join("\n"),
};
```

### Import types from `orchestrator-context.ts`

Always import `OrchestratorContext`, `OrchestratorScript`, and `OrchestratorRunAgentResult` from the orchestrator context module.

```typescript
import type {
  OrchestratorContext,
  OrchestratorScript,
  OrchestratorRunAgentResult,
} from "../pi-subagents-milosz/src/orchestrator/orchestrator-context.ts";
```

### Avoid over-logging

Use `ctx.log()` for high-level progress and decisions. The bridge automatically logs step start/end, duration, tokens, and cost — you do not need to duplicate that.

```typescript
// GOOD — log business decisions
ctx.log(`Large result detected (>10 files) — running oracle for verification`);

// UNNECESSARY — the bridge already logs this
ctx.log(`Starting agent scout...`);
ctx.log(`Agent scout finished in 2.3s`);
```

## Skeleton

Use this template as a starting point for new flows:

```typescript
/**
 * <flow-name>.ts
 *
 * Brief description of what this flow does and when to use it.
 *
 * Usage:
 *   /pi-orch <flow-name> "<arguments>"
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import type {
  OrchestratorContext,
  OrchestratorScript,
  OrchestratorRunAgentResult,
} from "../pi-subagents-milosz/src/orchestrator/orchestrator-context.ts";

// ── Step functions ──────────────────────────────────────────────────────

async function parseAndValidateArgs(ctx: OrchestratorContext): Promise<string> {
  const input = ctx.args.join(" ").trim();
  if (!input) {
    throw new Error("Usage: /pi-orch <script> \"<required argument>\"");
  }
  ctx.log(`Input: ${input}`);
  return input;
}

async function resolveGitRoot(ctx: OrchestratorContext): Promise<string> {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: ctx.cwd,
      encoding: "utf-8",
    }).trim();
    ctx.log(`Git root: ${root}`);
    return root;
  } catch {
    throw new Error(`Not a git repository (cwd: ${ctx.cwd})`);
  }
}

async function runFirstAgent(
  ctx: OrchestratorContext,
  input: string,
): Promise<OrchestratorRunAgentResult> {
  return ctx.runAgent({
    agent: "scout",
    task: `Analyze: ${input}`,
    as: "first-step",
    label: "First step",
    output: "first-output.md",
  });
}

async function runSecondAgent(
  ctx: OrchestratorContext,
  previousResult: OrchestratorRunAgentResult,
): Promise<OrchestratorRunAgentResult> {
  return ctx.runAgent({
    agent: "planner",
    task: `Based on this analysis:\n\n---\n${previousResult.output}\n---\n\nCreate a plan.`,
    as: "second-step",
    label: "Second step",
    output: "second-output.md",
  });
}

function buildSummary(
  input: string,
  root: string,
  step1: OrchestratorRunAgentResult,
  step2: OrchestratorRunAgentResult,
): { output: string } {
  return {
    output: [
      "## Flow completed",
      "",
      `**Input:** ${input}`,
      `**Git root:** ${root}`,
      "",
      "| Step | Duration | Status |",
      "|------|----------|--------|",
      `| First step | ${((step1.durationMs ?? 0) / 1000).toFixed(1)}s | ${step1.exitCode === 0 ? "✅" : "❌"} |`,
      `| Second step | ${((step2.durationMs ?? 0) / 1000).toFixed(1)}s | ${step2.exitCode === 0 ? "✅" : "❌"} |`,
      "",
      "### Output",
      "",
      step2.output.slice(0, 2000),
    ].join("\n"),
  };
}

// ── Flow ─────────────────────────────────────────────────────────────────

export default {
  settings: {
  },

  flow: async (ctx: OrchestratorContext) => {
    const input = await parseAndValidateArgs(ctx);
    const root = await resolveGitRoot(ctx);
    const step1 = await runFirstAgent(ctx, input);
    const step2 = await runSecondAgent(ctx, step1);
    return buildSummary(input, root, step1, step2);
  },
} satisfies OrchestratorScript;
```
