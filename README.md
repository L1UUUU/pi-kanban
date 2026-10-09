# pi-kanban

面向个人开发者的本地 AI 开发工作台：以需求为授权、执行和验收单位，把规划、实施、独立 Review、返工及本地经验关联在同一个工作区。

**当前交付是可运行的桌面工作台与受控执行原型，仍是 draft。真实 Agent 自主执行默认关闭。** 已实现的跨平台规则、存储、Git、SDK 和受控进程测试，不等于 Windows 运行组合或真实模型效果已经通过。完整门槛与缺口见 [实施状态](docs/implementation-status.md)。

## 快速开始

需要 Node.js 24 和 npm。仓库锁定依赖，不依赖 Electron 内置 Node 运行 Host。

```sh
npm ci --ignore-scripts
npm run check
npm run setup:electron
npm start
```

`setup:electron` 从 Electron 官方发行源下载对应平台二进制。桌面需要图形会话。`npm start` 把当前 Node 24 的绝对路径传给 Electron，再启动独立 Host。未配置模型不会产生 API 请求或费用。

打开应用后选择项目目录、保存需求、交流补充资料、记录规划/授权决定并查看诊断。保存消息只表示已保存，不能冒充已投递或要求已落实。当前未满足原生隔离和方法/模型前提时，不会因为点击“开始”就运行无约束 Agent。

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
- 桌面：中文 Agent 工作区、稳定成果与检查、持久阻塞、旧版本操作拒绝、独立 Node Host、受限预加载桥、托盘关闭和明确退出
- Windows：C++ AppContainer/Job Objects 候选启动器与真实 Win32 smoke 测试；不是未经验证的无约束执行回退

## 数据与安全

Host 控制数据库位于应用用户数据目录；项目私有正文仅位于项目锚点的 `.local/pi-kanban`。项目正式代码/文档与个人材料分开，提交检查拒绝 `.local`。不自动导入用户的其他笔记，也不上传本地资料。

Git Hooks、过滤器、fsmonitor 和签名等未验证组合会明确阻塞，不在高权限 Host 中运行或静默跳过。生产 Worker 缺少真实隔离证据时拒绝启动；Linux 进程 fixture 仅用于监督测试，不是安全沙箱。

本仓库没有原始私有规划 ZIP、个人会话、真实凭据或付费模型授权。原始产品规格用编号追溯，公开文档为本项目重新编写。

## 进一步阅读

- [架构与模块接口](docs/architecture.md)
- [实施状态、验收证据与剩余条件](docs/implementation-status.md)
- [安全边界与已知限制](docs/security.md)
- [开发与测试说明](docs/development.md)
- [需求规则 API](src/domain/README.md)
- [Windows 原生候选](native/windows/README.md)
