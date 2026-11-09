# dsh-offpeak-send · DSH 定时发送插件

把 **DeepSeek Harness Web（DSH Web）** 输入框里的指令安排在合适的时间自动发出，
让 DeepSeek 的 token 花在**谷价时段**（官方口径：谷价 = 高峰价的 5 折）。

在输入框发送键左侧加一个时钟按钮：写好消息 → 选发送时间 → 由 DSH 宿主到点把草稿投递进当前会话。
页面关掉也不会漏，宿主进程保持运行即可。

> 本仓库根目录就是可安装的 DSH bundle 包（`package.json` + `cordis.patch.yml` + `client.js` 等），
> 由本机工作区通过 `scripts/publish-github.mjs` 同步发布。

## 特性

- **位置**：`conversation.input.right` 槽（发送键左侧控件区）+ 输入框卡片下方的
  `conversation.composer.dock` 槽（已定时任务倒计时 + 两步取消）。
- **时间选项**：谷价时段发送（高峰中 → 当前高峰结束后 2 分钟，即 `12:02` / `18:02`；
  已在谷价 → 1 分钟后）、1 小时后、自定义本地时间；每个选项都标注目标时刻是「高峰·贵」还是「谷价·5 折」。
- **峰谷状态**：弹层顶部实时显示「当前高峰 / 当前谷价 · 距切换还有多久」。
- **投递可靠**：复用 DSH 自带 `schedule` 服务（一次性 At 任务，目标为当前会话），
  到点由宿主投递；任务标题带 `⏱` 标记，在「自动化任务」页也能查看/删除。
- **中英双语**，跟随 DSH 语言设置；原创图标与 Plugin Manager 显示元数据齐全。

## 安装

要求：DSH **≥ 0.2.1-rc.2**（Web 形态）。

- 在 DSH Web 的「设置 → 插件」里添加 `github:HansyLin-xCoFe/dsh-offpeak-send`；或
- 克隆本仓库后，在 DSH 会话内用 `plugin_manager` 的 `install_bundle`，target 指向仓库根目录。

安装后刷新一次页面：输入框右下角、模型选择器左侧出现时钟按钮。
（本插件是 link/目录安装都可用的普通 DSH bundle；Host 半为空实现，全部逻辑在浏览器半。）

## 使用

1. 在输入框写要发送的指令（附件暂不支持定时发送）；
2. 点发送键左侧的时钟按钮，看弹层顶部的当前峰谷状态；
3. 选「谷价时段发送 / 1 小时后 / 自定义时间」，底部预览目标时刻与价格标签，点「定时发送」；
4. 草稿清空，输入框下方出现「已定时发送 · 今天/明天 xx:xx（还有 …）」条，点两次「取消」可撤回；
5. 到点 DSH 把消息投递进当前会话并开始干活；页面关掉也不影响。

## 峰谷规则

| 时段 | 北京时间 | 价格 |
| --- | --- | --- |
| 高峰 | 周一至周五 `09:00–12:00`、`14:00–18:00`（不含中国法定节假日） | 全价 |
| 谷价 | 其余所有时段：周末、法定节假日、`12:00–14:00`、夜间 | 高峰价 50% |

依据：DeepSeek 官方定价页（2026-11-09 核对，来源与置信度见 [docs/pricing-notes.md](docs/pricing-notes.md)）。
官方未说明「跨边界请求按开始还是完成时间计价」，故预设高峰结束后多留 **2 分钟**安全余量。

规则常量在 `client.js` 顶部 `PRICING`：

```js
const PRICING = Object.freeze({
  timeZone: 'Asia/Shanghai',
  peakWindows: Object.freeze([
    { startHour: 9, startMinute: 0, endHour: 12, endMinute: 0 },
    { startHour: 14, startMinute: 0, endHour: 18, endMinute: 0 },
  ]),
  holidays: Object.freeze([]), // 中国法定节假日 YYYY-MM-DD；默认空=保守按高峰
  boundaryMarginMs: 2 * 60000,
});
```

`holidays` 默认空：漏列的节假日会被当作高峰 → 预设只会多等、不会在真高峰发送。
把官方放假日填进去即可让那天全天按谷价处理。

## 文件结构

| 路径 | 说明 |
| --- | --- |
| `package.json`、`cordis.patch.yml`、`index.js` | bundle 清单 / Host 行 / 空 Host 半 |
| `client.js` | 浏览器半：时钟按钮 + 时间弹层 + 待发送倒计时条 + 峰谷判定 |
| `locale/`、`icon.svg` | Plugin Manager 显示用的标题、描述与图标 |
| `scripts/test-client.mjs` | 无浏览器自检（37 项：清单/语法/峰谷判定/预设/标题/过滤/错误映射） |
| `docs/pricing-notes.md` | DeepSeek 峰谷价格调研（时段、价目、来源、置信度） |
| `docs/verification.md` | 独立验证报告（安装、契约、槽位、测试、限制） |
| `LICENSE` | MIT |

## 自检

```powershell
node scripts/test-client.mjs   # 37 项，全部通过
node --check client.js         # 浏览器半语法
```

## 已知边界

- 宿主 `schedule` 服务负责投递，**DSH 宿主进程必须运行**；页面可以关。
- 定时消息进入会话时带宿主自带的 `[SCHEDULE REMINDER]` 固定说明文字，与手动发送呈现略有不同。
- 草稿附件、行内引用 chips 不随定时任务保存（附件会拦截提示）。
- 一条用户消息会触发多次 API 请求，**每次按自身时刻计费**：定时只保证开始时刻在谷价内，长任务可能跨入高峰。
- 子代理（delegate）会话不能创建定时任务（宿主返回 `subagent_session`）。
- 法定节假日按谷价，但官方没给日历；默认按高峰保守处理（见上）。
- 定时发送最小提前量 1 分钟；取消需两步确认；任务也会出现在 DSH「自动化任务」页。

## 文档

- 峰谷调研：[docs/pricing-notes.md](docs/pricing-notes.md)
- 独立验证：[docs/verification.md](docs/verification.md)

## License

MIT。本项目不是 DeepSeek 官方项目；定价/时段以 DeepSeek 官方文档为准。
