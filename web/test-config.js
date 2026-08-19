/**
 * 快速测试控制台配置。
 *
 * 修改这里的默认值后刷新页面，即可改变自动生成链接的行为。
 * 这个文件故意使用 window 全局变量，直接双击打开 web/index.html 也能工作。
 */
window.TEST_CONFIG = {
  appName: '订单链路实验室',
  appVersion: 'v0.3.0',
  originalUrl: 'https://h5-subscribe.yunxiacn.com/temp-lp-jing/index/6100b6d7fb8d64de74245697b16a5a8d',
  // 如果执行接口返回了视频地址，也可以在前端配置统一的视频目录前缀。
  videoBaseUrl: '',
  defaults: {
    orderIdPrefix: 'QA',
    names: ['卡塔', '李明', '陈雨', '周宁'],
    phonePrefix: '159',
    socialSecurity: '1',
    autoRenewal: '1',
    pageOrder: '1',
    basePrice: '10.99',
    upgradePrice: '99.9',
    shangdan: '',
    outerid: 'yx_iolk_7ujm_0o6y_qsaa',
    testEnvironment: '1',
  },
  presets: [
    {
      id: 'first-order',
      label: '首单流程',
      description: '手机号 · 实名信息 · 社保/续保 · 协议与产品',
      pageOrder: '1',
      socialSecurity: '1',
      autoRenewal: '1',
    },
    {
      id: 'repeat-order',
      label: '非首单流程',
      description: '协议与产品确认，跳过实名信息',
      pageOrder: '2',
      socialSecurity: '1',
      autoRenewal: '1',
    },
  ],
  parameters: [
    { key: 'dingdan', label: '订单号', group: 'required', description: '用于关联本次测试记录' },
    { key: 'shouji', label: '手机号', group: 'required', description: '6–20 位数字' },
    { key: 'xingming', label: '姓名', group: 'required', description: '测试用户姓名' },
    { key: 'shenfen', label: '身份证号', group: 'required', description: '18 位身份证格式' },
    { key: 'shebao', label: '有无社保', group: 'required', description: '1 = 有，0 = 无' },
    { key: 'xubao', label: '自动续保', group: 'required', description: '1 = 是，0 = 否' },
    { key: 'shunxu', label: '页面顺序', group: 'required', description: '1 = 首单，2 = 非首单' },
    { key: 'jichu', label: '基础保费', group: 'optional', description: '可选价格字段' },
    { key: 'shengji', label: '升级保费', group: 'optional', description: '可选价格字段' },
    { key: 'shangdan', label: '上单名称', group: 'optional', description: '非首单可选字段' },
    { key: 'bxres', label: '保险结果', group: 'optional', description: '可选业务字段' },
    { key: 'outerid', label: '外部 ID', group: 'optional', description: '来源追踪字段' },
    { key: '__test_env__', label: '测试环境标记', group: 'optional', description: '1 = 测试环境' },
  ],
};
