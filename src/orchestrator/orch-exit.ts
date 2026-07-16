/**
 * orch-exit.ts
 *
 * Rejestruje:
 * - tool "orch_save_and_exit": zapisuje sformatowany markdown do ORCH_OUTPUT_FILE i wywołuje shutdown
 * - komendę "/pi-orch-exit": prosi LLM o sformatowanie sesji i wywołanie orch_save_and_exit
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerOrchExit(pi: ExtensionAPI): void {
	// ── Tool: orch_save_and_exit ──────────────────────────────────
	pi.registerTool({
		name: "orch_save_and_exit",
		label: "Save and Exit",
		description:
			"Save the formatted session content to the output file and exit pi. " +
			"Call this tool ONLY after the user has explicitly typed /pi-orch-exit. " +
			"Format the entire conversation into a well-structured Markdown document first, " +
			"then pass it as the content parameter.",
		promptSnippet: "Save formatted session as Markdown and exit pi",
		parameters: Type.Object({
			content: Type.String({
				description:
					"The full session conversation formatted as a well-structured Markdown document",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const outputFile = process.env["ORCH_OUTPUT_FILE"];
			if (!outputFile) {
				throw new Error(
					"ORCH_OUTPUT_FILE environment variable is not set. " +
						"This tool should only be called from an orchestrator interactive session.",
				);
			}

			fs.mkdirSync(path.dirname(outputFile), { recursive: true });
			fs.writeFileSync(outputFile, params.content, "utf-8");

			const sizeKB = (Buffer.byteLength(params.content, "utf-8") / 1024).toFixed(1);
			ctx.ui.notify(`Session saved (${sizeKB} KB). Exiting...`, "info");

			// Graceful shutdown — zamyka pi, co powoduje zamknięcie zellij tab
			ctx.shutdown();

			return {
				content: [{ type: "text", text: `Session saved to ${outputFile} (${sizeKB} KB). Exiting...` }],
				details: {},
			};
		},
	});

	// ── Command: /pi-orch-exit ──────────────────────────────────────
	pi.registerCommand("pi-orch-exit", {
		description: "Save current session as Markdown and exit",
		handler: async (_args, ctx) => {
			const outputFile = process.env["ORCH_OUTPUT_FILE"];

			pi.sendUserMessage(
				[
					"Format the ENTIRE conversation from this session into a well-structured Markdown document.",
					"Include all user questions, your findings, the information gathered, decisions made, and conclusions.",
					"",
					"After formatting, call the tool `orch_save_and_exit` with the formatted content.",
					"",
					outputFile
						? `The output will be saved to: ${outputFile}`
						: "The output path is set via ORCH_OUTPUT_FILE environment variable.",
				].join("\n"),
			);
		},
	});
}
