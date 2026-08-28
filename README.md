# 赛博大师·八字与紫微斗数排盘计算器

在本机输入出生时间，同时生成八字与紫微斗数排盘，然后一键复制给你选择的 AI。

普通结果可以直接复制；遇到晚子时等多个可能结果时，先选择一个，再复制。程序不提供吉凶断语，也不提供医疗、法律或财务建议。

**English:** A local-first Bazi and Zi Wei Dou Shu calculator. Enter a birth time, review both charts, and copy one selected result to the AI of your choice. Windows 11 + Chrome has been manually verified. On macOS Safari, AI-text copying is verified; broader export coverage remains incomplete. Microsoft Edge remains unverified.

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
- 性别：男
- 日期：2000-01-15
- 提供时间：12:30

## 八字
……

## 紫微斗数
……
```

需要机器可读的完整数据时，可下载版本化的 ChartDocument V1 JSON；这里有一份[完全合成的示例](docs/examples/chart-document-v1.json)。每次导出只包含一个已选定候选。

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
| macOS Safari | 已验证复制；分享/打印仅确认入口，TXT/完整 JSON 尚未完成落盘核验 |
| Windows 11 + Google Chrome | 已人工验证 |
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
