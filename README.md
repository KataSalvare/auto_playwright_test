# 订单 Playwright 自动化脚本

项目使用 TypeScript + Playwright，业务页面统一通过 `jing-testid` 定位。

先按使用场景选择入口：

| 场景 | 命令 | 说明 |
|---|---|---|
| 单次订单流程 | `npm run automation -- --fixture=first-order` | 执行一条首单流程 |
| 两条内置流程 | `npm run automation:fixtures` | 按顺序执行首单和非首单 |
| 命令行批量队列 | `npm run automation:queue` | 读取配置中的链接列表，按并发数执行 |
| 可视化快速测试 | `npm run quick-test:start` | 在浏览器页面中生成链接、设置次数并执行并发测试 |

快速测试页面和命令行自动化使用同一套 `runOrderFlow` 核心流程；两者的区别只是入口和结果展示方式。

## 远程批量 API

项目内置 HTTP API，服务端可以一次提交多条业务链接。接口是异步的：提交后立即返回 `jobId`，再通过查询接口获取每条链接的执行状态。

完整接口文档见：[docs/automation-api.md](/Users/much/代码/仿朝发可回溯/docs/automation-api.md)。

### 启动 API 服务并启用结果回调

回调接收端由业务服务提供，本项目不需要额外启动一个“回调服务”。启动本项目的 API 服务时配置回调地址和回调鉴权信息，正式 API 任务完成后会自动向该地址发送结果。

首次部署先安装依赖：

```bash
npm install
npm run test:install
```

每次打开新的终端窗口后，先设置以下环境变量。真实地址和密钥不要写入 README、代码或 Git：

```bash
export AUTOMATION_API_KEY='<API服务鉴权密钥>'
export NW_CALLBACK_URL='<回调接口完整地址>'
export NW_CALLBACK_API_KEY='<回调接口鉴权密钥>'
export NW_CALLBACK_TIMEOUT_MS='10000'
# 可选：默认开启，每 24 小时自动清理一次
export AUTOMATION_CLEANUP_ENABLED='true'
export AUTOMATION_CLEANUP_INTERVAL_MS='86400000'
```

启动 API 服务：

```bash
npm run api:start -- --host 0.0.0.0 --port <API端口>
```

服务启动后会在后台运行。检查 API 和回调配置是否生效：

```bash
curl 'http://127.0.0.1:<API端口>/api/automation/health'
```

正常响应中的两个配置项都应为 `true`：

```json
{
  "apiKeyConfigured": true,
  "callbackConfigured": true
}
```

查看运行和回调日志：

```bash
tail -f 'output/quick-test-server.log'
```

API 任务开始、任务异常和回调结果会另外写入：

```bash
tail -f 'output/automation-api.log'
```

服务启动时会执行一次数据清理，运行期间默认每 24 小时执行一次。默认保留策略如下：成功视频 7 天、失败视频 1 天、回调失败视频 30 天、API 任务记录 30 天、前端测试数据 3 天；日志超过 50MB 会轮转，轮转日志保留 14 天。正在执行、等待回调或发送中的任务不会被清理。

手动预览清理结果（不会删除文件）：

```bash
npm run api:cleanup -- --dry-run
```

确认后手动执行清理：

```bash
npm run api:cleanup
```

如需关闭服务内置定时清理：

```bash
export AUTOMATION_CLEANUP_ENABLED='false'
```

查看状态、重启和停止服务：

```bash
npm run api:status -- --port <API端口>
npm run api:restart -- --host 0.0.0.0 --port <API端口>
npm run api:stop -- --port <API端口>
```

重启服务前也必须在当前终端设置上述环境变量，否则正式 API 任务会因缺少回调配置而被拒绝。

### 调用 API

提交批量任务：

