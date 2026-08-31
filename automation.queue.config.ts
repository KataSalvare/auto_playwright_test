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
    { name: '1', url: 'https://jkxtfsdjyl.baigebao.com/temp-lp-jing/index/551083034552b9e58def52d5fed306c5?dingdan=test_tmp_7fa57936-22e6-41b6-b2a9-e19e416d9d04&shouji=15586205285&xingming=张三丰&shenfen=422201196601157754&shebao=1&xubao=1&jichu=0.6&shengji=200&shunxu=2&bxres=1&shangdan=守护保·百万医疗险&outerid=__OUTERID__yx_test_qety_sblp_pcdm_prod'},
    { name: '2', url: 'https://jkxtfsdjyl.baigebao.com/temp-lp-jing/index/1e90be2d22e0f1e6760577b1ac6f0745?dingdan=test_AB260820150558733&shouji=13153003168&xingming=吕庆祝&shenfen=370122196408166552&shebao=1&xubao=1&jichu=0.6&shengji=175&shunxu=1&bxres=0&outerid=__OUTERID__yx_test_qety_sblp_pcdm_prod'},

  
  
  
    // { name: '自定义测试 1', url: 'https://your-test-url.example.com/...' },
  ],
};
