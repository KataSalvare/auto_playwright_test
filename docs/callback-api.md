# 视频录制结果回调 API 文档

## 1. 接口概述

当脚本服务完成视频录制后，通过此回调接口通知 Java 服务端，告知视频的存放路径和执行结果。

Java 服务端收到回调后，会根据返回的视频路径下载视频，并执行后续流程（加水印、上传 OSS、推送白鸽）。

回调地址（Java 服务端提供）：

```text
POST http://192.168.52.226:31004/api/nw/record/callback
```

## 2. 鉴权

调用方（脚本服务）在请求头中使用 Bearer 方式携带 API Key：

```http
Authorization: Bearer 配置的回调密钥
```

密钥由 Java 服务端通过 Nacos 配置（`policy.trace.log.nwCallbackApiKey`），双方需保持一致。

## 3. 请求

### 请求方法

```http
POST /api/nw/record/callback
Content-Type: application/json
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `jobId` | string | 是 | 脚本服务返回的任务ID（提交任务时获取） |
| `orderNo` | string | 是 | 订单号，取提交任务时传入的 `links[].name` |
| `status` | string | 是 | 任务状态：`success` / `failed` |
| `videoUrl` | string | 否 | 视频相对路径（status=success 时必填），如 `/videos/success/ORDER001-success-1787210048192.mp4` |
| `duration` | number | 否 | 视频时长（秒） |
| `fileSize` | number | 否 | 视频文件大小（字节） |
| `error` | string | 否 | 失败原因（status=failed 时必填） |
| `completedAt` | number | 否 | 任务完成时间戳（毫秒） |

### 请求示例（成功）

```bash
curl -X POST 'http://192.168.52.226:31004/api/nw/record/callback' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 你的回调密钥' \
  -d '{
    "jobId": "job-1787210048192-j91x7kz",
    "orderNo": "ORDER001",
    "status": "success",
    "videoUrl": "/videos/success/ORDER001-success-1787210048192.mp4",
    "fileSize": 15728640,
    "completedAt": 1787210082000
  }'
```

### 请求示例（失败）

```bash
curl -X POST 'http://192.168.52.226:31004/api/nw/record/callback' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 你的回调密钥' \
  -d '{
    "jobId": "job-1787210048192-j91x7kz",
    "orderNo": "ORDER001",
    "status": "failed",
    "error": "页面加载超时，等待超过60秒",
    "completedAt": 1787210082000
  }'
```

## 4. 响应

### 成功响应

```json
{
  "code": 200,
  "message": "success"
}
```

### 失败响应

```json
{
  "code": 500,
  "message": "订单记录不存在"
}
```

### 状态码说明

| HTTP 状态码 | 说明 |
|---:|---|
| `200` | 回调接收成功 |
| `400` | 请求参数缺失或格式错误 |
| `401` | 鉴权失败（API Key 错误或缺失） |
| `500` | 服务端处理异常 |

## 5. 调用时机

```text
1. Java 服务端调用 POST http://脚本服务IP:4173/api/automation/jobs 提交录制任务
2. 脚本服务返回 jobId
3. 脚本服务执行 Playwright 录制
4. 录制完成后，脚本服务调用此回调接口
5. Java 服务端收到回调，拼接完整地址下载视频（http://脚本服务IP:4173 + videoUrl）
6. Java 服务端执行后续流程：加水印 → 上传OSS → 推送白鸽
```

## 6. 注意事项

- **幂等性**：同一个任务可能被回调多次，Java 服务端保证幂等处理，重复回调不会产生副作用
- **超时重试**：如果回调失败（HTTP非200），脚本服务可重试 3 次，间隔分别为 5s、10s、30s
- **视频保留**：脚本服务在回调成功后需保留视频文件至少 30 分钟，供 Java 服务端下载
- **调用范围**：只有通过 `/api/automation/jobs` 发起的正式任务会回调；前端快速测试、命令行和 `dryRun` 不回调
- **视频位置**：API 视频文件保存在项目的 `output/videos/`，回调中的可下载相对地址为 `/videos/...`
- **视频下载**：Java 服务端通过 `http://脚本服务IP:4173` + `videoUrl` 拼接完整地址下载视频
- **安全**：回调接口需在局域网环境调用，不建议暴露到公网