```bash
curl -X POST '<API服务地址>/api/automation/jobs' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <API服务鉴权密钥>' \
  -d '{
    "concurrency": 2,
    "dryRun": false,
    "links": [
      {"name": "<订单号1>", "url": "<完整业务链接1>"},
      {"name": "<订单号2>", "url": "<完整业务链接2>"}
    ]
  }'
```

查询任务：

```bash
curl '<API服务地址>/api/automation/jobs/<jobId>' \
  -H 'Authorization: Bearer <API服务鉴权密钥>'
```

请求约束：一次最多 50 条链接，并发数为 1–10；服务默认最多同时运行 4 个浏览器任务，可通过 `QUICK_TEST_MAX_CONCURRENCY` 调整。正式 API 任务的每条链接必须提供订单号 `name`，并包含 `temp-lp-jing` 和现有脚本要求的必要参数。任务完成后脚本服务会向 `NW_CALLBACK_URL` 回调结果；`dryRun: true` 只做链接校验，不启动浏览器也不发送回调。API 成功结果中的 `videoUrl` 是相对于 API 服务地址的路径，例如 `/videos/...mp4`，服务端拼接 `http://远程电脑IP:4173` 即可访问；API 视频文件保存到 `output/videos/`。

建议在生产环境通过防火墙或反向代理限制访问来源，并使用 HTTPS；业务链接包含手机号、姓名和身份证参数，API 请求和日志都应按敏感数据处理。

## 安装

```bash
npm install
npm run test:install
```

只有需要生成 MP4 时才需要安装 `ffmpeg`：成功视频始终需要转码；当 `deleteFailedVideo=true` 时，失败视频也需要转码后才能保留。只做链接校验、单元测试或删除失败视频的流程验证时可以暂不安装。

默认使用 Playwright 的 headless shell，不会启动 macOS 的 Google Chrome 应用。
如果从 Codex 沙箱执行订单流程，脚本会在启动浏览器前直接提示切换到普通终端，
不会创建 Chrome/Chromium 子进程。

如果确实需要本机 Google Chrome，请在 macOS 的 Terminal.app 或 iTerm2 中显式指定：

```bash
PW_CHANNEL=chrome npm run automation:terminal -- --fixture=first-order
```

使用 Playwright 原生 Video 录制。产品选择完成后等待 2–3 秒记录裁剪点，浏览器继续监控 `success`；流程结束后成功视频按裁剪点转码并输出到：

```text
output/videos/success/<订单号>-success-<时间戳>.mp4
```

自动化浏览器固定模拟 iPhone 15，页面和录像尺寸均为 `392×852`。

## 调试配置

修改根目录的 [automation.config.ts](/Users/much/代码/仿朝发可回溯/automation.config.ts)：

```ts
export const automationConfig = {
  headless: true,           // true：后台运行；false：显示浏览器，方便调试
  deleteFailedVideo: true,  // true：保留失败视频；false：删除失败视频
  outputDir: 'output/videos',
};
```

`deleteFailedVideo` 的名称容易反向理解：设为 `true` 时会保留失败视频并移动到 `failed` 目录，设为 `false` 时才会删除失败视频。

配置中不要默认填写 `browserChannel: 'chrome'`。如果需要显式使用本机 Chrome，
通过 `PW_CHANNEL=chrome` 覆盖，并在普通 macOS 终端中启动。

当 `deleteFailedVideo=true` 时，未出现 `success` 的视频会重命名并保留在：

```text
output/videos/failed/<订单号>-failed-<时间戳>.mp4
```

当 `deleteFailedVideo=false` 时，未出现 `success` 的视频会直接删除。

单次运行也可以覆盖配置：

```bash
npm run automation -- --fixture=first-order --headed
npm run automation -- --fixture=first-order --headless
npm run automation -- --fixture=first-order --keep-failed-video
npm run automation -- --fixture=first-order --delete-failed-video=true
```

## 执行订单流程

### 测试脚本位置

单条订单的命令行入口是：

```text
scripts/order-flow.ts
```

