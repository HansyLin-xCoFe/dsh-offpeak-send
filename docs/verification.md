> 发布说明：本文件由发布脚本从作者工作区同步而来，本机绝对路径已替换为 `<workspace>` / `<home>`。

# dsh-offpeak-send · 独立验证报告（verification，round 2）

- 验证者：`verifier`（独立验证 teammate；未参与编写；未修改 `plugin/*` / `scripts/*`）
- 本报告为 round 2（修复后复验）：2026-11-09 14:10 (Asia/Hong_Kong)。round 1（14:05，结论 NOT PASS）的原始发现保留在 §3 并标注 **FIXED + 复验方式**。
- 被验状态（磁盘快照）：`plugin/client.js` 14:05:46 / 52,583 B；`scripts/test-client.mjs` 14:05:59 / 18,783 B；`plugin/README.md` 14:06:09 / 5,179 B；项目 `README.md` 14:06:09 / 6,513 B；`plugin/package.json` 13:44:03（link 安装 → `<workspace>/projects/dsh-offpeak-send/plugin`，profile `web`）。
- **总体结论：PASS（可上），无阻塞缺陷。** round 1 的 D1（High）已修复且按原复现手段复验通过；D2（Low）、D3（Info）也已修复并有回归覆盖。剩余风险均为低风险/外部假设；主要限制仍是「无浏览器控制 → 实际像素/交互/live 槽位不可验」「页面需刷新才加载本版本」「schedule 端到端投递未实测」。

## 1. 复验结果速览（round 2）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | `node scripts/test-client.mjs` | ✅ **37/37 passed**（exit 0；round 1 为 35 项） |
| 1b | `node --check plugin/client.js` | ✅ exit 0 |
| 1c | 无浏览器物化/渲染模拟（round 1 为此专门搭建的 harness，**直接针对当前文件**，不再需要修补副本） | ✅ **16/16 checks passed**（弹层高峰/谷价两分支、目标 `12:02`/`20:01`、价格标签、附件/空稿拦截、待发送条、effect 清理） |
| 1d | D1 残留拼写扫描 | ✅ `\bofsendDurationText\b` 出现 0 次；定义 `function offsendDurationText`（client.js:534），全部调用点均为双 f |
| 2 | D2 独立 probe（不复用 Lead 测试）：边界用例 + 整周 10s 步长扫描 + 节假日规则 + preset 分发 | ✅ 全部通过（详见 §3.2） |
| 3 | D3 `subagent_session → error.subagent` 映射 + zh/en 文案 | ✅ `client.js:332` 映射；zh:379 / en:430 文案；两 README 已把「子代理会话」写入限制说明 |
| 4 | 自检新增回归检查有效性 | ✅ 已读实现：check(a) 对比「所有 `(ofsend|offsend)*` 调用名」与 `function <name>(` 定义集合（round 1 的 D1 会在该断言下失败）；check(b) 对北京周一+周六每 30s 扫全天并断言 `ofsendCheapPresetTarget(now)` 目标非高峰 |
| 5 | 安装状态（不变） | ✅ profile link 依赖 + bundle 列表；`include:dsh-offpeak-send` enabled/active；locale meta/icon 资源合法（渲染未验，见 §5） |
| 6 | Live Host 客户端模块发布 | ✅ graph 新 rev `bb193b53ae63`；按 combo URL 取回 52,656 B，去 sourcemap 尾后与当前磁盘文件**完全一致**，且**不再包含** D1 拼写 |
| 7 | 契约/主题/规则审查（round 1 已逐项核对，修复未改动相关区域） | ✅ 维持 round 1 结论（§2） |
| 8 | schedule create→view→delete 端到端 | ⛔ **not run** — 本会话为 delegated subagent，平台拒绝 `schedule_create`/`schedule_list`（`{"code":"subagent_session"}`）；`~/.dsh/storages/schedule.json` 不存在（无遗留任务） |

## 2. 已验证事实（契约/集成，round 1 证据 + round 2 复核）

