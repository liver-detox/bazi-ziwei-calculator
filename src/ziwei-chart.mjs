#!/usr/bin/env node
import { runLegacyZiweiChartCli } from "./cli/ziwei-chart-cli.ts";

process.exitCode = runLegacyZiweiChartCli(process.argv.slice(2));
