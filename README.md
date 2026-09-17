# 赛博大师·八字与紫微斗数排盘计算器

在本机输入出生时间，同时生成八字与紫微斗数排盘，然后一键复制给你选择的 AI。

**v0.4.0：同宫分层展示与导出可靠性提升。** 紫微每宫连续阅读本命、大限、流年，复制与导出同步说明证据限制和交运边界。

普通结果可以直接复制；遇到晚子时等多个可能结果时，先选择一个，再复制。程序不提供吉凶断语，也不提供医疗、法律或财务建议。

**English:** A local-first Bazi and Zi Wei Dou Shu calculator. Version 0.4.0 groups natal, decadal, and yearly layers by palace and carries evidence limits into exports. Windows 11 + Chrome was manually verified for v0.3.2; this update has not been manually verified on Windows. Earlier macOS Safari checks covered AI-text copying only. Microsoft Edge remains unverified.

## 三步使用

1. 填写性别、出生日期、出生时间，并说明输入的是真太阳时间还是当地钟表时间。
2. 查看八字与紫微斗数结果；如果出现多个候选，选择要使用的一个。
3. 点击“复制给 AI”，粘贴到你选择的大模型中。

结果页还可以下载 TXT、完整 JSON，或在浏览器支持时使用系统分享和打印/PDF。

## AI 文本长什么样

复制、TXT、系统分享和打印使用同一份 AI 友好文本。下面是缩略的合成示例：

```text
# 八字与紫微斗数双轨排盘
> 这是排盘数据，不含命理解读；不得猜测缺失字段。

## 输入资料
- 姓名或别名：DEMO-NORMAL
- 性别：女
- 日期：2000-01-15
- 提供时间：12:00

## 八字
……

## 紫微斗数
……
```

需要机器可读的完整数据时，可下载版本化的 ChartDocument V1 JSON；这里有一份[完全合成的示例](docs/examples/chart-document-v1.json)。每次导出只包含一个已选定候选。

交接文本开头会说明当前计算审计、证据限制和允许分析范围；约略时间或时辰不确定时，仍可导出排盘，但不能因拿到双盘就扩大分析范围。A 级只表示给定输入下的计算审计状态，不证明出生资料真实或预测高置信。时间按用户提供值直接计算，真太阳时是否已校正也只是用户声明；本次排盘不自动校正地点、时区、夏令时或真太阳时。

JSON 的可选 `evidence` 字段保存当前修订的 `auditLevel`、`workflowStatus`、`allowedAnalysisModes` 和精简 `findings`（代码、严重程度、中文摘要）；`timeHandling: "user_provided_unverified"` 表示直接使用用户时间，未经独立核验或自动校正。复制、TXT 和打印均从同一份 ChartDocument 生成。姓名或代号为可选项，不要求真名；填写后会优先用于复制和导出，留空时使用案例化名或自动编号。

**JSON 升级方向：先更新读取器，再接收新导出。** `schemaVersion` 仍为 1；v0.4.0 读取器可读取缺少 `evidence`、`exportSourceId` 的旧 V1，此时证据限制和原导出来源显示未知，空警告不代表无风险。新增的这两个字段会被 v0.3.2 等拒绝未知字段的严格读取器拒绝，因此不是双向兼容；请先升级下游读取器，不要删掉证据限制来伪装成旧格式。旧文件不会被自动改写或补记当前源码身份。

文本开头列明本次展开的单一流年，以及完整 JSON 已计算的全部年份；未选年份时只展开本命和全部大运。紫微部分以固定地支和宫名列出对宫、三合及所选大限/流年的宫名，四化逐项标明禄、权、科、忌与本命落宫；机器索引仍保留在完整 JSON 中。“无十四主星”等空值说明只适用于对应字段，不表示未导出的杂曜不存在。

紫微详盘、AI 文本、TXT 和打印共用逐宫展示：每宫按“本命 → 大限 → 流年”连续列出主辅星、庙旺、附加星曜和该层四化。运限四化按本命主辅星所在的固定宫位归组；无法唯一定位或生年四化两处记录矛盾时集中提示，不强行归宫。所选年度资料缺失、重复、未对齐或代表日期不符时停止年度合并；完整 JSON 的原始字段保留不变，不补算飞化、自化或杂曜。

