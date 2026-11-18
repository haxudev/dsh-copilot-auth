# GitHub Copilot 本地升级版 1.4.1-local.1

基于 MIT 授权的 `@inventec/dsh-copilot-auth@1.2.26` 二次开发。保留上游版权、包名和插件行 ID，以替换旧版而不是挂载第二套相同路由。此版本不是上游 npm 正式发布。

## 本轮根因与修复

2026-11-18 的已登录账号只读 `/models` 诊断返回 40 条原始模型，其中 18 条通过当前 picker/policy 可用性规则；旧静态目录只能解析其中 12 条。**12 是目录交集数，不是账号只开放 12 个模型。** 账号已经报告 `gpt-6.2-sol` 和 `gemini-4-carbon`，漏项根因是静态目录滞后，不是已证实的账号权限问题。

1. 保留 npm latest 静态目录更新，在其外追加基于实时账号元数据的受限适配。
2. 新条目须同时具备明确 chat、工具与流式能力、受支持的 HTTP endpoint、有限正整数 context/output 限额。协议来自 `supported_endpoints`；默认拒绝歧义，只对下述两个已实测 ID 的确切双端点组合选择 Responses。
3. 新模型只增不覆盖，既有配置、模型顺序、定制、自动全目录模式不变。
4. 明确展示账号报告数、可解析数、本次实时补目录数，以及未解析 ID 和原因；不再用目录交集冒充账号总数。
5. 账号原始响应、授权令牌不写目录/缓存。元数据经过深层白名单，预览只驻内存；账号缓存仍仅保存 IDs、时间戳和意图版本。只有确认应用的受限模型条目会进入事务状态与持久增量。
6. 不接受响应中的自定义 URL/headers，不添加 SDK 依赖，不变更设备码授权、不修改 app.asar、不伪造新版客户端来解锁权限。

### 当前真实元数据可适配的六个新 ID

| ID | 选用的协议 | context window | max output |
|---|---|---:|---:|
| `gpt-6.2-sol` | `/responses` | 1,050,000 | 128,000 |
| `gemini-4-carbon` | `/chat/completions` | 1,000,000 | 64,000 |
| `gemini-4-hydrogen` | `/chat/completions` | 1,048,576 | 65,536 |
| `gpt-5.6-sol-fast` | `/responses` | 1,050,000 | 128,000 |
| `mai-code-2` | `/responses` | 1,050,000 | 128,000 |
| `mai-code-2-flash` | `/responses` | 1,050,000 | 128,000 |

两款 MAI 同时报 `/chat/completions` 和 `/responses`。2026-11-18 用宿主 pi-ai 1.3.0、同一 Copilot 账号和 `Reply exactly OK` 分别实测：两款在 Responses 均返回 `OK` / stop（各 212 输入、5 输出 token），在 Chat Completions 均返回 HTTP 400 `no model endpoints available given user constraints`。新版仅为这两个确切 ID 的已验证双 HTTP 端点组合选择 Responses；其他歧义组合不作猜测，不改动已有目录。

2026-11-18 已通过临时最小探针，用动态转换条目、宿主当前 pi-ai 1.3.0 的实际协议实现和原账号凭据分别发送一次 `Reply exactly OK`（low reasoning、最多 1,024 输出 token、零重试）：

| 模型 | 实际宿主 API | 结果 | token 用量（输入/输出） |
|---|---|---|---:|
| `gpt-6.2-sol` | `openai-responses` | `OK` / stop | 212 / 5 |
| `gemini-4-carbon` | `openai-completions` | `OK` / stop | 263 / 5 |

该探针验证基础文本推理兼容，不代替升级后正式路由注册验收，也未测试工具调用、视觉、超长上下文或所有推理档位。临时诊断插件已卸载，凭据未导出。

