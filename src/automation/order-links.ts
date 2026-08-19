export const ORDER_FIXTURES = Object.freeze({
  'first-order':
    'https://h5-subscribe.yunxiacn.com/temp-lp-jing/index/6100b6d7fb8d64de74245697b16a5a8d?dingdan=11111&shouji=15900000000&xingming=%E5%8D%A1%E5%A1%94&shenfen=320381198812252138&shebao=1&xubao=1&jichu=10.99&shengji=99.9&shunxu=1&bxres=0&outerid=yx_iolk_7ujm_0o6y_qsaa&__test_env__=1',
  'repeat-order':
    'https://h5-subscribe.yunxiacn.com/temp-lp-jing/index/6100b6d7fb8d64de74245697b16a5a8d?dingdan=11111&shouji=15900000000&xingming=%E5%8D%A1%E5%A1%94&shenfen=320381198812252138&shebao=1&xubao=1&jichu=10.99&shengji=99.9&shunxu=2&shangdan=%E5%AE%89%E5%BA%B7%E4%B8%80%E7%94%9F&bxres=1&outerid=yx_iolk_7ujm_0o6y_qsaa&__test_env__=1',
} as const);

export type OrderFixtureName = keyof typeof ORDER_FIXTURES;
