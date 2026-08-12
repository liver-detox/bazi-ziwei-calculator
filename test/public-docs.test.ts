import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const publicDocuments = [
  "README.md",
  "LICENSE",
  "PRIVACY.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md"
] as const;

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("public documentation contract", () => {
  it("ships the complete minimum public document set", async () => {
    const contents = await Promise.all(publicDocuments.map(read));

    expect(contents).toHaveLength(publicDocuments.length);
    for (const content of contents) expect(content.trim().length).toBeGreaterThan(0);
  });

  it("gives beginners the approved README flow and scope in the required order", async () => {
    const readme = await read("README.md");
    const headings = [
      "## 项目定位 / English summary",
      "## 功能与边界",
      "## 合成演示截图",
      "## 五分钟开始使用（macOS）",
      "## 数据与隐私",
      "## 测试与非阻塞性能基准",
      "## 平台支持（macOS 已验证，Windows 计划中）",
      "## 贡献、安全、许可证与第三方归属"
    ];

    expect(readme).toContain("赛博大师·八字与紫微排盘计算器");
    expect(readme).toContain("Node.js 24");
    expect(readme).toContain("npm ci");
    expect(readme).toContain("npm run build");
    expect(readme).toContain("npm start");
    expect(readme).toContain("npm run test:release");
    expect(readme).toContain("npm run test:performance");
    expect(readme).toMatch(/三个[^\n]*合成案例/u);
    expect(readme).toMatch(/macOS[^\n]*已验证/u);
    expect(readme).toMatch(/Windows[^\n]*计划中/u);

    let previous = -1;
    for (const heading of headings) {
      const current = readme.indexOf(heading);
      expect(current, `${heading} must follow the preceding section`).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it("does not publish the old personal-looking CLI examples", async () => {
    const readme = await read("README.md");

    expect(readme).not.toMatch(/npm run chart -- --(?:solar|lunar)/u);
    expect(readme).not.toMatch(/--name\s+\S+/u);
    expect(readme).not.toMatch(/--longitude\s+\d/u);
  });

  it("forbids real birth data in public Issues", async () => {
    const [privacy, security] = await Promise.all([read("PRIVACY.md"), read("SECURITY.md")]);

    for (const document of [privacy, security]) {
      expect(document).toMatch(/禁止(?=[^\n]*(真实出生资料|真实出生数据))(?=[^\n]*公开[^\n]*Issue)[^\n]*/iu);
    }
  });

  it("distinguishes the three public demos from the wider public test provenance", async () => {
    const changelog = await read("CHANGELOG.md");

    expect(changelog).toMatch(/公开演示[^\n]*三个[^\n]*合成案例/u);
    expect(changelog).toMatch(/公开测试[^\n]*合成输入[^\n]*来源[^\n]*许可证[^\n]*公开上游夹具/u);
    expect(changelog).not.toMatch(/公开演示与测试[^\n]*三个/u);
  });
});
