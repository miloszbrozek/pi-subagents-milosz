/**
 * DeterminatorScript — interfejs dla skryptów uruchamianych przez agenta "determinator".
 *
 * Każdy skrypt .ts podpinany do determinatora musi implementować ten interfejs:
 * eksportować domyślnie funkcję typu DeterminatorScript.
 */

import type { StepContext } from "../runs/shared/step-context.ts";

export interface DeterminatorContext {
  /** Wszystkie pola z context.json (1:1) */
  stepContext: StepContext;
  /** Working directory */
  cwd: string;
  /** Dodatkowe parametry (z JSON-a w tasku, pole "params") */
  params: Record<string, unknown>;

  /** Loguj wiadomość (zapisuje do determinator-debug.log w chainDir) */
  log(message: string): void;

  /** Wykonaj komendę shella */
  exec(command: string): Promise<{ stdout: string; stderr: string }>;

  /** Odczytaj plik jako string */
  readFile(path: string): Promise<string>;

  /** Zapisz plik */
  writeFile(path: string, content: string): Promise<void>;

  /** Odczytaj StepContext innego stepu w chainie (null gdy nie znaleziono) */
  getStepContext(stepIndex: number): StepContext | null;
}

export interface DeterminatorResult {
  /** Kod wyjścia (0 = sukces) */
  exitCode: number;
  /** Tekst outputu */
  output: string;
  /** Opcjonalny komunikat błędu */
  error?: string;
}

export type DeterminatorScript = (
  ctx: DeterminatorContext,
) => Promise<DeterminatorResult>;
