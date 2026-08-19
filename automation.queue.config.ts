import { ORDER_FIXTURES } from './src/automation/order-links';

type AutomationQueueConfig = {
  concurrency: number;
  links: Array<{ name?: string; url: string }>;
};

/**
 * 命令行批量测试队列配置。
 *
 * 只需要维护 concurrency 和 links，执行 npm run automation:queue 即可。
 * links 按数组顺序进入 FIFO 队列；每一项都应使用完整的业务测试链接。
 */
export const automationQueueConfig: AutomationQueueConfig = {
  /** 同时运行的浏览器任务数，范围 1–10。 */
  concurrency: 4,

  links: [
    { name: '第一条订单', url: 'https://h5-subscribe.yunxiacn.com/temp-lp-jing/index/6100b6d7fb8d64de74245697b16a5a8d?dingdan=11111&shouji=15900000000&xingming=卡塔&shenfen=320381198812252138&shebao=1&xubao=1&jichu=10.99&shengji=99.9&shunxu=1&bxres=0&outerid=yx_iolk_7ujm_0o6y_qsaa&__test_env__=1'},
    { name: '第二条订单', url: 'https://h5-subscribe.yunxiacn.com/temp-lp-jing/index/6100b6d7fb8d64de74245697b16a5a8d?dingdan=11111&shouji=15900000000&xingming=卡塔&shenfen=320381198812252138&shebao=1&xubao=1&jichu=10.99&shengji=99.9&shunxu=2&shangdan=安康一生&bxres=1&outerid=yx_iolk_7ujm_0o6y_qsaa&__test_env__=1-order'},
    // { name: '自定义测试 1', url: 'https://your-test-url.example.com/...' },
  ],
};
