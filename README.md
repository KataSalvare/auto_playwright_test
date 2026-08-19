# 订单 Playwright 自动化脚本

项目使用 TypeScript + Playwright，业务页面统一通过 `jing-testid` 定位。

## 安装

```bash
npm install
npm run test:install
```

如果本机已有 Google Chrome，也可以使用：

```bash
PW_CHANNEL=chrome npm run automation -- --fixture=first-order
```

使用 Playwright 原生 Video 录制。产品选择完成后等待 2–3 秒记录裁剪点，浏览器继续监控 `success`；流程结束后成功视频按裁剪点转码并输出到：

```text
output/videos/success/<订单号>-success-<时间戳>.mp4
```

生成 MP4 和裁剪视频需要本机安装 `ffmpeg`。

自动化浏览器固定模拟 iPhone 15，页面和录像尺寸均为 `392×852`。

## 调试配置

修改根目录的 [automation.config.ts](/Users/much/代码/仿朝发可回溯/automation.config.ts)：

```ts
export const automationConfig = {
  headless: false,          // false：显示浏览器，方便调试
  browserChannel: 'chrome', // 使用本机 Chrome；删除此项则使用 Playwright Chromium
  deleteFailedVideo: false, // true：保留失败视频；false：删除失败视频
  outputDir: 'output/videos',
};
```

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

单条订单测试脚本是：

```text
scripts/order-flow.ts
```

它由 `npm run automation` 调用。两个内置夹具的批量入口是：

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

Chrome 不要从 Codex 沙箱终端启动，请在 macOS 的 Terminal.app 或 iTerm2 中执行：

```bash
cd "/Users/much/代码/仿朝发可回溯"
npm run automation:terminal -- --fixture=first-order
npm run automation:terminal -- --fixture=repeat-order
```

也可以直接双击，或在普通终端执行：

```bash
./scripts/run-automation-terminal.command --fixture=first-order
```

该入口只负责切换到项目目录并调用现有 `scripts/order-flow.ts`，不会改变测试流程。

使用内置测试链接：

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
6. 选择社保状态
7. 选择续保状态
8. 勾选同意协议
9. 点击完善信息
10. 触发协议弹窗后浏览等待 2–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断同意按钮；用户关闭蒙层后仍可继续浏览再点击
11. 触发产品弹窗后浏览等待 2–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断产品按钮；用户关闭蒙层后仍可继续浏览再点击
12. 浏览器继续保留并监控成功 Toast，context 关闭后完成原生视频并按裁剪点生成 MP4

非首单流程：

1. 步骤开始前随机等待 1–3 秒，等待页面稳定
2. 勾选同意协议
3. 点击完善信息
4. 触发协议弹窗后浏览等待 2–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断同意按钮；用户关闭蒙层后仍可继续浏览再点击
5. 触发产品弹窗后浏览等待 2–5 秒；等待超过约 2 秒可能出现蒙层，但不阻断产品按钮；用户关闭蒙层后仍可继续浏览再点击
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

当前版本暂时移除了滚动、回滑和浏览停顿等页面浏览操作，等待后续补充具体浏览节点。
`profile` 配置和 `src/automation/mobile-browse.ts` 暂时保留，当前订单流程不会调用。

后续恢复浏览节点时，可复用三个可复现画像：

- `reader`：较慢滚动、较长停顿
- `skimmer`：较快滚动、较短停顿
- `distracted`：较短滚动、停顿范围更大、较高回滑概率

输入逻辑包含 5 种输入节奏，并由 seed 控制错误输入、删除重输、漏输修正和等待时长。
调试或对比输入节奏时，可通过 `--input-strategy` 固定为
`sequential`、`chunked`、`variable`、`pause-after-prefix` 或 `slow-tail`。

## 验证

```bash
npm run typecheck
npm run test:unit
npm test
```

默认 `npm test` 只运行 smoke 和单元测试，不会自动访问两条业务测试链接。真实业务流程需要显式执行 `npm run automation`。
