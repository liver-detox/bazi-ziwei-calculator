import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const output = execFileSync(
  process.execPath,
  [
    "src/ziwei-chart.mjs",
    "--solar",
    "2000-01-15",
    "--time",
    "12:00",
    "--gender",
    "女",
    "--name",
    "DEMO-NORMAL",
    "--format",
    "json"
  ],
  { encoding: "utf8" }
);

const data = JSON.parse(output);

assert.equal(data.schemaVersion, "1.0.0");
assert.equal(data.chart.chineseDate, "己卯 丁丑 壬申 丙午");
assert.equal(data.chart.time, "午时");
assert.equal(data.chart.earthlyBranchOfSoulPalace, "未");
assert.equal(data.chart.earthlyBranchOfBodyPalace, "未");
assert.equal(data.chart.palaces.length, 12);

const soulPalace = data.chart.palaces.find((palace) => palace.name === "命宫");
assert.ok(soulPalace, "命宫应存在");
assert.equal(soulPalace.earthlyBranch, "未");
assert.ok(soulPalace.majorStars.some((star) => star.name === "天梁"));

console.log("smoke tests passed");

const trueSolarOutput = execFileSync(
  process.execPath,
  [
    "src/ziwei-chart.mjs",
    "--solar",
    "2003-09-17",
    "--time",
    "17:05",
    "--gender",
    "男",
    "--name",
    "SYNTHETIC-CLI-TRUE-SOLAR",
    "--true-solar",
    "--longitude",
    "120",
    "--format",
    "json"
  ],
  { encoding: "utf8" }
);

const trueSolarData = JSON.parse(trueSolarOutput);

assert.equal(trueSolarData.schemaVersion, "1.0.0");
assert.equal(trueSolarData.meta.trueSolarAdjustment.clockTime, "17:05");
assert.equal(trueSolarData.meta.trueSolarAdjustment.longitude, 120);
assert.equal(trueSolarData.meta.trueSolarAdjustment.equationOfTimeMinutes, 5.4795);
assert.equal(trueSolarData.meta.inputTime, "17:10");
assert.equal(trueSolarData.chart.time, "酉时");

console.log("true-solar smoke tests passed");

const trueSolarBoundaryProbeOutput = execFileSync(
  process.execPath,
  [
    "src/ziwei-chart.mjs",
    "--solar",
    "2003-09-17",
    "--time",
    "16:57",
    "--gender",
    "男",
    "--name",
    "SYNTHETIC-CLI-TRUE-SOLAR",
    "--true-solar",
    "--longitude",
    "120",
    "--format",
    "json"
  ],
  { encoding: "utf8" }
);

const trueSolarBoundaryProbeData = JSON.parse(trueSolarBoundaryProbeOutput);

assert.equal(trueSolarBoundaryProbeData.meta.trueSolarAdjustment.equationOfTimeMinutes, 5.4774);
assert.equal(trueSolarBoundaryProbeData.meta.trueSolarAdjustment.solarTime, "17:02");
assert.equal(trueSolarBoundaryProbeData.meta.inputTime, "17:02");
assert.equal(trueSolarBoundaryProbeData.chart.time, "酉时");

console.log("true-solar boundary smoke test passed");