它由 `npm run automation` 调用；实际订单流程实现位于：

```text
src/automation/order-flow.ts
```

两个内置夹具的批量入口是：

```text
scripts/run-fixtures.ts
```

常用运行方式：

```bash
# 首单：shunxu=1
npm run automation -- --fixture=first-order

# 非首单：shunxu=2
npm run automation -- --fixture=repeat-order

# 两条夹具连续执行
npm run automation:fixtures
```

### 使用普通终端启动 Chrome

只有显式使用 `PW_CHANNEL=chrome` 时才需要本节。Chrome 不要从 Codex 沙箱终端启动，
请在 macOS 的 Terminal.app 或 iTerm2 中执行：

```bash
cd "/Users/much/代码/仿朝发可回溯"
PW_CHANNEL=chrome npm run automation:terminal -- --fixture=first-order
PW_CHANNEL=chrome npm run automation:terminal -- --fixture=repeat-order
```

也可以直接双击，或在普通终端执行：

```bash
./scripts/run-automation-terminal.command --fixture=first-order
```

该入口只负责切换到项目目录并调用现有 `scripts/order-flow.ts`，不会改变测试流程。

普通终端直接执行内置测试链接：

```bash
npm run automation -- --fixture=first-order
npm run automation -- --fixture=repeat-order
```

也可以直接传入完整 URL：

```bash
npm run automation -- "https://your-test-url.example.com/..."
```

常用参数：

```bash
npm run automation -- --fixture=first-order --seed=20260818
npm run automation -- --fixture=first-order --profile=reader
npm run automation -- --fixture=first-order --input-strategy=chunked
npm run automation -- --fixture=first-order --product=upgrade
npm run automation -- --fixture=first-order --wait-agreement=false
npm run automation -- --fixture=first-order --wait-product=false
npm run automation -- --fixture=first-order --headed
npm run automation -- --fixture=first-order --dry-run
```

两条内置链接的流程映射：

| 夹具 | `shunxu` | 流程 |
|---|---:|---|
| `first-order` | 1 | 首单流程：手机号、姓名、身份证、社保/续保、协议和产品 |
| `repeat-order` | 2 | 非首单流程：协议和产品 |

运行日志会按以下编号标注每一步：

首单流程：

1. 步骤开始前随机等待 1–3 秒，输入手机号
2. 处理手机号确认弹窗
3. 等待进入实名信息
4. 输入姓名
5. 输入身份证
6–8. 步骤 5 后进入协议/社保/续保随机分支：当社保和续保均为 1 时，约 80% 用户直接点击按钮跳过 6–8，约 15% 用户浏览后只勾选协议，约 5% 用户浏览后依次勾选协议、选择社保和续保；其他场景固定执行完整浏览方案
9. 点击完善信息
10. 触发协议弹窗后随机浏览等待 1–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断同意按钮；用户关闭蒙层后仍可继续浏览再点击
11. 触发产品弹窗后随机浏览等待 1–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断产品按钮；用户关闭蒙层后仍可继续浏览再点击
12. 浏览器继续保留并监控成功 Toast，context 关闭后完成原生视频并按裁剪点生成 MP4

非首单流程：

1. 步骤开始前随机等待 6–9 秒，等待页面稳定
2. 约 80% 用户直接点击按钮；约 20% 用户按随机真人画像小步浏览到协议位置，视口内时停留 1–3 秒后勾选协议，再随机等待 1–2 秒点击完善信息
3. 点击完善信息
4. 触发协议弹窗后随机浏览等待 1–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断同意按钮；用户关闭蒙层后仍可继续浏览再点击
5. 触发产品弹窗后随机浏览等待 1–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断产品按钮；用户关闭蒙层后仍可继续浏览再点击
6. 浏览器继续保留并监控成功 Toast，context 关闭后完成原生视频并按裁剪点生成 MP4

## 定位器

Playwright 配置已设置：

```ts
testIdAttribute: 'jing-testid'
```

