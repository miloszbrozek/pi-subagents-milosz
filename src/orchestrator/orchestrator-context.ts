/**
 * orchestrator-context.ts
 *
 * Interfejs i implementacja OrchestratorContext — API które dostaje skrypt
 * uruchamiany przez /pi-orch. Pozwala programatycznie odpalać subagentów
 * i budować dynamiczne flowy z poziomu TypeScriptu.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema, Static } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { Details, JsonSchemaObject, SingleResult } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import {
	captureWorktreeDiff,
	cleanupWorktrees,
	createSingleWorktree,
	resolveRepoState,
	type WorktreeSetup,
} from "../runs/shared/worktree.ts";

// ── Interfejs dla skryptów użytkownika ──────────────────────────────────

/** Ustawienia flowu — skrypt może je wyeksportować jako settings */
export interface OrchestratorSettings {
}

/** Kształt eksportu skryptu orchestratora */
export interface OrchestratorScript {
	/** Główna funkcja flowu */
	flow: (ctx: OrchestratorContext) => Promise<{ output: string }>;
	/** Opcjonalne ustawienia */
	settings?: OrchestratorSettings;
}

/** Błąd rzucany przez runAgent gdy agent zakończy się z exitCode !== 0 */
export class OrchestratorAgentError extends Error {
	result: OrchestratorRunAgentResult;
	constructor(message: string, result: OrchestratorRunAgentResult) {
		super(message);
		this.name = "OrchestratorAgentError";
		this.result = result;
	}
}

export interface OrchestratorRunAgentConfig<S extends TSchema = TSchema> extends Omit<SubagentParamsLike, 'outputSchema'> {
	/** Nazwa agenta (zawężone do required) */
	agent: string;
	/** Zadanie (zawężone do required) */
	task: string;
	/** Opcjonalny identyfikator kroku (np. "scan", "plan") — zapisywany w flow.json */
	as?: string;
	/** Czytelna etykieta kroku (np. "Skanowanie kodu") — używana w logach i podsumowaniu */
	label?: string;
	/** Pliki do przeczytania przed wykonaniem — wstrzykiwane jako prefix [Read from: ...] */
	reads?: string[];
	/** Jeśli true, nie rzuca wyjątku przy exitCode !== 0 — zwraca wynik normalnie */
	doNotThrowOnError?: boolean;
	/** TypeBox schema lub JSON Schema dla structured output validation */
	outputSchema?: S;
}

export interface OrchestratorRunAgentResult<S extends TSchema = TSchema> {
	exitCode: number;
	output: string;
	structuredOutput?: Static<S>;
	error?: string;
	agent: string;
	/** Token usage z wykonania agenta */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	/** Czas wykonania w ms */
	durationMs?: number;
	/** Model użyty przez agenta */
	model?: string;
	/** Liczba wywołań narzędzi */
	toolCount?: number;
	/** Ścieżka do pliku sesji użytego przez agenta (przydatne do wznowienia sesji przez sessionFile) */
	sessionFile?: string;
}

/** Rezultat bloku worktree zwracany przez runInWorktree */
export interface WorktreeBlockResult {
	/** Diff stat (git diff --stat) */
	diffStat: string;
	/** Liczba zmienionych plików */
	filesChanged: number;
	/** Liczba dodanych linii */
	insertions: number;
	/** Liczba usuniętych linii */
	deletions: number;
	/** Ścieżka do pliku .patch */
	patchPath: string;
	/** Pełna treść patcha */
	patch: string;
}

/** Konfiguracja kroku interaktywnego */
export interface InteractiveStepConfig {
	/** Prompt / pytania do użytkownika (opis tego co ma dostarczyć) */
	prompt: string;
	/** Czytelna etykieta kroku (do logów i flow summary) */
	label?: string;
	/** Nazwa pliku wyjściowego (domyślnie: "interactive-output.md") */
	outputFile?: string;
	/** Nazwa nowego taba zellij (domyślnie: "Orch: Interactive") */
	zellijTabName?: string;
}

