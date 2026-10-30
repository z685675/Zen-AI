# 正式客户端补丁：配置与发布

适用：Zen AI 下一次完整安装包。2026-10-30 已在隔离的 Windows 验收包验证补丁下载、签名、重启应用、本机暂停及远程回退。正式包必须重新构建自己的基线；不要复用验收包的安装包、补丁或基础构建编号。

## 本次已落地

- 正式客户端启用补丁，内置公钥 `zen-hotpatch-20261029`；只存公钥，私钥不进入客户端。
- 完整安装包发布时保留 `hotpatch-base-win32.json`、`hotpatch-runtime-win32.zip` 及对应 macOS 文件。它们用于后续精确匹配补丁，不是给用户安装的附件。
- 界面补丁制作时复用正式安装包的原始 main/preload 和其引用资源。冻结源码、依赖、接口、持久化格式及运行文件校验继续生效。
- GitHub `Patch Policy Signature` 支持手动检查续期环境；自动续期仍每 6 小时运行，只续签已有决策，不增加投放比例或更换补丁目标。
- `Renderer Patch` 完成后在工作流 Summary 展示各平台的 `manifest.json` 地址，供 API 面板导入。
- 完整安装包同步保留既有 `hotpatch/` 目录；发布完整性检查要求 Windows/macOS 的描述文件和冻结文件均存在。

## 一、一次性的服务器准备

本机已准备：`local/hotpatch-production-setup-20261030/`。

在本机 PowerShell 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "C:\Users\admin\Documents\project\Zen-AI\local\hotpatch-production-setup-20261030\setup-upload.ps1"
```

根据提示输入服务器 root 的 SSH 密码，直到出现 `UPLOADER_OK` 和绿色 PASS。脚本会：

1. 上传公开的配置脚本和 SSH 公钥。
2. 创建 `zen-hotpatch-upload` 专用账号，限制此密钥的端口转发、代理转发和终端功能。
3. 授予补丁目录 `/opt/zen-ai-update/html/zen-ai/hotpatch` 的写权限；不递归更改已有补丁文件，不改安装包目录，不重启 API。
4. 通过已认证的 SSH 连接读取服务器公开主机指纹，并验证专用账号可连接。

新 SSH 私钥仅保存在本机配置目录的 `private/` 中。不要发到聊天或提交 Git。脚本可重复执行，不覆盖已配置的其他 SSH 公钥。

## 二、GitHub 环境配置

打开仓库 `z685675/Zen-AI` → Settings → Environments。

### hotpatch-release

先保留此前已经保存的两项：

| Environment secret | 来源 |
| --- | --- |
| `ZEN_HOTPATCH_SIGNING_KEY_PEM` | 2026-10-29 配置时保存的补丁签名私钥 |
| `ZEN_CLIENT_PATCH_SIGNER_TOKEN` | 同次配置的 API 签名令牌 |

新增下面 5 项 **Environment secrets**：

| Secret 名称 | 值 |
| --- | --- |
| `HOTPATCH_SSH_PRIVATE_KEY` | 新生成的专用上传私钥 |
| `HOTPATCH_SSH_KNOWN_HOSTS` | 第一步成功后生成的主机指纹记录 |
| `HOTPATCH_SSH_HOST` | `47.103.91.113` |
| `HOTPATCH_SSH_USER` | `zen-hotpatch-upload` |
| `HOTPATCH_SSH_PORT` | `22` |

再新增一项 **Environment variable**（不是 Secret）：

| Variable 名称 | 值 |
| --- | --- |
| `HOTPATCH_DEPLOY_ROOT` | `/opt/zen-ai-update/html/zen-ai/hotpatch` |

需要复制某项时，在 PowerShell 执行以下命令，替换最后的名称；值只进入剪贴板，不打印在窗口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\admin\Documents\project\Zen-AI\local\hotpatch-production-setup-20261030\copy-secret.ps1" -Name HOTPATCH_SSH_PRIVATE_KEY
```

### hotpatch-renewal

已有 `hotpatch-renewal` 环境就直接沿用，不要重复创建。下面两项签名 Secret 如果此前已经保存，本步骤直接跳过，不需要重新生成密钥或覆盖现有值。仅在环境不存在时创建，或只补齐缺少的项：

- `ZEN_HOTPATCH_SIGNING_KEY_PEM`
- `ZEN_CLIENT_PATCH_SIGNER_TOKEN`

仅需要补配时，使用上面的复制命令，将 `-Name` 分别换成这两个名称。它们的值与 `hotpatch-release` 中的相同。此环境需允许 `main` 的定时工作流直接运行；如果设置每次人工审批，自动续期会等待审批。现有设置已经满足时无需修改。发布环境可按需保留审批。