1. **安装状态**：`plugin_manager list_plugins`（offset=200 页）：`include:dsh-offpeak-send` → `enabled:true, fiberPhase:"active", patchId:"dsh-offpeak-send"`；`list_bundles` → `enabled:true, installed:true, version:"0.1.0", source:"link:<workspace>\\projects\\dsh-offpeak-send\\plugin"`。profile `~/.dsh/profiles/web/package.json` 含 link 依赖且 `dsh.profile.bundles` 含 `dsh-offpeak-send`，`node_modules/dsh-offpeak-send` 为指向工作区 plugin 的符号链接；`.plugin-manager/logs/operation-s4phKs/pnpm.log`（13:47:39）记录 link 安装成功。
2. **显示资源**：`locale/zh.json`、`locale/en.json` 均有非空 `meta.title/meta.description`；`exports` 含 `./locale/*.json`、`./icon`，`files` 含 `locale/*.json`、`icon.svg`、`README.md`、`LICENSE`；`icon.svg` 1,011 B 合法 SVG（<256 KiB）。按 `cordis-plugin-development/references/host-plugin.md`，Plugin Manager/Settings 从这些导出读标题/描述/图标——资源侧满足契约；**实际渲染行未验证**（无浏览器）。
3. **槽位注册契约**：`conversation.input.right` / `conversation.composer.dock` 在 `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:347,363` 均为 `kind:'list', scope:'session'`；插件注册的 `id/order/locale/inject` 与官方 `dsh-client-ui-chat` 的同槽注册（`activity` order 0、`usage` order 1，`dsh-client-ui-chat/lib/client.js` offset≈679,430）同构；`dsh-cordis-client-runner` 内嵌 `StoredEntry` 类型同样列出 `id?/order?/locale?/inject?/select?`。当前注册：`input.right` id `dsh-offpeak-send` order 30；`composer.dock` id `dsh-offpeak-send-pending` order 30；`locale:'dsh-offpeak-send'`。
4. **session 槽位标准 props**：`PropsRuntime = OwnerOf & KeyProps & SlotInjectFace & ScopeStandardProps`；`ScopeStandardProps<'session'> = SessionStandardProps & GlobalStandardProps`。`dsh-client-ui-session` 增补 `sessionId: SessionId` 等；`dsh-client-ui-conversation` 增补 `useInput/inputActions/useConversation`；`dsh-api-remote-access/lib/types/client/mount.d.ts:61-66` 增补 `useRemoteAccess`（「Present on every slot component's props, whatever its scope」）。插件用到的 `props.sessionId/useInput/inputActions/useRemoteAccess` 全部成立；`InputState` 确有 `draft/attachmentIds/phase`（`contract/input.d.ts:273-298`），`InputActions.setDraft` 存在（同文件 239-263）——附件拦截/清空草稿逻辑引用字段正确。
5. **owner 页 `useRemoteAccess` 恒 true**：`dsh-api-remote-access/README.md:68`「Every answer is true for the owner; a non-owner page without an injected baseline … answers false」；本 GUI 为本机 loopback owner 页，故 `schedule/create`、`schedule/catalog`、`schedule/edit` 门槛不会隐藏控件（契约+部署形态推断）。
6. **Host schedule Remote/Typert 契约**：`dsh-schedule/lib/typert.remote-client.d.ts:10-31` 声明 `schedule.create(request)`、`edit(request)`、`catalog()` 返回 `Promise<RemoteResult<…>>`；`RemoteResult = {ok:true,value} | {ok:false,error:RemoteFailure}`（`dsh-typert-protocol/lib/types/types.d.ts:110-116`），`RemoteFailure.details` 存在（`remote-error.d.ts`）。`ScheduleCreateRequest={title,prompt,timing,target?}`（`types.d.ts:419-428`），`timing:{kind:'at',at:AtInput}`，`AtInput` 接受 ISO 字符串（`types.d.ts:130-139`），`target:{kind:'session',sessionId}`，`edit({id,action:'delete'})`（`types.d.ts:485-495`）——客户端 `create({title,prompt,timing:{kind:'at',at:iso},target:{kind:'session',sessionId}})`、`edit({id,action:'delete'})` 均合法；`schedule/input-invalid` 的 `details.code` 含 `not_future/frequency_too_high/invalid_time_zone/time_out_of_range/subagent_session`（`types.d.ts:244-245`），客户端映射见 D3。
7. **`ctx.remote.$on('schedule/changed')`**：`dsh-api-remotes/lib/types/remote-events.d.ts:117-119` 的 `API_REMOTE_FORWARDED_EVENTS` 允许列表包含 `{event:'schedule/changed',mode:'emit'}`；`TypertClientRemote.$on(event,listener): () => void`（`types.d.ts:519-535`）返回 disposer，插件在 `ctx.effect` 中收集并在卸载时清理。
8. **主题/规则**：CSS 使用 11 个 `--dsw-alias-*` token，全部存在于 `dsh-client-ui-theme` 的 414 个 token 名单（11/11）；无裸色值；无 `@deepseek-ai/*` client import（仅 `require('react')` + 可选 `require('react-dom')`）；弹层用 `ReactDOM.createPortal(..., document.body)`（client.js:929-931 区域）符合 composer 固定层必须 portal 的规则；样式/字典/feed/事件/组件内 timer+listener 均有 cleanup（模拟中全部 effect disposer 执行无异常）。
9. **Live Host 发布**：`GET http://127.0.0.1:3080/plugins/events`（公共 SSE）graph release `0.2.2-rc.1`，`dsh-offpeak-send` entry：`rev:"bb193b53ae63"`、`immediately:true`、`inject:["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-api-remotes"]`（3 个依赖均在 graph 中存在）。按该 rev 的 combo URL 取 bundle：HTTP 200 / 52,656 B；去掉终止 `;` 与 `//# sourceMappingURL=…` 后与磁盘 client.js 完全一致（trimEnd 比较 true），且 `ofsendDurationText` 出现 0 次 → **HMR 已发布修复后的当前文件；页面刷新即加载该版本。**

