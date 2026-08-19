# 赛博大师·八字与紫微排盘计算器

## 项目定位 / English summary

这是一个在用户电脑本地运行的八字与紫微斗数基础排盘计算器。它把资料录入、双盘计算、差异核验、历史修订和单文件结构化导出放在同一个可追溯流程中；八字与紫微斗数在项目中同等重要。

**English:** A local-first Bazi and Zi Wei Dou Shu calculator for traceable chart calculation, review, revision history, and single-file structured exports. The current public release is verified on macOS; Windows has a pre-release readiness candidate, not formal support.

## 功能与边界

主要功能：

- 根据用户输入生成八字与紫微斗数基础排盘信息；
- 对晚子时、时间口径差异和多个候选结果保留人工核验入口；
- 保存不可覆盖的修订记录，便于复查计算依据；
- 在大运流年与紫微详盘之间共享目标年份；
- 导出一个包含当前输入、所选候选、八字与紫微斗数结果的版本化 JSON 文件；每次只导出一个已选定候选。

本项目只提供计算与核验底稿，不生成吉凶断语，也不提供医疗、法律、财务或其他专业意见。旺衰、格局、用神、合盘、AI 解读、云同步和多人账号不在当前公开版本范围内。

## 合成演示截图

当前演示只使用三个从零构造、与任何真实人物无关的合成案例：普通盘、晚子时双候选、共享流年。以下截图均已通过浏览器与隐私验收，不含真实人物资料。

### 双盘总览

![合成案例的八字与紫微斗数双盘总览](docs/images/demo-overview.png)

### 八字详盘

![合成案例的八字详盘](docs/images/demo-bazi-detail.png)

### 大运流年与紫微斗数流年联动

![合成案例在大运流年与紫微详盘间共享流年](docs/images/demo-year-linkage.png)

### 核验与单文件结构化导出

![合成案例的核验与单文件 JSON 导出界面](docs/images/demo-export.png)

## 五分钟开始使用（macOS）

准备条件：安装 **Node.js 24 或更高版本**，并下载或克隆本项目到本机。打开“终端”，进入项目目录后依次运行：

```bash
node --version
npm ci
npm run build
npm start
```

启动成功后，程序会自动在默认浏览器打开本机页面。请保持终端窗口运行；结束使用时，在终端按 `Control-C`。

也可以在完成一次 `npm ci` 后，双击 `scripts/start-local.command`。该启动方式会重新构建网页后再启动程序。

## Windows 11 试运行候选（尚未正式支持）

Windows 11 用户在项目目录完成一次 `npm ci` 后，可在“命令提示符”运行：

```bat
scripts\start-local.cmd
```

启动器会重新构建并启动本地程序；请手动打开终端打印的 `127.0.0.1` 地址，按 `Ctrl-C` 停止。公开 CI 配置用于检查 Windows runner 中的中文/空格路径、公开候选构建、发布门和启动器 `--check`；Windows 11 Chrome/Edge 的下载、权限、保存及中文路径体验仍待人工验收。macOS 仍是唯一正式已验证平台。

想先看不含真实资料的命令行输出，可运行：

```bash
npm run demo
```

程序只监听本机地址 `127.0.0.1`。案例默认保存在项目的 `data/` 目录；高级用户可以在启动前通过 `CYBER_SAGA_DATA_DIR` 指定其他本机目录。

## 数据与隐私

- 案例数据默认只保存在本机，不会由本程序上传到云端。
- 每次导出为一个版本化 JSON 文件，包含当前输入的姓名或代号及出生资料、一个已选定候选和对应的双盘结果；可查看完全合成的 [ChartDocument v1 示例](docs/examples/chart-document-v1.json)。
- 姓名或代号会按输入原样写入 JSON。即使使用代号，出生日期、时间和相关资料仍可能敏感；发送、备份或公开前请自行复核文件内容。
- 程序只在本机运行，不会由本程序上传案例或导出的 JSON 文件。
- 不要提交或公开 `data/`、数据库、日志、环境变量、导出的 JSON 文件、真实案例或含本机信息的截图。
- 禁止在公开 GitHub Issues 中发布真实出生资料、姓名、地点、联系方式、密钥或令牌。

完整规则见 [PRIVACY.md](PRIVACY.md)。

## 测试与非阻塞性能基准

准备贡献或发布候选时，运行正确性发布门：

```bash
npm run test:release
```

该命令会运行公开功能测试、类型检查和正式构建；任何失败都会阻止发布。

性能基准单独运行：

```bash
npm run test:performance
```

性能结果用于发现优化方向，暂不阻塞首发，也不能替代正确性测试。当前内部 `provided-time` 基准未达到既定目标，因此不宣称性能门已经通过；项目不会为了缩短耗时而弱化严格重读、篡改检测或原子保存。

## 平台支持（macOS 已验证，Windows 试运行候选）

当前公开版本只承诺已验证 macOS。Windows 已提供试运行启动器与候选自动检查，但尚未完成正式验收。

正式宣布支持 Windows 前，仍需在 Windows Chrome/Edge 中验证中文路径、保存位置、权限和下载行为。

## 贡献、安全、许可证与第三方归属

- 贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，公开测试和演示只接受完全合成的数据。
- 安全问题请按 [SECURITY.md](SECURITY.md) 报告；不要在公开 Issue 中附带真实出生资料或漏洞敏感细节。
- 项目采用 [MIT License](LICENSE)。
- GeoNames 数据归属见 [LICENSES/GeoNames-CC-BY-4.0.md](LICENSES/GeoNames-CC-BY-4.0.md)。
- `@4n6h4x0r/stem-branch` 归属见 [LICENSES/stem-branch-Apache-2.0.md](LICENSES/stem-branch-Apache-2.0.md)。
- 版本变化见 [CHANGELOG.md](CHANGELOG.md)。
