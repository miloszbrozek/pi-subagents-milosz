import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { findContextFile, loadContextFile, getStepContextFile } from "../../src/determinator/extension.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "determinator-test-"));
  tempDirs.push(dir);
  return dir;
}

// ── findContextFile / loadContextFile ───────────────────────────────────────

describe("findContextFile", () => {
  it("returns null when chainDir does not exist", () => {
    const result = findContextFile("/nonexistent/dir", "run-123");
    assert.equal(result, null);
  });

  it("finds context file by runId prefix", () => {
    const dir = makeTempDir();
    const contextFile = path.join(dir, "run-abc_scout_0_context.json");
    fs.writeFileSync(contextFile, "{}", "utf-8");
    fs.writeFileSync(path.join(dir, "other-file.txt"), "x", "utf-8");

    const result = findContextFile(dir, "run-abc");
    assert.ok(result);
    assert.ok(result!.endsWith("run-abc_scout_0_context.json"));
  });

  it("returns null when no context file matches runId", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "run-xyz_worker_1_context.json"),
      "{}",
      "utf-8",
    );

    const result = findContextFile(dir, "run-abc");
    assert.equal(result, null);
  });
});

describe("loadContextFile", () => {
  it("parses a valid context.json and returns StepContext", () => {
    const dir = makeTempDir();
    const contextFile = path.join(dir, "r1_determinator_0_context.json");
    const contextData = {
      chain_dir: dir,
      step_index: 0,
      agent: "determinator",
      output: path.join(dir, "output.md"),
      reads: [path.join(dir, "input.md")],
      run_id: "r1",
      artifacts_dir: path.join(dir, "artifacts"),
      sessionFile: path.join(dir, "session.jsonl"),
    };
    fs.writeFileSync(contextFile, JSON.stringify(contextData), "utf-8");

    const result = loadContextFile(dir, "r1");
    assert.ok(result);
    assert.equal(result!.chain_dir, dir);
    assert.equal(result!.agent, "determinator");
    assert.equal(result!.output, path.join(dir, "output.md"));
    assert.deepEqual(result!.reads, [path.join(dir, "input.md")]);
  });

  it("returns null for invalid JSON", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "r2_determinator_0_context.json"),
      "not json {{{",
      "utf-8",
    );

    const result = loadContextFile(dir, "r2");
    assert.equal(result, null);
  });
});

// ── getStepContextFile ─────────────────────────────────────────────────────

describe("getStepContextFile", () => {
  it("returns StepContext for existing step by index", () => {
    const dir = makeTempDir();
    const runId = "run-getstep-1";
    const contextFile = path.join(dir, `${runId}_scout_0_context.json`);
    const contextData = {
      chain_dir: dir,
      step_index: 0,
      agent: "scout",
      reads: ["plan.md"],
      run_id: runId,
      artifacts_dir: dir,
    };
    fs.writeFileSync(contextFile, JSON.stringify(contextData), "utf-8");

    const result = getStepContextFile(dir, runId, 0);
    assert.ok(result);
    assert.equal(result!.step_index, 0);
    assert.equal(result!.agent, "scout");
  });

  it("returns null when step with given index does not exist", () => {
    const dir = makeTempDir();
    const runId = "run-getstep-2";
    fs.writeFileSync(
      path.join(dir, `${runId}_scout_0_context.json`),
      JSON.stringify({ chain_dir: dir, step_index: 0, agent: "scout", reads: [], run_id: runId, artifacts_dir: dir }),
      "utf-8",
    );

    const result = getStepContextFile(dir, runId, 5);
    assert.equal(result, null);
  });

  it("returns null when runId does not match any file", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "other-run_scout_0_context.json"),
      "{}",
      "utf-8",
    );

    const result = getStepContextFile(dir, "nonexistent-run", 0);
    assert.equal(result, null);
  });

  it("returns null for invalid JSON in context file", () => {
    const dir = makeTempDir();
    const runId = "run-getstep-4";
    fs.writeFileSync(
      path.join(dir, `${runId}_worker_1_context.json`),
      "not valid json {{{",
      "utf-8",
    );

    const result = getStepContextFile(dir, runId, 1);
    assert.equal(result, null);
  });

  it("returns correct step for a later index among multiple steps", () => {
    const dir = makeTempDir();
    const runId = "run-getstep-5";
    fs.writeFileSync(path.join(dir, `${runId}_scout_0_context.json`), JSON.stringify({ step_index: 0, agent: "scout", reads: [], run_id: runId, artifacts_dir: dir, chain_dir: dir }), "utf-8");
    fs.writeFileSync(path.join(dir, `${runId}_planner_1_context.json`), JSON.stringify({ step_index: 1, agent: "planner", reads: [], run_id: runId, artifacts_dir: dir, chain_dir: dir }), "utf-8");
    fs.writeFileSync(path.join(dir, `${runId}_worker_2_context.json`), JSON.stringify({ step_index: 2, agent: "worker", reads: [], run_id: runId, artifacts_dir: dir, chain_dir: dir }), "utf-8");

    const result = getStepContextFile(dir, runId, 2);
    assert.ok(result);
    assert.equal(result!.step_index, 2);
    assert.equal(result!.agent, "worker");
  });

  it("returns null when directory does not exist", () => {
    const result = getStepContextFile("/nonexistent/dir/12345", "run-xyz", 0);
    assert.equal(result, null);
  });
});