因此代码使用：

```ts
page.getByTestId('phone_input')
page.getByTestId('agreement_continue')
page.getByTestId('success')
```

当前测试页的成功 Toast 存在一个兼容问题：页面实际把
`jing-testid=success` 输出成了 Toast 文本，没有生成对应属性。脚本仍优先使用
`getByTestId('success')`，并仅对 `.van-toast__text` 中完全一致的标记文本提供回退，
其他交互仍全部通过 `jing-testid` 完成。

全部定位器集中在 `src/automation/locators.ts`，包括手机号、姓名、身份证、社保、续保、协议、产品、成功 Toast 和身份证数字键盘。

## 真人化浏览

首单步骤 5 后的协议、社保和续保分支会调用页面浏览行为。未通过 `--profile` 固定时，每次运行会在三种画像中随机选择一种；步骤 6–8 的页面整体浏览预算随机为 4–12 秒，若控件尚未进入视口会继续小步滚动直到找到。协议弹窗和产品弹窗仍分别随机等待 1–5 秒。
三种画像都已延长滚动、停顿和回滑节奏，以适配 40–70 岁用户查看详情的时间。协议位置已在视口内时，身份证输入完成后仅停留 1–3 秒再勾选；协议勾选完成后才开始步骤 7–8 的 4–12 秒整体预览。每次滚动会拆成 2–3 个小段，段间短暂停留，完成一轮后再停留更长时间；步骤 7、8 点击社保或续保前会禁用回滑并继续滚动到页面底部，确认底部悬浮按钮进入视口后再点击。续保位置如果一开始就在视口内，则跳过额外的 1–4.2 秒查看停顿，直接执行底部确认和点击。

后续恢复浏览节点时，可复用三个可复现画像：

- `reader`：较慢滚动、最长停顿，适合仔细阅读
- `skimmer`：相对较快滚动，但仍保留较长停顿
- `distracted`：较短滚动、停顿范围更大、回滑概率最高

输入逻辑包含 5 种输入节奏，并由 seed 控制错误输入、删除重输、漏输修正和等待时长。
调试或对比输入节奏时，可通过 `--input-strategy` 固定为
`sequential`、`chunked`、`variable`、`pause-after-prefix` 或 `slow-tail`。

## 命令行批量队列

批量命令行测试配置位于 [automation.queue.config.ts](/Users/much/代码/仿朝发可回溯/automation.queue.config.ts)，只需要填写链接和并发数：

```ts
export const automationQueueConfig = {
  concurrency: 2,
  links: [
    { name: '首单测试', url: 'https://your-test-url.example.com/...' },
    { name: '非首单测试', url: 'https://your-test-url.example.com/...' },
  ],
};
```

执行队列：

```bash
npm run automation:queue
```

任务按 `links` 的数组顺序进入 FIFO 队列，同时运行的浏览器数量由 `concurrency` 控制，范围为 1–10。某个链接失败后，队列会继续执行后续链接；命令最后会汇总成功/失败数量，并在存在失败任务时返回退出码 1。只校验配置和链接、不启动浏览器时可以使用：

```bash
npm run automation:queue -- --dry-run
```

队列命令沿用 [automation.config.ts](/Users/much/代码/仿朝发可回溯/automation.config.ts) 中的无头模式、失败视频策略和输出目录配置。

## 验证

```bash
npm run typecheck
npm run test:unit
npm test
```

`npm run test:unit` 只运行 `tests/unit` 下的单元测试；`npm test` 运行 smoke 测试和单元测试。它们不会自动访问两条业务测试链接，也不会启动 `runOrderFlow`。真实业务流程需要显式执行 `npm run automation`。

## 快速测试页面

快速测试控制台位于 [web/index.html](/Users/much/代码/仿朝发可回溯/web/index.html)，用于生成和校验业务测试链接。