## 3. Round 1 缺陷与修复复验

### D1（原 High，**已修复**）：弹层未定义标识符 `ofsendDurationText`
- 原文：client.js:757/758/875/879/908 调用单 f 的 `ofsendDurationText`，定义为 line 523 双 f `offsendDurationText` → 弹层渲染抛 `ReferenceError`，slot 错误边界（`dsh-client-ui-renderer/lib/client.js:26311` `slot entry crashed in '<slotKey>'`，渲染 `<div data-slot-error>` 空占位）会吞掉控件，主功能失效。
- 复验：① 扫描 `\bofsendDurationText\b` → **0 次**；定义/全部调用均为 `offsendDurationText`（定义现于 527/534 行附近，行号因新增文案/回归检查略移）。② round 1 的无浏览器物化+渲染模拟**直接跑当前文件**（不再用修补副本）：`application → factory → apply(fakeCtx) → 以契约 props 渲染 input.right 组件并展开弹层`，**16/16 checks passed**（此前同一 harness 对旧文件 4 项 `ReferenceError` 失败）。③ 新增自检 check「every ofsend/offsend helper call has a matching function definition」会在旧文件上失败（已读实现），37/37 现通过。
- 状态：**FIXED（已复验）**。

### D2（原 Low，**已修复**）：谷价预设可把目标排进高峰开始前 60 秒内
- 原文：`ofsendCheapPresetTarget` 在谷价时直接 `now+60s`，在 08:59:00–09:00、13:59:00–14:00 会落到高峰（与 README「never send inside a real peak window」不符）。
- 修复后代码（client.js:208 起）：peak 时取当前 peak end+margin；谷价时 `candidate=now+60s`，若 candidate 是 peak 则取该 peak end+margin；最后 `ofsendEnsureFuture`。
- 复验（独立 probe，直接加载当前纯函数块）：`08:59:00/08:59:30/08:59:59 → 12:02`、`13:59:00/13:59:30 → 18:02`、`10:00 → 12:02`、`20:00 → +60s`、`周六 10:00 → +60s`、`preset('cheap')` 分发一致；**北京整周（周一起 7×24h，10s 步长）扫描：目标落在高峰 0 次，且目标恒严格未来**；`holidays:['2026-11-09']` 规则下该日 10:00 → +60s 且目标非高峰。Lead 新增的回归（边界用例 + 周一/周六 30s 全天扫描）已读且有效。项目 README 已改写该「保守、不会多花钱」表述相关段落（14:06:09 版本）。
- 状态：**FIXED（已复验）**。

### D3（原 Info，**已修复**）：`subagent_session` 未映射专属文案
- 原文：`ofsendErrorKey` 对 `schedule/input-invalid` 的 `details.code='subagent_session'` 落到通用 `error.failed`。
- 复验：`client.js:332` `if (detailCode === 'subagent_session') return 'error.subagent';`；zh（379 行）/en（430 行）均有 `error.subagent` 文案；独立 probe 断言映射返回 `'error.subagent'`，且 `not_future`/`target-archived` 旧映射未回归；`plugin/README.md` 与项目 README 的「限制」小节已补子代理会话说明。
- 状态：**FIXED（已复验）**。

## 4. 风险（均为低/外部假设，无阻塞）

- **R1（中低）外部定价假设**：峰谷窗口/折扣为外部事实。独立抓取官方定价页（2026-11-09，`https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`）确认「空闲时段价格为高峰时段价格的一半；北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰；其余时段（含周末及中国法定节假日全天）为空闲」，与 `client.js` 的 `PRICING` 与 `docs/pricing-notes.md` 一致。官方保留调价权；`holidays` 默认空=漏列节假日按高峰（只会多等，且 D2 修复后预设目标不会落入高峰）。
- **R2（低）计费时刻语义**：官方未说明跨边界请求按开始/完成计费；插件以 2 分钟余量缓解；长任务/多轮请求各自计费，README 已披露。
- **R3（低）ReactDOM 缺失回退**：`require('react-dom')` 失败时弹层不 portal（受 composer containing block 影响）；其余官方插件同样 require react-dom，风险很低。
- **R4（低）引用 chips 语义**：定时保存 `InputState.draft` 的剪贴板投影文本；行内引用 chips 会降级为文本（README 已说明）；附件有拦截，引用无拦截。
- **R5（流程）自检覆盖**：新增的调用名-定义一致性检查补上了 round 1 的盲区；仍建议（非必须）将 `offsendWhenText/offsendDurationText` 移入 PURE HELPERS 做行为断言，并在 CI 中跑模拟渲染 harness（本次为临时 harness，未入库）。

