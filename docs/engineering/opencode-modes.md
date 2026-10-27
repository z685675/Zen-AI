# 新版助手：Plan / Build

本次改动仅影响新版 OpenCode 助手。旧助手继续只读，不恢复执行、微信或定时功能。

## 显示与兼容

| 界面模式 | 已存储配置 | 原生 agent |
| --- | --- | --- |
| Plan | `plan` | `plan` |
| Build | `default`、`acceptEdits`、`bypassPermissions` 或未配置 | `build` |

新选择 Build 时沿用 `acceptEdits` 存储值，不新增数据库枚举，不迁移或改写历史记录。
输入框提供两个按钮，设置页使用相同名称和说明。切换当前会话只保存当前会话配置，不修改助手默认值、其他会话或旧 SDK 的预授权工具列表。已运行的轮次不因切换模式被重放，新模式用于后续轮次。

## 权限与提示词

- Plan：允许已授权的读取、资料分析和计划；禁用终端、文件写入和有副作用的 MCP。需要执行时让用户切换 Build，不自行切换或绕过拒绝。
- Build：使用 OpenCode 原生默认权限，不再覆盖为“所有工具都 ask”。已授权工作区内的新目录、新文件和普通校验可连续执行。
- 保留原生敏感环境文件读取、重复工具循环确认、工作区外目录授权，以及既有常见删除命令的确认规则。
- 内置文件工具仍默认生成副本或编号文件。覆盖原件仍要求确认和可验证的备份；备份不等于用户授权。
- 模式指令是短合同，附在既有稳定工具合同与用户配置之后，不增加另一套任务循环、重试或上下文压缩。
- 微信和定时任务仍使用独立的受限工具配置，不继承桌面 Build 的全部能力。

这不是操作系统级沙箱。终端脚本、第三方 MCP 和任意 Python 不能承诺被同一套备份机制完全覆盖；Build 也不代表允许安装软件、对外发布或绕过用户的“不联网”等明确限制。

## 本地验证

```powershell
pnpm exec vitest run src/main/services/agents/services/opencode/__tests__ packages/shared/agents/__tests__/opencodeMode.test.ts src/renderer/src/pages/home/Inputbar/tools/__tests__/permissionModeTool.test.tsx src/renderer/src/pages/settings/AgentSettings/components/__tests__/PermissionModeSettings.test.tsx --pool=forks --maxWorkers=1 --no-file-parallelism
pnpm smoke:opencode --permissions
pnpm smoke:opencode --plan
pnpm smoke:opencode --lightweight
```

原生 smoke 只使用本地模拟 API：检查 Build 实际文件产物和免审批执行、显式单次授权，以及 Plan 的实际生效权限；不使用用户密钥或付费模型。复杂任务是否正确选择工具仍需真实模型手工验收。
