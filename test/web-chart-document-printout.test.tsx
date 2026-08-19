import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChartDocumentPrintout } from "../src/web/ChartDocumentPrintout.js";

describe("chart document printout", () => {
  it("renders supported plain-text prefixes as safe semantic print markup", () => {
    const html = renderToStaticMarkup(<ChartDocumentPrintout text={[
      "# 八字与紫微斗数双轨排盘",
      "## 输入资料",
      "### 八字排盘",
      "#### 四柱",
      "##### 小运",
      "##### 正月",
      "- 姓名或别名：测试代号",
      "> 这是排盘数据，不含命理解读。",
      "普通段落",
      "<script>alert('synthetic')</script>",
      "<img src=x onerror=alert('synthetic')>"
    ].join("\n")} />);

    expect(html).toContain('<article aria-label="八字与紫微斗数打印内容" class="chart-document-printout">');
    expect(html).toContain("<h1>八字与紫微斗数双轨排盘</h1>");
    expect(html).toContain("<h2>输入资料</h2>");
    expect(html).toContain("<h3>八字排盘</h3>");
    expect(html).toContain("<h4>四柱</h4>");
    expect(html).toContain("<h5>小运</h5>");
    expect(html).toContain("<h5>正月</h5>");
    expect(html).toContain('<p class="chart-document-print-field">姓名或别名：测试代号</p>');
    expect(html).toContain('<p class="chart-document-print-note">这是排盘数据，不含命理解读。</p>');
    expect(html).toContain("<p>普通段落</p>");
    expect(html).toContain("&lt;script&gt;alert(&#x27;synthetic&#x27;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(&#x27;synthetic&#x27;)&gt;");
    expect(html).not.toMatch(/<(?:button|nav|dialog|script|img)\b/gu);
  });

  it("renders nothing when no temporary print text is active", () => {
    expect(renderToStaticMarkup(<ChartDocumentPrintout text="" />)).toBe("");
  });
});