直接在浏览器打开 `web/index.html` 可以生成和校验链接，但不能通过 `file://` 页面调用“开始测试”接口。要执行真实 Playwright 流程，应启动快速测试服务：

```bash
npm run quick-test:start
```

如果只想预览页面、浏览器又限制本地文件脚本，可以在项目根目录启动静态服务：

```bash
python3 -m http.server 4173
```

然后访问 `http://localhost:4173/web/`。这个静态服务只提供页面文件，不提供“开始测试”接口；不要与快速测试服务同时占用同一个端口。

也可以直接使用终端入口管理服务：

```bash
# macOS
./scripts/start-quick-test.command start
./scripts/start-quick-test.command restart
./scripts/start-quick-test.command stop

# Windows PowerShell 或 CMD
scripts\start-quick-test.bat start
scripts\start-quick-test.bat restart
scripts\start-quick-test.bat stop
```

如果不带任何参数重复执行 Mac 或 Windows 入口文件，服务运行中会自动重启；服务未运行时则直接启动。

服务默认监听 `0.0.0.0`，启动后本机可以访问 `http://localhost:4173/web/`，同一局域网内的其他设备可以使用本机局域网 IP 访问，例如 `http://192.168.1.10:4173/web/`。启动日志会同时打印本机和局域网访问地址。也可以使用 `npm run quick-test:start`、
`npm run quick-test:restart`、`npm run quick-test:stop` 和 `npm run quick-test:status`。
默认端口是 `4173`，如需使用其他端口，命令格式为：

```bash
npm run quick-test:start -- --port 4200
npm run quick-test:restart -- --port 4200
```

如果只允许本机访问，可以显式指定监听地址：

```bash
npm run quick-test:start -- --host 127.0.0.1
```

局域网访问要求设备与运行脚本的电脑处于同一网络，并允许对应端口通过系统防火墙。该快速测试服务没有登录认证，请只在受信任的局域网中开放。

日志保存在 `output/quick-test-server.log`。

自动生成规则集中在 [web/test-config.js](/Users/much/代码/仿朝发可回溯/web/test-config.js)，可以修改：

- `originalUrl`：业务测试页面的原始 URL，具体地址通过本地配置维护，不在 README 中公开
- `defaults`：订单号前缀、姓名池、固定身份证号池、手机号前缀、价格、`shangdan`、`outerid` 和环境标记
- `presets`：首单、非首单等流程预设，以及预设要附带的额外参数
- `parameters`：页面参数字典及必填/可选标记

页面不会把参数上传到第三方服务，但浏览器仍会访问你填写的业务测试链接。测试记录以服务端的 `output/quick-test-runs/<runId>/run.json` 为准；页面刷新或重新打开浏览器后，会通过服务端记录接口恢复全部历史测试。结果区按执行记录分页展示，历史记录会一直保留，直到用户逐条删除或点击“全部删除”。

点击开始测试后，控制台会调用现有的 `runOrderFlow` 自动化脚本。单个运行可以设置 1–10 路并发，采用动态补位：任意一条任务完成后会立即补充下一条，不需要等待同一批中的其他慢任务。服务还会设置全局并发上限：默认最多同时运行 4 个自动化任务，超出的任务进入先进先出队列。可通过 `QUICK_TEST_MAX_CONCURRENCY` 调整全局上限，取值范围为 1–10，例如：

```bash
QUICK_TEST_MAX_CONCURRENCY=6 npm run quick-test:start
```

快速测试页面生成的成功视频独立保存在 `output/quick-test-videos/success`，由快速测试服务通过 `/quick-test-videos/...` 提供本地播放，不会与命令行的 `output/videos` 混用。服务会限制错误输出；删除测试记录时会同步删除对应视频，“全部删除”只清理快速测试记录和快速测试视频。

`web/test-config.js` 中的姓名、身份证号和手机号前缀会直接用于生成测试链接；请只填入获准使用的测试数据，不要提交真实个人信息。
