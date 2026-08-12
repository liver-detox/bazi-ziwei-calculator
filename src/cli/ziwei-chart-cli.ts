import fs from "node:fs";
import path from "node:path";

import {
  createLegacyZiweiChartOutput,
  legacyZiweiChartUsage,
  type LegacyZiweiChartOptions
} from "./ziwei-chart-core.ts";

interface WritableTextStream {
  write(content: string): unknown;
}

export interface LegacyZiweiCliRuntime {
  stdout: WritableTextStream;
  stderr: WritableTextStream;
}

function writeChartOutput(content: string, outPath: string, runtime: LegacyZiweiCliRuntime): void {
  if (!outPath) {
    runtime.stdout.write(`${content}\n`);
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${content}\n`, "utf8");
}

export function runLegacyZiweiChartCli(
  argv: readonly string[],
  runtime: LegacyZiweiCliRuntime = process,
  options: LegacyZiweiChartOptions = {}
): number {
  try {
    const output = createLegacyZiweiChartOutput(argv, options);
    if (output.kind === "help") {
      runtime.stdout.write(output.content);
    } else {
      writeChartOutput(output.content, output.outPath, runtime);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.stderr.write(`排盘失败：${message}\n\n${legacyZiweiChartUsage()}`);
    return 1;
  }
}
