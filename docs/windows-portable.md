# Windows 便携版构建与验证

本方案为普通用户准备“解压后双击启动”的本地网页程序：包内带 Node.js、已编译服务端、网页和生产依赖，用户无需安装 Node.js 或执行 npm。Windows x64 以 [v0.5.0-windows-preview.1 测试版](https://github.com/liver-detox/bazi-ziwei-calculator/releases/tag/v0.5.0-windows-preview.1)收集反馈；构建工具本身不自动上传 GitHub Release，发布不代表已经完成 Windows 实机验收。

## 选择的路线

| 路线 | 对现有项目的影响 | 本次选择 |
| --- | --- | --- |
| 内置官方 Node.js，提前编译服务端，附生产依赖 | 保持 Fastify、ESM、文件相对路径及普通模块解析；运行时不需要构建工具 | 采用。增加少量构建和校验逻辑，升级依赖时容易定位问题 |
| Node.js SEA 独立可执行程序 | 需要处理脚本注入、资源读取、模块解析及签名；Node 24 SEA 只支持单个 CommonJS 注入脚本，现有程序是 ESM | 暂不采用。此时多出的适配和验证成本高于收益 |
| Electron 等桌面壳 | 还要维护浏览器运行时、桌面生命周期和更大的分发体积 | 当前只需要打开本地网页，暂不引入 |

具体依赖核对：

- **Node.js**：现有项目要求 24 或更高版本；便携包使用 `release/windows-runtime.json` 固定的官方 24.22.2 Windows 运行时，分别支持 x64、ARM64 构建，不使用用户 PATH 中的 Node。
- **Fastify 与 `@fastify/static`**：仍由 Node.js 启动本地 HTTP 服务，静态目录只指向 `app/dist/`。案例目录不作为静态资源提供。
- **tsx**：原 `npm start` 用它执行 TypeScript。便携包在维护者构建时用 TypeScript 编译器生成 JavaScript，运行时移除 tsx，以及它依赖的 esbuild 平台二进制。
- **Vite**：只在维护者构建时生成 `dist/`；便携包不运行开发服务器或 `vite preview`，也无需附带 Vite。
- **生产依赖**：按项目锁文件重新安装，忽略安装脚本、不创建命令链接。构建会拒绝安装脚本、平台约束及原生二进制依赖，避免把构建主机专用模块误带到 Windows。当前依赖符合这一前提；今后依赖变化需要重新评估。

现有紫微计算代码使用 `createRequire(import.meta.resolve("iztro"))` 解析 `i18next`，因此保留真实 `node_modules` 比强行合成一个文件更直接。源码标识在构建时计算并冻结，网页与服务端使用相同值；运行时不再读取源码清单计算哈希。

依据：[Node 24 SEA 文档](https://nodejs.org/download/release/v24.18.0/docs/api/single-executable-applications.html)、[tsx 编译说明](https://tsx.hirok.io/compilation)、[Vite 静态部署说明](https://vite.dev/guide/static-deploy.html)、[Fastify Static 文档](https://github.com/fastify/fastify-static)。

## 构建者操作

构建机需要项目所需的 Node.js、npm、Git，以及下载依赖和官方运行时所需的网络；Windows 使用系统 Windows PowerShell，macOS/Linux 还需要 `zip` 和 `unzip`。这些要求只针对维护者。可以在 macOS 等主机装配 Windows 包，装配完成后仍须转到相应架构的 Windows 验收。

在仓库根目录运行，`--destination` 必须是项目目录之外、尚不存在的目录：

```sh
npm run build:portable -- --destination /absolute/path/cyber-sage-0.5.0-win-x64
```

ARM64 单独构建：

```sh
npm run build:portable -- --arch arm64 --destination /absolute/path/cyber-sage-0.5.0-win-arm64
```

Windows 构建机也可以使用绝对路径，例如：

```bat
npm run build:portable -- --destination C:\builds\cyber-sage-0.5.0-win-x64
```

脚本从公开文件白名单生成干净临时源码候选，再安装依赖、检查类型、构建网页、编译服务端并装配目录。它不复制工作目录中的 `data/`、导出物、日志、环境文件或密钥，不直接复制维护者已有的 `node_modules/`、`dist/`。公开的 `src/data/` 规则及地点快照属于程序资源，与真实案例数据分开处理。

成功后得到：

```text
cyber-sage-0.5.0-win-x64/          可直接拷贝的完整便携目录
cyber-sage-0.5.0-win-x64.zip       同一目录的压缩包
cyber-sage-0.5.0-win-x64.zip.sha256
```

构建失败时应处理具体错误后重新使用一个新目标目录，不把部分产物当作完整包。构建、清单校验和合成案例测试通过，均不等于已完成 Windows 人工验收。

### 固定运行时与离线输入

`release/windows-runtime.json` 保存 Node 精确版本、各架构官方 ZIP 的 SHA-256，以及包内 `node.exe` 的 SHA-256。下载只使用固定版本的 [Node.js 官方发行目录](https://nodejs.org/dist/v24.22.2/)，并与固定校验值比对；不追随浮动的 `latest` 下载。Node 许可证从同一份已校验的官方 ZIP 提取。

已提前下载好对应架构的官方 ZIP 时，可以提供本地文件：

```sh
npm run build:portable -- --destination /absolute/path/cyber-sage-0.5.0-win-x64 --runtime-archive /absolute/path/node-v24.22.2-win-x64.zip
```

`--runtime-archive` 只替代运行时下载，不跳过哈希检查，也不保证 npm 依赖已具备离线缓存。不要将 ARM64 运行时作为 x64 输入。

升级运行时应由维护者主动选择仍受维护的 Node 版本，从该版本官方 `SHASUMS256.txt` 核对 Windows ZIP，再从已校验 ZIP 计算 `node.exe` 哈希，并同时更新配置中的精确版本及校验值；然后分别重建和验收 x64、ARM64。不要仅修改版本号或跳过校验。

## 便携目录与用户启动方式

主要目录如下：

```text
cyber-sage-0.5.0-win-x64/
├── Start.cmd
├── README.txt
├── PORTABLE-MANIFEST.json         每个分发文件的 SHA-256
├── LICENSE
├── PRIVACY.md
├── THIRD-PARTY-NOTICES.txt
├── LICENSES/
├── runtime/
│   ├── node.exe
│   └── LICENSE
├── app/
│   ├── package.json
│   ├── portable.mjs               便携入口与数据目录设置
│   ├── node_modules/             锁定生产依赖及其许可证
│   ├── dist/                     网页静态产物
│   └── src/
│       ├── server/               已编译 JavaScript
│       ├── core/
│       ├── shared/
│       └── data/                 公开规则和地点快照
└── data/                         首次正常启动时生成，不随初始包分发
```

普通用户操作：

1. 将整个 ZIP 解压到自己有写权限的短路径，例如 `%USERPROFILE%\Documents\CyberSage`；先完成解压，再启动。
2. 双击 `Start.cmd`。程序使用包内运行时，选择可用端口，在默认浏览器打开 `http://127.0.0.1:端口`。若浏览器未自动打开，复制启动窗口中的本机地址。
3. 使用期间保留启动窗口。退出时在该窗口按 `Ctrl+C`，按 Windows 提示结束；关闭浏览器页面本身不会停止本地服务。

启动器的 `Start.cmd --check` 用于检查包内 Node 和必要文件，不启动服务，不进行计算，也不能替代浏览器功能验收。它不做全包哈希校验；完整性校验由下述 `test:portable` 执行。正常启动失败时窗口会保留提示，以便检查文件缺失、目录无写权限等原因。Windows SmartScreen 或安全软件可能对新下载文件提示；记录具体提示并交由维护者评估，不要求用户关闭系统保护或绕过拦截。

案例保存在便携根目录的 `data/`。备份时先停止程序，再复制整个 `data/`；移动完整目录也会一起移动本地案例。升级时解压到一个新目录，停止旧版，将旧 `data/` 复制到新版空目录后再启动，保留原备份，避免用程序压缩包覆盖正在使用的目录。复制给 AI、下载 TXT 或 JSON 仍会包含输入的姓名或代号和出生资料，外发前检查内容。

本方案保持仅监听 `127.0.0.1`，不接入云端 AI，不上传案例，不附带 API 密钥，也不自动检查更新。目标目录在实际使用后可能含真实资料，不能把整个使用过的目录重新压缩后当作公开发行包；公开包须从干净构建重新生成。

## 合成案例自动验证

Windows 上对完整便携目录运行：

```bat
npm run test:portable -- --root C:\builds\cyber-sage-0.5.0-win-x64
```

默认使用包内 `node.exe`。维护者需要 npm 执行这个验证脚本，普通用户启动程序不需要 npm。

macOS 等非 Windows 主机只运行宿主 Node 的 HTTP 和打包内容检查：

```sh
npm run test:portable -- --root /absolute/path/cyber-sage-0.5.0-win-x64 --host-node
```

验证应使用独立临时数据目录和完全合成的输入，检查包内文件哈希、静态首页、本机健康接口、会话令牌保护、计算与导出等实际路径。临时测试数据不能混入分发目录。`--host-node` 不会执行 Windows 二进制，也不能验证批处理窗口、默认浏览器、Windows 文件语义或 SmartScreen。

可以复用仓库 `docs/examples/input.json` 的合成案例：女、公历 `2000-01-15`、`12:00`、当地钟表时间，代号使用 `PORTABLE-SYNTHETIC`。另一个合成案例使用女、农历 `2023-02-01`、闰月不确定、`23:30`、晚子时并列候选，验证四候选流程。核对结果时与同一源码、同一输入的开发版比对，不把不同版本计算结果直接作为打包回归基准。

## Windows 人工验收

x64 与 ARM64 分别记录系统、架构、浏览器版本、包名、ZIP SHA-256、日期、步骤及结论；仅使用上述从零构造的合成资料。首轮至少覆盖：

| 场景 | 应观察到的结果 |
| --- | --- |
| 未安装 Node/npm 的 Windows，或从 PATH 移除相关目录 | 解压后双击能启动；没有安装依赖、寻找系统 Node 或联网下载提示 |
| 中文、空格路径和普通用户账户 | 路径引用正确，无需管理员权限；使用后数据出现在预期根目录 |
| 断网启动与计算 | 首页、排盘、保存和导出可正常使用，浏览器开发者工具无必需的外网资源请求 |
| Chrome / Edge 分别设为默认浏览器 | 能打开正确的随机本机地址；不能自动打开时终端地址可手动访问。分别记录结果，不直接扩大现有平台支持声明 |
| 普通案例与四候选案例 | 输入、候选选择、保存、重开符合预期；未选择候选时不冒充已确定结果 |
| 2026–2028 多年度展开、复制、TXT、JSON | 选定年份文本及完整 JSON 与界面约定一致；下载内容保留合成代号，中文可读 |
| 已占用端口、重复双击两次 | 默认端口自动分配；两次启动使用不同端口。记录两个窗口，避免在两个实例同时编辑同一案例 |
| Ctrl+C 停止、再启动、重开保存案例 | 旧服务退出，旧地址失效；重启可读取此前保存的合成案例 |
| 只读目录、必要文件缺失 | 正常启动时有失败提示，不静默退出，不误报启动成功；恢复后再用完整干净包验证 |
| 修改包内文件后运行 `test:portable` | 文件清单或哈希校验失败；该检查不是每次双击启动时自动执行 |
| SmartScreen / 杀毒软件 / ZIP 解压 | 记录阻止或提示、默认解压行为及实际处理结果；存在阻断时不能标记该环境验收通过 |

删除仅用于验收的合成数据后，再从干净源码重建公开候选。未完成 Windows 人工验收时仅按明确标识的测试候选收集反馈；正式支持对应架构和预定浏览器前，应完成上述验收。发布决定独立于构建脚本。

## 本次验证状态

2026-10-31，在 macOS、宿主 Node.js 26.0.0 上完成：

- x64 全流程干净构建：固定官方 Node.js 24.22.2 ZIP 与 node.exe 校验、84 个生产依赖检查、服务端预编译、网页构建、8819 个文件清单、ZIP 解压逐文件哈希核对均通过。
- 完整候选的 `test:portable --host-node` 通过：实际便携入口、静态资源、两年结果导出、四候选、本地访问保护、重启回读及临时数据清理；候选内没有生成 `data/`。
- `npm run test:release` 通过：210 项公开测试、命令行冒烟、类型检查、生产构建。
- 已有目标拒绝覆盖、错误运行时 ZIP 哈希拒绝；校验脚本的路径逃逸、符号链接、额外文件和错误哈希负例均通过。

发布前补充修复 ZIP 文件名 UTF-8 标记，并去除 Unix ZIP 中的用户/组等额外字段；使用标准 ZIP 读取器核对非 ASCII 路径和全包内容。

Windows x64 的 node.exe、Start.cmd、默认浏览器和人工操作尚未在 Windows 执行；ARM64 尚未构建或验收。x64 由维护者选择作为预发布测试候选收集反馈，v0.5.0 稳定版保持独立。生成 ZIP、公开预发布或通过宿主 Node 验证不能填成 Windows 已通过。