/** Pojedynczy krok w flow (agentowy, deterministyczny lub interaktywny) */
export interface OrchestratorStepResult {
	/** Typ kroku */
	type: "agent" | "deterministic" | "interactive";
	/** Numer indeksu */
	index: number;
	/** Etykieta kroku */
	label: string;
	/** Czas trwania w ms */
	durationMs: number;
	/** Exit code (0 = sukces, 1 = błąd) */
	exitCode: number;
	/** Dla agentów: nazwa agenta */
	agent?: string;
	/** Identyfikator logiczny kroku (np. "scan", "plan") — z runAgent config.as */
	as?: string;
	/** Dla agentów: token usage */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	/** Dla agentów: model */
	model?: string;
	/** Dla agentów: liczba wywołań narzędzi */
	toolCount?: number;
	/** Skrócony podgląd wyniku (pierwsze 200 znaków) — do tabeli flow summary */
	outputPreview?: string;
	/** Pełny tekst outputu kroku (dla agentów ze schema: zawiera też sformatowany structured output) */
	output?: string;
	/** Surowy structured output (tylko dla agentów z outputSchema) — do programatycznego dostępu */
	structuredOutput?: unknown;
	/** Ścieżka do pliku sesji użytego przez agenta */
	sessionFile?: string;
	/** Błąd jeśli wystąpił */
	error?: string;
}

/** Konfiguracja retry dla withRetry */
export interface RetryConfig {
	/** Maksymalna liczba prób (włącznie z pierwszą) */
	maxAttempts: number;
	/** Opóźnienie między próbami w ms (domyślnie 1000) */
	delayMs?: number;
	/** Strategia backoff: "fixed" (domyślnie) lub "exponential" */
	backoff?: "fixed" | "exponential";
}

/** Kontekst dostępny wewnątrz bloku withRetry */
export interface RetryContext {
	/** Numer aktualnej próby (0-indexed) */
	attempt: number;
	/** Błąd z poprzedniej próby (undefined przy pierwszej próbie) */
	lastError: OrchestratorAgentError | undefined;
}

/** Kontekst dostępny wewnątrz bloku runInWorktree — to samo co OrchestratorContext z wyjątkiem runInWorktree */
export type WorktreeOrchestratorContext = Omit<OrchestratorContext, "runInWorktree"> & {
	/** Ścieżka do katalogu worktree (to samo co cwd wewnątrz worktree) */
	worktreePath: string;
	/** Ścieżka do pliku .patch (przekazana jawnie przez użytkownika przy wywołaniu runInWorktree) */
	patchPath: string;
};

export interface OrchestratorContext {
	/** Odpal subagenta, czekaj na wynik. Domyślnie rzuca OrchestratorAgentError przy exitCode !== 0 (chyba że doNotThrowOnError: true). */
	runAgent<S extends TSchema = TSchema>(config: OrchestratorRunAgentConfig<S>): Promise<OrchestratorRunAgentResult<S>>;

	/**
	 * Wykonuje blok z automatycznym retry.
	 * Jeśli callback rzuci OrchestratorAgentError, blok jest ponawiany
	 * do maxAttempts razy z konfigurowalnym delay/backoff.
	 * Po wyczerpaniu prób rzuca ostatni błąd.
	 */
	withRetry<T>(config: RetryConfig, fn: (ctx: RetryContext) => Promise<T>): Promise<T>;

	/**
	 * Wykonuje blok agentów wewnątrz jednego git worktree.
	 * Wszystkie wywołania runAgent() wewnątrz callbacku działają na
	 * wspólnym worktree. Po zakończeniu callbacku tworzony jest patch
	 * ze wszystkimi zmianami, a worktree jest usuwany.
	 *
	 * @param patchPath - jawna ścieżka do pliku .patch (absolutna lub względem cwd)
	 * @param fn - callback wykonujący agentów w worktree
	 *
	 * Zwraca wynik callbacku połączony z WorktreeBlockResult.
	 * Jeśli callback rzuci wyjątek, worktree i tak jest sprzątany.
	 */
	runInWorktree<T>(
		patchPath: string,
		fn: (ctx: WorktreeOrchestratorContext) => Promise<T>,
	): Promise<T & WorktreeBlockResult>;

	/** Wspólny katalog chaina (na artifacty, contexty, progress) */
	chainDir: string;
	/** ID runu */
	runId: string;
	/** Working directory */
	cwd: string;
	/** Dodatkowe argumenty przekazane z /pi-orch (po nazwie/ścieżce skryptu) */
	args: string[];
	/** Log do debugu */
	log(message: string): void;