此前重复出现的签名失败邮件与定时工作流缺少签名凭据有关。只在 `hotpatch-release` 保存 Secret 不会自动给 `hotpatch-renewal` 共享。

## 三、代码推送 main 后检查续期环境

此项在下面第四部分的“推送 main”之后执行，不能用远端旧代码验证新配置。打开 Actions → **Patch Policy Signature** → Run workflow：

- Branch：`main`
- `intent_id`：留空
- `renew`：勾选

这会检查续期环境，最多只延长已有签名决策，不会新建一次补丁投放。没有需要续期的决策时正常结束即可。若提示凭据未配置，回到 `hotpatch-renewal` 检查名称与内容。

## 四、发布完整新版

先完成上面两项环境配置。当前项目仍有本次已测试的客户端改动尚未提交；发布提交应包含这些改动以及本次正式补丁配置。

本次准备打包的版本为 `1.1.77`。发布前：

1. 将 `package.json` 的版本设为目标版本，例如 `1.1.77`，且标签为 `v1.1.77`。版本必须在提交前设好，避免 CI 构建时修改源码导致基线不干净。
2. 完成 lint、全量测试、格式检查与正式构建。提交前检查 `git status --short` 与差异，只保存计划发布的文件；`local/` 中的密钥、验收包和诊断日志继续留在本机。
3. 保存完整发布提交到 `main`，使用带 `--signoff` 的提交；工作区应干净。
4. 提交后先运行 `pnpm build:win:x64`，用正式配置生成的 Windows 安装包验证正常启动、托盘显示、托盘退出，以及设置 → 关于我们可以检查补丁。打包前工作区须干净；正式包不使用验收标记。
5. 验证无误后先推送 `main`，按第三部分检查续期环境。
6. 将指向完整发布提交的 `v1.1.77` 标签推送到 GitHub，触发 Windows/macOS 打包，结果保留为草稿。续期检查可在打包期间完成。

**推送版本标签只触发打包并生成 GitHub Release 草稿，不会向用户发布更新，也不会同步到下载站。此次按产品负责人要求保留草稿，待版本说明二次编辑后再发布。**

打包结束后，在 GitHub → Releases 打开 `v1.1.77` 草稿，编辑版本说明并保存草稿。维护者明确决定对外发布时，再使用 GitHub 的发布按钮；已发布 Release 会触发下载站同步并采用最终编辑的说明。手动运行 Release 工作流时也应保持 `publish` 不勾选，除非明确要正式发布。

完整新版首次发布时不必额外投放补丁；补丁用于之后的界面修复。

GitHub 生成的正式安装包应再安装验证一次。当前正式构建没有对应投放时，显示无可用补丁是正常的。Windows 安装包验证不能替代 macOS 实机验证。

Release 中新增的基线 JSON 和 runtime ZIP 必须保留，不能删掉或替换成另一轮构建的文件。它们不列入普通用户的下载推荐。

## 五、以后发一次界面补丁

1. 在同一完整版本上只修改允许的界面源码，保存并推送到 main。不要改版本号、依赖、主进程、preload、共享接口或存储格式；涉及这些内容应发完整安装包。
2. Actions → **Renderer Patch** → Run workflow，Branch `main`：
   - `base_tag`：用户安装包的正式标签，例如 `v1.1.77`。
   - `patch_id`：新的唯一编号，例如 `patch.1`，后续为 `patch.2`，不覆盖旧编号。
   - `key_id`：`zen-hotpatch-20261029`。
   - `notes`：给用户看的修复说明。
3. 完成后从工作流 Summary 复制对应平台的 manifest 地址，到 API 面板 → 客户端补丁 → 验证并导入。各平台/架构/安装方式有独立地址，按需要分别导入。
4. 先点击“测试投放”，保存生成的决策编号。Actions → **Patch Policy Signature**：`intent_id` 填这个完整编号，`renew` 不勾选，Branch `main`。
5. 测试客户端填测试投放码，检查补丁，下载后正常退出并重启，确认已应用。
6. 验证无误后在 API 面板依次投放 5%、20%、100%。**每次比例调整都会生成新决策编号，都需要再执行一次签名工作流。**
7. 有问题时用“回滚到安装包界面”或“回滚到此补丁”，同样复制该次的新决策编号签名。客户端检查到后，在下次正常启动执行回退。

本机“暂停补丁”用于单台设备排查；需要所有用户回退时使用 API 面板的回滚决策。自动续期不能替代新投放或回退的审核签名。

## 当前交接边界

本机已准备正式公钥、开关、基线保存/恢复、工作流和操作脚本。服务器上传账号及 GitHub 新配置需由维护者按步骤执行；尚未在这些外部环境实际运行。代码尚未因本说明自动提交、推送或发布。