大运年表索引不代表全年日期归属。页面和文本从已算起运时刻按每十个公历年顺延，显示所选公历年内的分段（含开始、不含结束），不重新校正出生时间。八字以立春换年、十二节分月；紫微以农历正月初一换年，年度叠加取目标年 7 月 1 日代表盘。旧文档的起运日期无效或年表不一致时显示“日期分段不可用”，仍保留原始数据。

紫微流年盘及同源文本会说明所选年份是否跨大限；跨限时列出春节对应的公历日、春节前一日和当天的大限及本命落宫，童限另行标注。日期由锁定历法的 1900–2099 年春节表、该候选的引擎输入日期和已保存虚岁范围确定，仅说明规则下的运限归属，不表示现实事件发生。旧资料缺失、规则不符或年龄定位与代表盘不一致时，明确显示交限日期不可用。

另有[起运、紫微安星与四化的独立核验](docs/verification/independent-chart-rules.md)，记录外部来源、冻结样本、流派差异和覆盖边界。所列样本通过不代表所有规则或流派均已验证，也不证明预测有效；壬干化科的事后补证与原始冻结预期分别保留。

JSON 的可选 `exportSourceId` 是本次 JSON 导出的源码标识；AI 文本、TXT 和打印另列本次文本呈现的源码标识，界面也以小字显示。旧 JSON 未记录的原导出标识为未知。标识取公开白名单中源码、静态入口、启动及构建配置、依赖清单与锁文件的相对路径和内容 SHA-256 前 16 位，相同源码保持稳定，不包含案例、输出、Git、路径位置、时间或机器信息。后端在启动时固定，前端在构建时固定；修改源码后应重新构建页面并重启服务。这些标识不为旧排盘补记原始计算构建身份，也不代表新 Release；原有引擎、规则和计算结果保持不变。

## 界面预览

以下截图全部使用从零构造、与真实人物无关的合成案例。

![八字与紫微斗数双盘总览](docs/images/demo-overview.png)

<details>
<summary>查看八字详盘和流年联动</summary>

![八字详盘](docs/images/demo-bazi-detail.png)

![大运流年与紫微斗数流年联动](docs/images/demo-year-linkage.png)

</details>

## 本地启动

需要 **Node.js 24 或更高版本**。

### macOS

在终端进入项目目录后运行：

```bash
npm ci
npm run build
npm start
```

以后也可以双击 `scripts/start-local.command`。结束使用时，在终端按 `Control-C`。

### Windows 11 + Chrome

在项目目录完成一次 `npm ci` 后，在“命令提示符”运行：

```bat
scripts\start-local.cmd
```

手动打开终端显示的 `127.0.0.1` 地址；结束使用时按 `Ctrl-C`。

想先看不含真实资料的命令行输出，可以运行 `npm run demo`。

## 本地与隐私

- 程序只监听本机地址 `127.0.0.1`，案例默认保存在项目的 `data/` 目录，不会由程序主动上传。
- 复制或导出的内容会包含姓名或代号及出生资料；交给 AI、其他应用或他人前请先确认内容。
- 公开 Issue、测试和演示只使用完全合成的数据，不要提交真实案例、导出物、日志、密钥或本机信息。

完整说明见 [PRIVACY.md](PRIVACY.md)。

## 平台状态

| 平台 | 状态 |
| --- | --- |
| macOS Safari | 历史版本已验证复制；v0.4.0 尚未完成 Safari 人工复核，历史结果不扩大为本版导出支持声明 |
| Windows 11 + Google Chrome | v0.3.2 已人工验证；v0.4.0 尚未进行 Windows 人工复核 |
| Microsoft Edge | 尚未验证，不在当前支持范围 |

系统分享、打印和存为 PDF 的实际可用性由浏览器与操作系统决定。

## 开发与维护

提交公开候选前运行：

```bash
npm run test:release
```

性能基准 `npm run test:performance` 用于透明记录和优化，不是发布硬门。

- 贡献规则：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)
- 隐私说明：[PRIVACY.md](PRIVACY.md)
- 更新记录：[CHANGELOG.md](CHANGELOG.md)
- 许可证：[MIT License](LICENSE)
- 第三方归属：[GeoNames](LICENSES/GeoNames-CC-BY-4.0.md)、[`@4n6h4x0r/stem-branch`](LICENSES/stem-branch-Apache-2.0.md)
