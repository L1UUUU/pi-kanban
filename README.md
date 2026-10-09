# pi-kanban

面向个人开发者的本地 AI 开发工作台：以需求为授权、执行和验收单位，把规划、实施、独立 Review、返工及本地经验关联在同一个工作区。

**首个支持范围已收敛为 Node 原生受控工具，shell 必须为空；当前仍是 draft，真实 Agent 自主执行默认关闭。** 范围包括受控文件读写、删除、列举、搜索，以及使用 `--test-isolation=none` 的 Node 进程内测试和不新建子进程管道或 IPC 命名管道的 JavaScript CLI；默认进程隔离的 Node 测试、任意 Bash 脚本、POSIX 管道和原生命令不在本阶段范围内。已实现的跨平台规则、存储、Git、SDK 和受控进程测试，不等于 Windows 运行组合或真实模型效果已经通过。完整门槛与缺口见 [实施状态](docs/implementation-status.md)。

## 快速开始

需要 Node.js 24 和 npm。仓库锁定依赖，不依赖 Electron 内置 Node 运行 Host。

```sh
npm ci --ignore-scripts
npm run check
npm run setup:electron
npm start
```

`setup:electron` 从 Electron 官方发行源下载对应平台二进制。桌面需要图形会话。`npm start` 把当前 Node 24 的绝对路径传给 Electron，再启动独立 Host。未配置模型不会产生 API 请求或费用。

打开应用后选择项目目录、保存需求，在诊断中导入方法、运行组合与模型配置。方案正文、任务、独立 Review 和检查证据可按精确版本阅读；方案修订、问题裁决、方法切换、实施授权和验收分别记录。知识页提供候选分类、远端只读核验和明确的基线整合。保存消息只表示已保存，不能冒充已投递或要求已落实。未满足原生隔离和方法/模型前提时，自主执行保持关闭。

生产规划使用显式的 `design-feature-staged-v1`：先在新的只读上下文调查事实，再澄清需求；用户确认当前需求理解后形成设计，并交给另一个新的只读上下文独立审查。审查问题处理完成后，用户单独确认最终设计和测试 seams，才生成本地 spec 和有依赖关系的 tickets。内部技术拆分不再增加一个强制确认步骤；规划完成仍不授予实施权。新的回答、确认或修订会改变精确输入，后续模型请求必须有覆盖该输入版本的有限授权。

```sh
npm test                 # Node 内置测试：真实 SQLite/Git + 显式合成 fixtures
npm run typecheck        # 全项目严格 TypeScript 检查
npm run build            # Host、Electron 主进程/预加载及 React 生产包
npm run diagnostics      # 实际环境版本、包摘要和未放行门槛
npm run preview          # 仅合成数据 UI 预览，醒目标注且与生产包分离
npm run test:ui          # 浏览器交互回归；需已安装 Playwright Chromium
```

## 已实现的核心

- F/Q：可信用户控制与 Worker 上报分离，方案确认与实施授权分开，方法版本冻结，SQLite 事务内保存事实/回执/待派发工作；独立 Review、争议复核和结果级验收
- W：一需求一 worktree，固定明确基线，精确文件清单/摘要的受控本地提交，崩溃副作用核对；不自动 push、创建 PR、merge 或清理
- K：`.local/pi-kanban` 中不可变正文、证据和复用资格分离；先按项目/角色/需求/基线/许可过滤，再检索正文；实施会话不会变成 Reviewer 的输入
- R：运行代次、单写入者、两个并行需求与一个高资源检查，持久停止意图和实际进程树观察；限额预留、未知用量保留、有限重试和无进展停止
- Pi：实际 SDK 显式装配、独立原生会话、禁止默认全局资源发现；低层结束事件不会被解释成业务完成
- 规划：持久化阶段、问题、回答和两类独立确认；按需加载锁定版本的原版技能与引用，Host 记录读取证据；spec 与可执行 tickets 分开保存，旧版本确认和跨阶段上报被拒绝
- 桌面：中文 Agent 工作区、稳定成果与检查、持久阻塞、旧版本操作拒绝、独立 Node Host、受限预加载桥、托盘关闭和明确退出
- Windows：C++ AppContainer/Job Objects 候选启动器、私有通道、精确运行文件授权、停止/撤权回执与真实 Win32、Node/Pi 探针；Node-only 组合不配置 shell，Git Bash 仅保留不受支持的隔离诊断

## 数据与安全

Host 控制数据库位于应用用户数据目录；项目私有正文仅位于项目锚点的 `.local/pi-kanban`。项目正式代码/文档与个人材料分开，提交检查拒绝 `.local`。不自动导入用户的其他笔记，也不上传本地资料。

Git Hooks、过滤器、fsmonitor 和签名等未验证组合会明确阻塞，不在高权限 Host 中运行或静默跳过。生产 Worker 缺少真实隔离证据时拒绝启动；Linux 进程 fixture 仅用于监督测试，不是安全沙箱。

Node 检查只能读取获准源码并使用私有临时区。测试须显式使用 `node --test --test-isolation=none`，且测试正文和依赖不得新建子进程管道或 IPC 命名管道；不能据此宣称默认进程隔离模式受支持，也不能静默改变必需检查的语义。适用的 JavaScript CLI 必须由锁定的 Node 直接运行、遵守相同管道限制，且依赖也必须在已授权资源范围内。不能依赖 npm 脚本的系统 shell、Bash 管道或任意原生可执行文件。进程内测试 fixture 属于必需的原生 recorder，结果须查看精确提交对应的 Windows 运行；历史管道阻塞失败不会删除或改判通过。源码生成通过受控写入/删除接口；检查命令改动源码会阻塞后续模型请求和交接。磁盘采用有限的周期检查与超限停止策略，不宣称瞬时硬配额。内置远端核验目前支持公共 GitHub 仓库。

本仓库没有原始私有规划 ZIP、个人会话、真实凭据或付费模型授权。原始产品规格用编号追溯，公开文档为本项目重新编写。

私有 `design-feature` 入口仍由用户配置本地路径和摘要，不复制到仓库。公共下游依赖已按精确提交附带于 `vendor/mattpocock-skills`，保留原文、调用限制、来源和 MIT 许可；自动阶段调用及本地产物位置由独立适配规则明确限定。生产规划不再接受 `explicit-text-v1` 拼接方法；该旧接口仅保留给其他文本方法及合成回归。实际 Pi 的逐阶段加载与生产协议已用确定性模型传输测试，不能据此宣称真实模型质量或目标 Windows 隔离通过。

## 进一步阅读

- [架构与模块接口](docs/architecture.md)
- [Node-only 支持矩阵](docs/support-matrix.md)
- [实施状态、验收证据与剩余条件](docs/implementation-status.md)
- [安全边界与已知限制](docs/security.md)
- [开发与测试说明](docs/development.md)
- [运行配置与有限授权](docs/configuration.md)
- [规划技能锁定、阶段加载与适配范围](docs/planning-method-bundle.md)
- [需求规则 API](src/domain/README.md)
- [Windows 原生候选](native/windows/README.md)
