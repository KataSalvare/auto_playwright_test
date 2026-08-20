# 自动化批量执行 API 文档

## 1. 接口概述

该 API 用于让远程服务批量提交业务链接，并在远程电脑上执行 Playwright 自动化脚本。

接口采用异步任务模式：

1. 调用方提交多条链接。
2. API 立即返回 `jobId`。
3. 调用方通过 `jobId` 查询执行进度和结果。

默认服务地址：

```text
http://远程电脑IP:4173
```

默认监听地址为 `0.0.0.0:4173`，可以通过启动参数修改。

## 2. 鉴权

启动服务前配置环境变量：

```bash
export AUTOMATION_API_KEY='替换为一段足够长的随机字符串'
npm run api:start
```

调用接口时使用以下任意一种方式传递 Key：

```http
Authorization: Bearer 你的APIKey
```

或：

```http
X-API-Key: 你的APIKey
```

建议使用 `Authorization: Bearer ...`。未配置 API Key 时，任务接口不会接受请求。

## 3. 健康检查

### 请求

```http
GET /api/automation/health
```

### curl 示例

```bash
curl 'http://远程电脑IP:4173/api/automation/health'
```

### 成功响应

```json
{
  "service": "automation-api",
  "apiKeyConfigured": true,
  "maxLinks": 50,
  "maxConcurrency": 4
}
```

`maxConcurrency` 表示服务端当前同时运行的最大浏览器任务数，默认是 4，可通过 `QUICK_TEST_MAX_CONCURRENCY` 调整。

## 4. 提交批量任务

### 请求

```http
POST /api/automation/jobs
Content-Type: application/json
Authorization: Bearer 你的APIKey
```

### 请求参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---:|---|
| `links` | array | 是 | - | 业务链接数组，最多 50 条 |
| `links[].url` | string | 是 | - | 完整业务 URL，必须包含 `temp-lp-jing` |
| `links[].name` | string | 否 | `任务 N` | 任务名称，便于识别结果 |
| `concurrency` | integer | 否 | `1` | 本任务并发数，范围 1–10 |
| `dryRun` | boolean | 否 | `false` | 设为 `true` 时只校验链接，不启动浏览器 |

`links` 也支持直接传字符串：

```json
{
  "links": [
    "https://example.com/temp-lp-jing/index/...?..."
  ]
}
```

推荐使用带 `name` 的对象格式。

### curl 示例

```bash
curl -X POST 'http://远程电脑IP:4173/api/automation/jobs' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 你的APIKey' \
  -d '{
    "concurrency": 2,
    "dryRun": false,
    "links": [
      {
        "name": "订单1",
        "url": "https://your-domain.example/temp-lp-jing/index/...?dingdan=ORDER001&shouji=13800138000&xingming=%E5%8D%A1%E5%A1%94&shenfen=320381198812252138&shebao=1&xubao=1&shunxu=1"
      },
      {
        "name": "订单2",
        "url": "https://your-domain.example/temp-lp-jing/index/...?dingdan=ORDER002&shouji=13800138001&xingming=%E5%8D%A1%E5%A1%94&shenfen=320381198812252138&shebao=1&xubao=1&shunxu=2"
      }
    ]
  }'
```

### Node.js 示例

```js
const baseUrl = 'http://远程电脑IP:4173';
const apiKey = process.env.AUTOMATION_API_KEY;

const response = await fetch(`${baseUrl}/api/automation/jobs`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    concurrency: 2,
    links: [
      { name: '订单1', url: 'https://your-domain.example/temp-lp-jing/index/...?...' },
      { name: '订单2', url: 'https://your-domain.example/temp-lp-jing/index/...?...' },
    ],
  }),
});

const job = await response.json();
if (!response.ok) throw new Error(job.error || '提交任务失败');
console.log(job.jobId);
```

### 成功响应

HTTP 状态码为 `202 Accepted`：

```json
{
  "jobId": "job-1787210048192-j91x7kz",
  "total": 2,
  "concurrency": 2,
  "dryRun": false,
  "status": "running",
  "done": false,
  "startedAt": 1787210048192,
  "completedAt": null,
  "completedCount": 0,
  "success": 0,
  "failed": 0,
  "queue": {
    "active": 0,
    "waiting": 0,
    "limit": 4
  },
  "results": [
    {
      "index": 1,
      "name": "订单1",
      "url": "https://your-domain.example/temp-lp-jing/index/...?dingdan=ORDER001&...",
      "status": "queued",
      "success": false,
      "duration": "—",
      "videoUrl": "",
      "error": ""
    }
  ]
}
```

## 5. 查询任务

### 请求

```http
GET /api/automation/jobs/{jobId}
Authorization: Bearer 你的APIKey
```

### curl 示例

```bash
curl 'http://远程电脑IP:4173/api/automation/jobs/job-1787210048192-j91x7kz' \
  -H 'Authorization: Bearer 你的APIKey'
```

建议每隔 1–3 秒查询一次，直到返回 `done: true` 或 `status: "completed"`。

### 结果状态

| 字段 | 可能值 | 说明 |
|---|---|---|
| `status` | `running` / `completed` | 整个批量任务状态 |
| `done` | `true` / `false` | 是否执行结束 |
| `results[].status` | `queued` | 等待执行 |
| `results[].status` | `running` | 正在执行 |
| `results[].status` | `success` | 执行成功 |
| `results[].status` | `failed` | 执行失败 |
| `results[].success` | boolean | 当前链接是否成功 |
| `results[].duration` | string | 执行耗时，例如 `12.4s` |
| `results[].error` | string | 失败原因，成功时为空 |
| `results[].videoUrl` | string | 成功视频的相对地址，未生成时为空 |

当 `videoUrl` 返回：

```text
/videos/订单号-success-时间戳.mp4
```

完整地址为：

```text
http://远程电脑IP:4173/videos/订单号-success-时间戳.mp4
```

API 任务生成的视频实际保存在项目目录下的 `output/videos/`：成功视频位于 `output/videos/success/`，失败视频位于 `output/videos/failed/`。前端快速测试页面仍然使用独立的 `output/quick-test-videos/` 目录。

## 6. 错误响应

错误响应统一为：

```json
{
  "error": "错误说明"
}
```

| HTTP 状态码 | 说明 |
|---:|---|
| `202` | 任务已接受并开始排队 |
| `400` | JSON、链接、并发数或参数格式错误 |
| `401` | API Key 缺失或错误 |
| `404` | `jobId` 不存在 |
| `405` | HTTP 方法不支持 |
| `503` | 服务端未配置 `AUTOMATION_API_KEY` |
| `500` | 服务端处理异常 |

## 7. 部署启动

在远程电脑执行：

```bash
npm install
npm run test:install
export AUTOMATION_API_KEY='替换为一段足够长的随机字符串'
npm run api:start
```

常用管理命令：

```bash
npm run api:status
npm run api:restart
npm run api:stop
```

修改端口或监听地址：

```bash
node scripts/quick-test-server.mjs start --host 0.0.0.0 --port 4173
```

## 8. 注意事项

- 业务链接中的手机号、姓名和身份证号属于敏感数据，请使用 HTTPS 或内网访问。
- 建议通过防火墙或反向代理限制允许调用 API 的来源 IP。
- `dryRun: true` 适合先验证链接格式和必要参数。
- `concurrency` 越大，占用的 CPU、内存和浏览器资源越多，建议从 1–3 开始。
- 服务重启后，正在执行的任务会被标记为失败，已完成的任务记录会保留在 `output/automation-jobs/`。
