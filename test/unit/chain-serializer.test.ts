import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChain, parseJsonChain, serializeChain, serializeJsonChain } from "../../src/agents/chain-serializer.ts";

const chainContent = `---
name: review-chain
description: Review chain
---

## reviewer
output: report.md
outputMode: file-only

Review the diff
`;

describe("chain serializer", () => {
	it("round-trips step outputMode", () => {
		const parsed = parseChain(chainContent, "project", "/tmp/review-chain.md");

		assert.equal(parsed.steps[0]?.outputMode, "file-only");
		assert.match(serializeChain(parsed), /outputMode: file-only/);
	});

	it("round-trips phase, label, as, and path-based outputSchema", () => {
		const parsed = parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
phase: Review
label: correctness pass
as: correctnessFindings
outputSchema: ./schemas/finding.schema.json

Review the diff
`, "project", "/tmp/review-chain.md");

		assert.equal(parsed.steps[0]?.phase, "Review");
		assert.equal(parsed.steps[0]?.label, "correctness pass");
		assert.equal(parsed.steps[0]?.as, "correctnessFindings");
		assert.equal(parsed.steps[0]?.outputSchema, "./schemas/finding.schema.json");
		const serialized = serializeChain(parsed);
		assert.match(serialized, /phase: Review/);
		assert.match(serialized, /label: correctness pass/);
		assert.match(serialized, /as: correctnessFindings/);
		assert.match(serialized, /outputSchema: \.\/schemas\/finding\.schema\.json/);
	});

	it("rejects inline outputSchema values in markdown chains", () => {
		assert.throws(
			() => parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
outputSchema: {"type":"object"}

Review the diff
`, "project", "/tmp/review-chain.md"),
			/Inline outputSchema values are not supported/,
		);
	});

	it("rejects invalid dynamic JSON chains with useful diagnostics", () => {
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-dynamic-review",
				description: "Bad dynamic targets",
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
						parallel: [{ agent: "reviewer", task: "Review" }],
						collect: { as: "reviews" },
					},
				],
			}), "project", "/tmp/bad-dynamic-review.chain.json"),
			/static parallel arrays/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({ name: "bad", description: "Bad", chain: [1] }), "project", "/tmp/bad.chain.json"),
			/step 1 must be an object/,
		);
	});

	it("serializes JSON chains back to JSON", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "dynamic-review",
			package: "code-analysis",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "project", "/tmp/dynamic-review.chain.json");

		const serialized = serializeJsonChain(parsed);
		assert.doesNotMatch(serialized, /^---/);
		const reparsed = JSON.parse(serialized) as { name?: string; package?: string; chain?: Array<{ collect?: { as?: string } }> };
		assert.equal(reparsed.name, "dynamic-review");
		assert.equal(reparsed.package, "code-analysis");
		assert.equal(reparsed.chain?.[1]?.collect?.as, "reviews");
	});

	it("parses declarative JSON chains with dynamic fanout", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "project", "/tmp/dynamic-review.chain.json");

		assert.equal(parsed.name, "dynamic-review");
		assert.equal(parsed.steps.length, 2);
		assert.deepEqual((parsed.steps[1] as { collect?: { as?: string } }).collect, { as: "reviews" });
		assert.deepEqual((parsed.steps[0] as { outputSchema?: unknown }).outputSchema, { type: "object" });
	});

	it("parses and validates acceptance in JSON chains", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "accepted-chain",
			description: "Chain with acceptance gates",
			chain: [
				{ agent: "worker", task: "Fix bug", acceptance: { level: "checked", evidence: ["changed-files", "commands-run"] } },
				{
					parallel: [
						{ agent: "reviewer", task: "Review", acceptance: "attested" },
					],
				},
			],
		}), "project", "/tmp/accepted-chain.chain.json");

		assert.deepEqual((parsed.steps[0] as { acceptance?: unknown }).acceptance, { level: "checked", evidence: ["changed-files", "commands-run"] });
		assert.equal(((parsed.steps[1] as { parallel?: Array<{ acceptance?: unknown }> }).parallel?.[0]?.acceptance), "attested");
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-acceptance",
				description: "Bad acceptance",
				chain: [{ agent: "worker", acceptance: { level: "none" } }],
			}), "project", "/tmp/bad-acceptance.chain.json"),
			/step 1 acceptance\.reason is required/,
		);
	});

	it("parses chainDir from JSON chain", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "with-dir",
			description: "Chain with chainDir",
			chainDir: "./tmp/chain-runs",
			chain: [{ agent: "delegate", task: "Test" }],
		}), "project", "/tmp/with-dir.chain.json");

		assert.equal(parsed.chainDir, "./tmp/chain-runs");
		assert.equal(parsed.extraFields, undefined);
	});

	it("round-trips chainDir in JSON chain", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "with-dir",
			description: "Chain with chainDir",
			chainDir: "./tmp/chain-runs",
			chain: [{ agent: "delegate", task: "Test" }],
		}), "project", "/tmp/with-dir.chain.json");

		const serialized = serializeJsonChain(parsed);
		assert.match(serialized, /"chainDir": "\.\/tmp\/chain-runs"/);
		const reparsed = parseJsonChain(serialized, "project", "/tmp/with-dir.chain.json");
		assert.equal(reparsed.chainDir, "./tmp/chain-runs");
	});

	it("parses chainDir from markdown chain", () => {
		const parsed = parseChain(`---
name: md-chain
chainDir: ./tmp/chain-runs
description: Markdown chain with chainDir
---

## delegate
output: test.txt

Test task
`, "project", "/tmp/md-chain.chain.md");

		assert.equal(parsed.chainDir, "./tmp/chain-runs");
		assert.match(serializeChain(parsed), /chainDir: \.\/tmp\/chain-runs/);
	});

	it("chainDir absent when not provided", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "no-dir",
			description: "Chain without chainDir",
			chain: [{ agent: "delegate", task: "Test" }],
		}), "project", "/tmp/no-dir.chain.json");

		assert.equal(parsed.chainDir, undefined);
	});
});
