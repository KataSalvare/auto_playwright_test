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

视频成功后输出到：

```text
output/playwright/videos/<订单号>.mp4
```

生成 MP4 需要本机安装 `ffmpeg`。

## 调试配置

修改根目录的 [automation.config.ts](/Users/much/代码/仿朝发可回溯/automation.config.ts)：

```ts
export const automationConfig = {
  headless: false,          // false：显示浏览器，方便调试
  browserChannel: 'chrome', // 使用本机 Chrome；删除此项则使用 Playwright Chromium
  deleteFailedVideo: false, // false：保留失败视频
  outputDir: 'output/playwright/videos',
};
```

当 `deleteFailedVideo=false` 时，未出现 `success` 的视频会保留在：

```text
output/playwright/videos/failed/<订单号>-<时间戳>.webm
```

单次运行也可以覆盖配置：

```bash
npm run automation -- --fixture=first-order --headed
npm run automation -- --fixture=first-order --headless
npm run automation -- --fixture=first-order --keep-failed-video
npm run automation -- --fixture=first-order --delete-failed-video=false
```

## 执行订单流程

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

移动浏览复用三个可复现画像：

- `reader`：较慢滚动、较长停顿
- `skimmer`：较快滚动、较短停顿
- `distracted`：较短滚动、停顿范围更大、较高回滑概率

输入逻辑包含 5 种输入节奏，并由 seed 控制错误输入、删除重输、漏输修正和等待时长。

## 验证

```bash
npm run typecheck
npm run test:unit
npm test
```

默认 `npm test` 只运行 smoke 和单元测试，不会自动访问两条业务测试链接。真实业务流程需要显式执行 `npm run automation`。