`cost: 0` 仅为 pi-ai 兼容所需的 token 成本计账占位，**并非免费或不扣 Copilot 额度的承诺**。上下文窗口与输出上限来自服务元数据；还可能存在服务器 prompt、套餐和请求层限制。

## 保留的 1.3 修复

- 现代目录 `chat:<id>` 与裸 ID 归一；可写目录保持原 schema、未知数据和非聊天条目。
- Electron ASAR 使用原有进程内注册表机制；已确认注册的持久增量参与后续目录去重。
- “只补充最新模型”保留暂未被账号报告的既有模型，不删除或清空定制。
- `models` 缺失/空列表继续表示自动全目录；不同时物化非空 models 与 modelOverrides。
- 自动模式核对宿主实际端出的模型；仅 base 路由时允许安全刷新快照，验证失败如实返回部分完成。
- 预览与应用绑定配置 revision、授权意图和有效期；授权漂移、陈旧证据、并发编辑安全拒绝。

## 静态目录来源

- 包：`@earendil-works/pi-ai@1.5.2`，获取日期 2026-11-18，内置 27 条受支持聊天条目。
- URL：https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.5.2.tgz
- 源 tarball 完整性：`sha512-2tWPSnV3qzfiDIY3aWluBag3vC++Vs+VsXt/UquSU5onPMohPih72FUhIhaqmDdMYubOgB3Byl9uF4Vk40JLvQ==`
- 在线每次预览仍读取 npm latest；静态来源和实时账号发现来源并列显示。
- 网络失败明确显示本地/缓存回退，内置快照仍须显式选用；缺少实时元数据时不凭缓存 ID 猜新模型描述。已有可信持久目录增量仍可正常解析。

## 安装与使用

通过 DSH 插件管理安装本地 tarball。替换已加载同名包后，**必须完整退出并重新打开 DSH Desktop**；仅刷新网页不足以加载新宿主模块。

重启后进入“设置 → GHC设置”，确认标题显示 `1.4.1-local.1`，点击“只补充最新模型”，核对来源、真实计数及清单后应用。没有授权时先按原设备码流程登录。账号权限、企业策略与服务端限制不会被绕过。

自动全目录不需要新建显式列表；临时 displayName 刷新通过 settings API 的 revision 检查，并恢复原字段是否存在。原 user 层没有路由时可能保留语义中性的空对象层级，不写 models/modelOverrides，并发编辑优先保留。

## 工具调用

可选工具 `copilot_models` 与 UI 共用真实 service/transaction，不提供登录、退出或授权确认。

```json
{"action":"preview"}
```

`preview` 始终使用非破坏补充策略，即使工具网关补齐 `selectedIds: []` 也不会变成空目标管理。手动精确选择须显式使用 `preview-manual` 和 `selectedIds`；可能删除未选模型，应先审查预览，空目标仍受确认门禁保护。使用返回的 `previewId` 和 `operationId` 调用 `apply`；`status` 查询未知提交结果；`retire` 放弃活动操作，不盲目重复写入。

## 验证边界

- 测试覆盖元数据白名单、缺失/未知/歧义协议、错误限额、重复 ID、已有模型不覆盖、缓存安全降级、真实内核事务、自动模式保护、UI 独立计数与中英对称。
- 构建后检查实际分发包内新增适配器、UI bundle 和版本一致性。
- 浏览器调试尚未授权，不声称完成视觉、明暗主题或窄屏测试。账号只读诊断不依赖浏览器，不能把缺浏览器权限误当作未诊断账号。
- 本次不升级 DSH 内置推理引擎。发现、注册、列表可见、真实推理分别验收；不承诺未知新协议能被旧宿主调用。

## 回退

通过插件管理重新安装上一包 `1.4.0-local.1` 或上游 `@inventec/dsh-copilot-auth@1.2.26`，然后重启。回退代码不会自动删除已经持久化的新增模型/目录，仍需按界面预览管理。凭据使用宿主原有库，不导出、不重写，无需提供个人令牌。