	/**
	 * Wykonuje dowolny krok (deterministyczny, interaktywny, etc.) z etykietą.
	 * Loguje start/koniec, mierzy czas wykonania i dodaje wpis do allSteps.
	 */
	runStep<T>(config: { label: string }, fn: () => Promise<T>): Promise<T>;

	/**
	 * Otwiera nowy tab zellij z interaktywną sesją pi.
	 * Użytkownik pracuje w sesji, a gdy skończy wpisuje /pi-orch-exit.
	 * Po zamknięciu sesji zwraca zawartość zebranego pliku output.
	 */
	interactiveStep(config: InteractiveStepConfig): Promise<string>;

	/** Wszystkie wykonane kroki (agentowe + deterministyczne + interaktywne) — tylko do odczytu */
	readonly allSteps: readonly OrchestratorStepResult[];
}

// ── Implementacja ───────────────────────────────────────────────────────

export interface OrchestratorContextDeps {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	ctx: ExtensionContext;
	chainDir: string;
	runId: string;
	cwd: string;
	args: string[];
}

export function createOrchestratorContext(deps: OrchestratorContextDeps): OrchestratorContext {
	const logPath = path.join(deps.chainDir, "orchestrator.log");
	const stepResultsDir = path.join(deps.chainDir, "step-results");

	let stepIndex = 0;
	const allSteps: OrchestratorStepResult[] = [];

	const pushStep = (step: OrchestratorStepResult) => {
		allSteps.push(step);
		try {
			fs.mkdirSync(stepResultsDir, { recursive: true });
			const fp = path.join(stepResultsDir, `${step.index}.json`);
			fs.writeFileSync(fp, JSON.stringify(step, null, 2), "utf-8");
		} catch {
			// best-effort
		}
	};

	const log = (message: string) => {
		const line = `[${new Date().toISOString()}] ${message}\n`;
		try {
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, line, "utf-8");
		} catch {
			// best-effort
		}
	};

	const runAgent = async <S extends TSchema = TSchema>(config: OrchestratorRunAgentConfig<S>): Promise<OrchestratorRunAgentResult<S>> => {
		const currentIndex = stepIndex++;
		const requestId = `${deps.runId}-step-${currentIndex}`;
		const effectiveCwd = config.cwd ?? deps.cwd;

		// Wyciągnij orchestrator-specific pola, reszta to SubagentParamsLike
		const { label, as: _as, reads, doNotThrowOnError, ...agentParams } = config;

		// Wstrzyknij prefixy [Read from: ...] / [Write to: ...] — dokładnie jak chain
		let taskWithInstructions = config.task;
		if (reads && Array.isArray(reads) && reads.length > 0) {
			const files = reads.map((r: string) =>
				path.isAbsolute(r) ? r : path.join(deps.chainDir, r),
			);
			taskWithInstructions = `[Read from: ${files.join(", ")}]\n\n${taskWithInstructions}`;
		}
		if (config.output && typeof config.output === "string") {
			const outputPath = path.isAbsolute(config.output)
				? config.output
				: path.join(deps.chainDir, config.output);
			taskWithInstructions = `[Write to: ${outputPath}]\n\n${taskWithInstructions}`;
		}

		log(`[step ${currentIndex}] Running agent '${config.agent}'${label ? ` (${label})` : ""}${config.cwd ? ` cwd=${config.cwd}` : ""}`);

		const params: SubagentParamsLike = {
			...agentParams,
			outputSchema: agentParams.outputSchema as JsonSchemaObject | undefined,
			intercomBridgeMode: agentParams.intercomBridgeMode ?? "off",
			task: taskWithInstructions,
			...(effectiveCwd !== deps.cwd ? { cwd: effectiveCwd } : {}),
		};

		const result = await deps.execute(
			requestId,
			params,
			new AbortController().signal,
			undefined,
			deps.ctx,
		);

		const details = result.details as Details | undefined;
		const singleResult: SingleResult | undefined = details?.results?.[0];
		const exitCode = singleResult?.exitCode ?? (result.isError ? 1 : 0);
		const output = singleResult
			? getSingleResultOutput(singleResult)
			: result.content.find((c) => c.type === "text")?.text ?? "";
		const error = singleResult?.error ?? (result.isError ? output : undefined);
		const structuredOutput = singleResult?.structuredOutput;

		// Bogaty log z metrykami
		const usage = singleResult?.usage;
		const totalTokens = usage ? usage.input + usage.output : 0;
		const cost = usage?.cost;
		const durationMs = singleResult?.progressSummary?.durationMs;
		const model = singleResult?.model;
		const toolCount = singleResult?.progressSummary?.toolCount;

		log(`[step ${currentIndex}] Done. exitCode=${exitCode}` +
			(durationMs ? ` duration=${(durationMs / 1000).toFixed(1)}s` : "") +
			(totalTokens ? ` tokens=${totalTokens}` : "") +
			(cost !== undefined && cost !== null ? ` cost=$${cost.toFixed(4)}` : "") +
			(model ? ` model=${model}` : "") +
			(toolCount ? ` tools=${toolCount}` : "") +
			(error ? ` error=${error.slice(0, 100)}` : ""));

		const sessionFile = singleResult?.sessionFile;

		const orchResult: OrchestratorRunAgentResult = {
			exitCode,
			output,
			structuredOutput,
			error,
			agent: config.agent,
			usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost } : undefined,
			durationMs,
			model,
			toolCount,
			sessionFile,
		};

		let agentOutput = output; // pełny tekst z agenta
		if (structuredOutput) {
			agentOutput += "\n\n--- Structured Output ---\n" + JSON.stringify(structuredOutput, null, 2);
		}

		// Dodaj do wspólnego rejestru allSteps
		pushStep({
			type: "agent",
			index: currentIndex,
			label: label ?? config.agent,
			durationMs: durationMs ?? 0,
			exitCode,
			agent: config.agent,
			as: config.as,
			usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost } : undefined,
			model,
			toolCount,
			output: agentOutput,
			outputPreview: agentOutput.slice(0, 200),
			structuredOutput: structuredOutput ?? undefined,
			sessionFile,
			error,
		});

		if (exitCode !== 0 && !doNotThrowOnError) {
			throw new OrchestratorAgentError(
				error ? `Agent '${config.agent}' failed: ${error.slice(0, 200)}` : `Agent '${config.agent}' failed with exit code ${exitCode}`,
				orchResult,
			);
		}

		return orchResult;
	};

	const withRetry = async <T>(
		config: RetryConfig,
		fn: (ctx: RetryContext) => Promise<T>,
	): Promise<T> => {
		const maxAttempts = config.maxAttempts;
		const delayMs = config.delayMs ?? 1000;
		const backoff = config.backoff ?? "fixed";

		let lastError: OrchestratorAgentError | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const result = await fn({ attempt, lastError });
				return result;
			} catch (err) {
				if (err instanceof OrchestratorAgentError) {
					lastError = err;
					if (attempt < maxAttempts - 1) {
						const waitMs = backoff === "exponential"
							? delayMs * Math.pow(2, attempt)
							: delayMs;
						log(`[retry] Attempt ${attempt + 1}/${maxAttempts} failed: ${err.message.slice(0, 100)}. Retrying in ${waitMs}ms...`);
						await new Promise((resolve) => setTimeout(resolve, waitMs));
					}
				} else {
					// Nie-agentowe błędy (timeout, sieć, itp.) propagujemy od razu
					throw err;
				}
			}
		}

		// Wyczerpane próby — rzuć ostatni błąd
		throw lastError!;
	};

	const runInWorktree = async <T>(
		patchPath: string,
		fn: (ctx: WorktreeOrchestratorContext) => Promise<T>,
	): Promise<T & WorktreeBlockResult> => {
		let setup: WorktreeSetup | undefined;
		const resolvedPatchPath = path.isAbsolute(patchPath) ? patchPath : path.resolve(deps.cwd, patchPath);

		try {
			const repo = resolveRepoState(deps.cwd);
			const worktree = createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				deps.runId,
				0,
				repo.baseCommit,
				undefined,
				"orchestrator",
				os.tmpdir(),
			);

			setup = {
				cwd: repo.toplevel,
				worktrees: [worktree],
				baseCommit: repo.baseCommit,
			};

			const worktreeCwd = worktree.agentCwd;
			log(`Worktree created at ${worktree.path} (agent cwd: ${worktreeCwd}, patch: ${resolvedPatchPath})`);

			// Ensure parent dir exists
			try {
				fs.mkdirSync(path.dirname(resolvedPatchPath), { recursive: true });
			} catch {
				// best-effort
			}

			const wtCtx: WorktreeOrchestratorContext = {
				...returnedCtx,
				runAgent: async (config: OrchestratorRunAgentConfig) => {
					return runAgent({ ...config, cwd: config.cwd ?? worktreeCwd });
				},
				runInWorktree: undefined as unknown as OrchestratorContext["runInWorktree"],
				worktreePath: worktreeCwd,
				patchPath: resolvedPatchPath,
			};

			const userResult = await fn(wtCtx);

			// Capture diff to the user-specified patchPath
			const diff = captureWorktreeDiff(setup, worktree, "orchestrator", resolvedPatchPath);
			const patch = (() => {
				try {
					return fs.readFileSync(resolvedPatchPath, "utf-8");
				} catch {
					return "";
				}
			})();

			log(`Worktree diff: ${diff.filesChanged} files, +${diff.insertions} -${diff.deletions}`);

			return {
				...userResult,
				diffStat: diff.diffStat,
				filesChanged: diff.filesChanged,
				insertions: diff.insertions,
				deletions: diff.deletions,
				patchPath: resolvedPatchPath,
				patch,
			};
		} finally {
			if (setup) {
				try {
					cleanupWorktrees(setup);
					log("Worktree cleaned up");
				} catch (error) {
					log(`Worktree cleanup error: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	};

	const runStep = async <T>(stepConfig: { label: string }, fn: () => Promise<T>): Promise<T> => {
		const currentIndex = stepIndex++;
		const startTime = Date.now();
		log(`[step ${currentIndex}] Starting: ${stepConfig.label}`);
		try {
			const result = await fn();
			const durationMs = Date.now() - startTime;
			const duration = (durationMs / 1000).toFixed(1);
			log(`[step ${currentIndex}] Done: ${stepConfig.label} (${duration}s)`);
			const strResult = result == null ? "" : typeof result === "string" ? result : JSON.stringify(result);
			pushStep({
				type: "deterministic",
				index: currentIndex,
				label: stepConfig.label,
				durationMs,
				exitCode: 0,
				output: strResult,
				outputPreview: strResult.slice(0, 200),
			});
			return result;
		} catch (err) {
			const durationMs = Date.now() - startTime;
			const duration = (durationMs / 1000).toFixed(1);
			const errMsg = err instanceof Error ? err.message : String(err);
			log(`[step ${currentIndex}] Failed: ${stepConfig.label} (${duration}s): ${errMsg}`);
			pushStep({
				type: "deterministic",
				index: currentIndex,
				label: stepConfig.label,
				durationMs,
				exitCode: 1,
				error: errMsg,
			});
			throw err;
		}
	};

	const interactiveStepInternal = async (config: InteractiveStepConfig, effectiveCwd?: string): Promise<string> => {
		const outputFile = config.outputFile ?? "interactive-output.md";
		const outputPath = path.resolve(deps.chainDir, outputFile);
		const briefFileName = "interactive-brief.md";
		const briefPath = path.resolve(deps.chainDir, briefFileName);
		const label = config.label ?? "Interactive step";
		const cwd = effectiveCwd ?? deps.cwd;

		// 1. Utwórz plik brief z instrukcjami
		const briefContent = [
			"# Interactive Session",
			"",
			config.prompt,
			"",
			"---",
			"",
			"## Instructions",
			"",
			"1. Work through the task above in this pi session.",
			"2. When you have gathered all necessary information, type `/pi-orch-exit` to save and exit.",
			"3. The session will be saved automatically and the tab will close.",
			"",
		].join("\n");

		fs.mkdirSync(deps.chainDir, { recursive: true });
		fs.writeFileSync(briefPath, briefContent, "utf-8");
		log(`[interactive] Brief written to ${briefPath}`);

		// 2. Uruchom zellij tab z pi (nazwa z suffixem runId dla unikalności)
		const tabName = (config.zellijTabName ?? "Orch: Interactive") + ` (${deps.runId.slice(0, 8)})`;
		const shellCmd = [
			`export ORCH_OUTPUT_FILE="${outputPath}"`,
			`echo ""`,
			`cat "${briefPath}"`,
			`echo ""`,
			`echo "─────────────────────────────────────────────"`,
			`echo "Type /pi-orch-exit when done to save and close."`,
			`echo "─────────────────────────────────────────────"`,
			`echo ""`,
			`exec pi`,
		].join("\n");

		const zellijCmd = [
			"zellij", "action", "new-tab",
			"--close-on-exit",
			"--name", tabName,
			"--cwd", cwd,
			"--", "bash", "-c", shellCmd,
		];

		log(`[interactive] Opening zellij tab: ${tabName}`);

		let tabId: string;
		try {
			tabId = execFileSync(zellijCmd[0]!, zellijCmd.slice(1), {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			log(`[interactive] Tab opened: id=${tabId}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`[interactive] Failed to open zellij tab: ${msg}`);
			if (err && typeof err === "object" && "stderr" in err) {
				const stderr = String((err as { stderr: unknown }).stderr).trim();
				if (stderr) log(`[interactive] Zellij stderr: ${stderr}`);
			}
			throw new Error(`Failed to open zellij tab: ${msg}`);
		}

		if (!tabId) {
			throw new Error("Zellij did not return a tab ID");
		}

		// 3. Polluj aż karta zniknie
		const pollIntervalMs = 500;
		const pollStart = Date.now();
		while (true) {
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

			try {
				const tabs = execFileSync("zellij", ["action", "list-tabs"], {
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
				const tabExists = tabs.split("\n").some((line) => line.startsWith(tabId + " "));
				if (!tabExists) {
					log(`[interactive] Tab ${tabId} closed`);
					break;
				}
			} catch {
				log(`[interactive] list-tabs failed, assuming tab ${tabId} closed`);
				break;
			}
		}

		// 3. Sprawdź czy plik output istnieje
		if (!fs.existsSync(outputPath)) {
			throw new Error(
				`Interactive step "${label}" completed but no output file was created at ${outputPath}. ` +
				"Make sure you typed /pi-orch-exit in the pi session before closing the tab.",
			);
		}

		// 4. Odczytaj i zwróć zawartość
		const content = fs.readFileSync(outputPath, "utf-8");
		const sizeKB = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);
		log(`[interactive] Output: ${sizeKB} KB from ${outputPath}`);

		return content;
	};

	const interactiveStepWrapped = async (config: InteractiveStepConfig): Promise<string> => {
		const currentIndex = stepIndex++;
		const label = config.label ?? "Interactive step";
		const startTime = Date.now();
		log(`[step ${currentIndex}] Interactive step starting: ${label}`);
		try {
			const result = await interactiveStepInternal(config);
			const durationMs = Date.now() - startTime;
			log(`[step ${currentIndex}] Interactive step done: ${label} (${(durationMs / 1000).toFixed(1)}s)`);
			pushStep({
				type: "interactive",
				index: currentIndex,
				label,
				durationMs,
				exitCode: 0,
				output: result,
				outputPreview: result.slice(0, 200),
			});
			return result;
		} catch (err) {
			const durationMs = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			log(`[step ${currentIndex}] Interactive step failed: ${label} (${(durationMs / 1000).toFixed(1)}s): ${errMsg}`);
			pushStep({
				type: "interactive",
				index: currentIndex,
				label,
				durationMs,
				exitCode: 1,
				error: errMsg,
			});
			throw err;
		}
	};

	const returnedCtx = {
		runAgent,
		withRetry,
		runInWorktree: undefined as unknown as OrchestratorContext["runInWorktree"],
		runStep,
		interactiveStep: interactiveStepWrapped,
		chainDir: deps.chainDir,
		runId: deps.runId,
		cwd: deps.cwd,
		args: deps.args,
		log,
		get allSteps(): readonly OrchestratorStepResult[] {
			return allSteps;
		},
	};

	// Przypisz runInWorktree po tym jak returnedCtx już istnieje (potrzebuje referencji do siebie)
	const runInWorktreeFinal = runInWorktree;
	(returnedCtx as { runInWorktree: OrchestratorContext["runInWorktree"] }).runInWorktree = runInWorktreeFinal as OrchestratorContext["runInWorktree"];

	return returnedCtx as OrchestratorContext;
}
