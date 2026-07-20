/**
 * orchestrator-bridge.ts
 *
 * Mostek między slash commandem /pi-orch a subagent executorem.
 * Wzorzec identyczny z slash-bridge.ts.
 *
 * Nasłuchuje ORCHESTRATOR_REQUEST_EVENT, ładuje skrypt .ts przez jiti,
 * tworzy OrchestratorContext z dostępem do executora, uruchamia skrypt,
 * wysyła wynik przez ORCHESTRATOR_RESPONSE_EVENT.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti/static";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { persistOrchSessionSnapshot } from "./orchestrator-session.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import {
	ORCHESTRATOR_REQUEST_EVENT,
	ORCHESTRATOR_RESPONSE_EVENT,
	ORCHESTRATOR_UPDATE_EVENT,
	type Details,
} from "../shared/types.ts";
import { createOrchestratorContext, OrchestratorAgentError, type OrchestratorContext, type OrchestratorRunAgentResult, type OrchestratorScript, type OrchestratorStepResult } from "./orchestrator-context.ts";

// ── Typy ────────────────────────────────────────────────────────────────

interface OrchestratorRequest {
	requestId: string;
	scriptPath: string;
	args?: string[];
}

interface OrchestratorResponse {
	requestId: string;
	output: string;
	results: OrchestratorStepResult[];
	allSteps?: OrchestratorStepResult[];
	error?: string;
	flowSummary?: string;
}

interface OrchestratorUpdate {
	requestId: string;
	step: number;
	agent: string;
	status: "running" | "completed" | "failed";
}

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface OrchestratorBridgeOptions {
	events: EventBus;
	getContext: () => ExtensionContext | null;
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
}

// ── Helpers (exported for testing) ─────────────────────────────────────

export function loadStepResults(dir: string): OrchestratorStepResult[] {
	const resultsDir = path.join(dir, "step-results");
	const results: OrchestratorStepResult[] = [];
	try {
		if (!fs.existsSync(resultsDir)) return results;
		const files = fs.readdirSync(resultsDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => parseInt(f.replace(".json", ""), 10))
			.filter((n) => !isNaN(n))
			.sort((a, b) => a - b);
		for (const idx of files) {
			try {
				const raw = fs.readFileSync(path.join(resultsDir, `${idx}.json`), "utf-8");
				results.push(JSON.parse(raw) as OrchestratorStepResult);
			} catch {
				// best-effort per file
			}
		}
	} catch {
		// best-effort
	}
	return results;
}

const TYPE_ICONS: Record<OrchestratorStepResult["type"], string> = {
	agent: "🤖",
	deterministic: "⚙️",
	interactive: "👤",
};

const TYPE_LABELS: Record<OrchestratorStepResult["type"], string> = {
	agent: "Agent",
	deterministic: "Deterministic",
	interactive: "Interactive",
};

export function generateFlowSummary(
	scriptPath: string,
	runId: string,
	steps: OrchestratorStepResult[],
	dir: string,
	status: "success" | "failed",
	errorMsg?: string,
): string {
	try {
		const statusIcon = status === "success" ? "✅ Success" : "❌ Failed";

		const totalDuration = steps.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
		const totalTokens = steps.reduce((sum, r) => sum + ((r.usage?.input ?? 0) + (r.usage?.output ?? 0)), 0);
		const totalCost = steps.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
		const agentSteps = steps.filter((s) => s.type === "agent");

		const mdLines = [
			`# Orchestrator Flow: ${path.basename(scriptPath)}`,
			"",
			`**Run ID**: ${runId}`,
			`**Status**: ${statusIcon} | **Duration**: ${(totalDuration / 1000).toFixed(1)}s | **Steps**: ${steps.length}`,
		];
		if (agentSteps.length > 0) {
			mdLines.push(`**Tokens**: ${totalTokens} | **Cost**: $${totalCost.toFixed(4)}`);
		}
		if (errorMsg) {
			mdLines.push(`**Error**: ${errorMsg}`);
		}

		if (steps.length > 0) {
			mdLines.push(
				"",
				"| # | Step | Type | Exit | Duration | Tokens | Cost | Model |",
				"|---|------|------|------|----------|--------|------|-------|",
			);

			for (const s of steps) {
				const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "-";
				const tok = s.type === "agent"
					? ((s.usage?.input ?? 0) + (s.usage?.output ?? 0)) || "-"
					: "-";
				const cost = s.type === "agent" && s.usage?.cost != null
					? `$${s.usage.cost.toFixed(4)}`
					: "-";
				const icon = s.exitCode === 0 ? "✅" : "❌";
				const typeStr = `${TYPE_ICONS[s.type]} ${TYPE_LABELS[s.type]}${s.type === "agent" && s.agent ? ` (${s.agent})` : ""}`;
				mdLines.push(`| ${s.index} | ${s.label} | ${typeStr} | ${icon} | ${dur} | ${tok} | ${cost} | ${s.model ?? "-"} |`);
			}
		}

		mdLines.push("", `📁 **Chain dir**: ${dir}`);
		return mdLines.join("\n") + "\n";
	} catch {
		return `# Orchestrator Flow: ${path.basename(scriptPath)}\n\n**Run ID**: ${runId}\n**Status**: ❌ Failed\n\n📁 **Chain dir**: ${dir}\n`;
	}
}

// ── Bridge ──────────────────────────────────────────────────────────────

/** Synchronizuje flow.json z aktualnym stanem allSteps (przyrostowo) */
function syncFlowJsonFromAllSteps(
	chainDir: string,
	requestId: string,
	resolvedPath: string,
	flowStartTime: string,
	orchestratorCtx: OrchestratorContext,
): void {
	try {
		const flowPath = path.join(chainDir, "orchestrator-flow.json");
		let flow: { runId: string; scriptPath: string; startTime: string; steps: unknown[] };
		if (fs.existsSync(flowPath)) {
			flow = JSON.parse(fs.readFileSync(flowPath, "utf-8"));
		} else {
			flow = { runId: requestId, scriptPath: resolvedPath, startTime: flowStartTime, steps: [] };
		}
		// Nadpisz steps z allSteps
		flow.steps = orchestratorCtx.allSteps.map((s) => ({
			index: s.index,
			type: s.type,
			label: s.label,
			as: s.as,
			exitCode: s.exitCode,
			durationMs: s.durationMs,
			agent: s.agent,
			usage: s.usage,
			model: s.model,
			toolCount: s.toolCount,
			outputPreview: s.outputPreview,
			output: s.output,
			structuredOutput: s.structuredOutput,
			error: s.error,
		}));
		fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2), "utf-8");
	} catch {
		// best-effort
	}
}