## 5. 明确未验证 / 限制（与 round 1 相同，未因修复而改变）

1. **无浏览器控制**：未打开/刷新页面，未验证渲染像素、实际交互（点击时钟、预设切换、提交、「定时发送」真实创建）、a11y、图标显示。`cordis_inspect_query(platform=client, provider=Slots/Theme/Service)` 共 6 次调用均 10000 ms 超时（「Open or reconnect the Harness page」），**拿不到 live occupant 行/active 状态**；也无法确认 `conversation.composer.dock` 的 shipped occupants（官方 ui-chat 注册 `activity`/`usage`，conversation 自身注册 queue/todo）在实时树中的实际顺序。
2. **页面模块版本错位**：当前已打开页面仍持有改造前旧 client.js（Lead 说明），**需要刷新页面**才会加载本报告验证的 bb193b53ae63 版本；刷新前旧页面上的点击行为不代表本版本。
3. **Host 侧崩溃日志不可得**：当前 run（node PID 25304，13:30 启动，`--no-open --port 3080`）无可见 stdout/stderr 日志文件；`~/.dsh/logs/webui-*.log` 最后写入 11:39（早于 13:47 安装）；近 3 小时 `~/.dsh` 文件中无插件崩溃记录。client 渲染错误只进浏览器 console + slot 错误边界，Host 不落盘——D1 的崩溃证据由无浏览器模拟复现替代（修复后该模拟通过）。
4. **schedule create→view→delete not run**：本会话为 delegated subagent，`schedule_create`/`schedule_list` 被平台拒绝（`subagent_session`）；`~/.dsh/storages/schedule.json` 不存在 → Host 上从未创建过定时任务（无遗留/无污染）。标题 ≤120、prompt 非空、`at` 必须未来等约束已按 `dsh-schedule` 类型静态核对（§2.6）；「创建→投递→会话收到→agent 开始工作」端到端未实测。
5. **真实计费未验证**：只验证窗口函数与官网页一致，未用真实账单验证跨边界/多请求计费。
6. **显示元数据渲染未验证**：locale JSON/icon 文件与导出正确，但 Plugin Manager/Settings 行标题、描述、图标实际显示未看。
7. 暗色/亮色、窄屏、移动端观感未验证。

## 6. 复现命令摘要

```powershell
cd <workspace>\projects\dsh-offpeak-send
node scripts/test-client.mjs            # 37/37 passed (exit 0)
node --check plugin/client.js           # exit 0

# 无浏览器物化+渲染模拟（临时 harness，未改插件；直接读当前 client.js）
node %TEMP%\dsh-offpeak-verify\simulate-client.mjs   # 16/16 passed
# 独立 D2/D3 probe（纯函数块：边界 + 整周 10s 扫描 + 节假日 + 错误映射）
node %TEMP%\dsh-offpeak-verify\probe-fixed.mjs       # all checks passed

# Live Host graph / bundle 一致性（公共 SSE）
curl.exe -s --max-time 6 -o %TEMP%\plugins-events.txt http://127.0.0.1:3080/plugins/events
# graph: dsh-offpeak-send rev=bb193b53ae63, immediately:true, 3 inject deps present
# combo bundle HTTP 200, 去 sourcemap 尾后 === 磁盘 client.js，且不含 ofsendDurationText
```

> round 1/2 的临时 harness（`%TEMP%\dsh-offpeak-verify\`）已在会话收尾时删除；上面的命令是删除前复验时的记录，重建请按 §3 的检查要点自行物化。

- 交付文件：本报告（`docs/verification.md`）。round 1/2 的临时验证脚本均在系统 TEMP（`%TEMP%\dsh-offpeak-verify\`），未写入工作区，插件/脚本文件未被验证者修改；收尾时已按清理要求删除该临时目录。


## 7. Lead 补充（报告交付后）

- 2026-11-09 14:20 在主会话用只读 model 工具 `schedule_list({ active: true, limit: 20 })` 探测宿主 Schedule 服务：返回 `{"items":[],"shown":0,"total":0,"limit":20,"offset":0}`——服务已挂载且可读、当前没有任何任务（与 §5.4 的 `schedule.json` 不存在一致），也确认没有验证遗留任务。`create → view → delete` 往返仍为避免污染会话而未跑。
- 临时 harness 已从 `%TEMP%\dsh-offpeak-verify\` 删除。