export function registerOrchestratorBridge(options: OrchestratorBridgeOptions): {
	dispose: () => void;
} {
	const subscriptions: Array<() => void> = [];

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(ORCHESTRATOR_REQUEST_EVENT, async (data) => {
		if (!data || typeof data !== "object") return;
		const request = data as Partial<OrchestratorRequest>;
		if (typeof request.requestId !== "string" || typeof request.scriptPath !== "string") return;
		const { requestId, scriptPath, args } = request as OrchestratorRequest;

		const ctx = options.getContext();
		if (!ctx) {
			const response: OrchestratorResponse = {
				requestId,
				output: "No active extension context for orchestrator execution.",
				results: [],
				error: "No active extension context.",
			};
			options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
			return;
		}

		// Persist session snapshot so agents can fork the parent session
		persistOrchSessionSnapshot(ctx);

		let chainDir: string | undefined;
		let orchestratorCtx: OrchestratorContext | undefined;

		// Rozwiąż ścieżkę
		const resolvedPath = path.isAbsolute(scriptPath)
			? scriptPath
			: path.resolve(ctx.cwd, scriptPath);

		try {

			if (!fs.existsSync(resolvedPath)) {
				const response: OrchestratorResponse = {
					requestId,
					output: `Script not found: ${resolvedPath}`,
					results: [],
					error: `Script not found: ${resolvedPath}`,
				};
				options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
				return;
			}

			// Stwórz chainDir
			chainDir = path.join(path.dirname(resolvedPath), ".pi-orch-runs", requestId);
			fs.mkdirSync(chainDir, { recursive: true });

			// Załaduj skrypt — format: export default { flow, settings? }
			const jiti = createJiti(import.meta.url, { interopDefault: true, cache: false });
			// Cache-buster zapewnia rekompilację przy każdym wywołaniu
			const importPath = `${resolvedPath}?update=${Date.now()}`;
			const mod = await jiti.import(importPath, { default: true });
			let script: OrchestratorScript;
			if (mod && typeof mod === "object" && typeof (mod as Record<string, unknown>).flow === "function") {
				script = mod as OrchestratorScript;
			} else {
				throw new Error(`Script ${resolvedPath} did not export a valid flow function.`);
			}

			orchestratorCtx = createOrchestratorContext({
				execute: options.execute,
				ctx,
				chainDir,
				runId: requestId,
				cwd: ctx.cwd,
				args: args ?? [],
			});

			const flowStartTime = new Date().toISOString();

			// Owiń runAgent żeby auto-logować, pisać flow.json i wysyłać update'y
			const originalRunAgent = orchestratorCtx.runAgent.bind(orchestratorCtx);
			orchestratorCtx.runAgent = async (config) => {
				const stepIndex = orchestratorCtx.allSteps.length;

				// Auto-log startu (infrastruktura, nie skrypt)
				orchestratorCtx.log(`[step ${stepIndex}] Agent '${config.agent}'${config.label ? ` (${config.label})` : ""} starting`);

				options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
					requestId,
					step: stepIndex,
					agent: config.agent,
					status: "running",
				} as OrchestratorUpdate);

				const stepStart = Date.now();
				let failedError: OrchestratorAgentError | undefined;
				let result: OrchestratorRunAgentResult;
				try {
					result = await originalRunAgent(config);
				} catch (err) {
					if (err instanceof OrchestratorAgentError) {
						result = err.result;
						failedError = err;
					} else {
						throw err;
					}
				}

				options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
					requestId,
					step: stepIndex,
					agent: config.agent,
					status: result.exitCode === 0 ? "completed" : "failed",
				} as OrchestratorUpdate);

				// Zapis flow.json — przyrostowo po każdym kroku (z allSteps)
				syncFlowJsonFromAllSteps(chainDir, requestId, resolvedPath, flowStartTime, orchestratorCtx);

				if (failedError) {
					throw failedError;
				}

				return result;
			};

			// Owiń runStep żeby wysyłać update'y dla kroków nie-agentowych
			const originalRunStep = orchestratorCtx.runStep.bind(orchestratorCtx);
			orchestratorCtx.runStep = async <T>(stepConfig: { label: string }, fn: () => Promise<T>): Promise<T> => {
				const stepIndex = orchestratorCtx.allSteps.length;
				orchestratorCtx.log(`[step ${stepIndex}] Step '${stepConfig.label}' starting`);

				options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
					requestId,
					step: stepIndex,
					agent: stepConfig.label,
					status: "running",
				} as OrchestratorUpdate);

				try {
					const result = await originalRunStep(stepConfig, fn);
					options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
						requestId,
						step: stepIndex,
						agent: stepConfig.label,
						status: "completed",
					} as OrchestratorUpdate);
					syncFlowJsonFromAllSteps(chainDir, requestId, resolvedPath, flowStartTime, orchestratorCtx);
					return result;
				} catch (err) {
					options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
						requestId,
						step: stepIndex,
						agent: stepConfig.label,
						status: "failed",
					} as OrchestratorUpdate);
					syncFlowJsonFromAllSteps(chainDir, requestId, resolvedPath, flowStartTime, orchestratorCtx);
					throw err;
				}
			};

			orchestratorCtx.log("Script loaded, executing...");

			const scriptResult = await script.flow(orchestratorCtx);

			const flowEndTime = new Date().toISOString();
			const allSteps = [...orchestratorCtx.allSteps];

			// Finalizuj flow.json
			const flowFp = path.join(chainDir, "orchestrator-flow.json");
			try {
				if (fs.existsSync(flowFp)) {
					const flow = JSON.parse(fs.readFileSync(flowFp, "utf-8"));
					flow.endTime = flowEndTime;
					flow.status = "success";
					flow.totalDurationMs = allSteps.reduce((sum: number, s) => sum + (s.durationMs ?? 0), 0);
					fs.writeFileSync(flowFp, JSON.stringify(flow, null, 2), "utf-8");
				}
			} catch {
				// best-effort
			}

			// Wygeneruj flow-summary.md z allSteps
			const flowSummaryMd = generateFlowSummary(resolvedPath, requestId, allSteps, chainDir, "success");
			try { fs.writeFileSync(path.join(chainDir, "flow-summary.md"), flowSummaryMd, "utf-8"); } catch { /* best-effort */ }

			const output = scriptResult.output || "Orchestrator completed.";
			const response: OrchestratorResponse = {
				requestId,
				output,
				results: allSteps,
				allSteps,
				flowSummary: flowSummaryMd,
			};
			options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : "";

			// Zapisz flow.json z errorem (utwórz jeśli nie istnieje)
			let flowSummaryMd: string | undefined;
			let effectiveAllSteps: OrchestratorStepResult[] = [];
			if (chainDir) {
				const flowFp2 = path.join(chainDir, "orchestrator-flow.json");
				try {
					let flow: { runId: string; scriptPath: string; startTime: string; steps: unknown[] };
					if (fs.existsSync(flowFp2)) {
						flow = JSON.parse(fs.readFileSync(flowFp2, "utf-8"));
					} else {
						flow = { runId: requestId, scriptPath: resolvedPath, startTime: new Date().toISOString(), steps: [] };
					}
					flow.endTime = new Date().toISOString();
					flow.status = "failed";
					flow.error = message;
					fs.writeFileSync(flowFp2, JSON.stringify(flow, null, 2), "utf-8");
				} catch {
					// best-effort
				}

			// Odtwórz allSteps z plików step-results/ jeśli bridge ich nie zdążył zapisać
				const stepResults = loadStepResults(chainDir);
				effectiveAllSteps = (orchestratorCtx && orchestratorCtx.allSteps.length > 0) ? [...orchestratorCtx.allSteps] : stepResults;

				// Generuj flowSummary nawet przy failu
				flowSummaryMd = generateFlowSummary(resolvedPath, requestId, effectiveAllSteps, chainDir, "failed", message);
				try { fs.writeFileSync(path.join(chainDir, "flow-summary.md"), flowSummaryMd, "utf-8"); } catch { /* best-effort */ }
			}

			const response: OrchestratorResponse = {
				requestId,
				output: `Orchestrator failed:\n${message}\n\n${stack}`,
				results: effectiveAllSteps,
				allSteps: effectiveAllSteps,
				error: message,
				flowSummary: flowSummaryMd,
			};
			options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
		}
	});

	return {
		dispose: () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
		},
	};
}
