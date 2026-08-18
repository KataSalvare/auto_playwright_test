import { test, expect } from '@playwright/test';
import { ORDER_FIXTURES } from '../../src/automation/order-links';
import { parseOrderUrl } from '../../src/automation/url-config';

test.describe('订单链接参数解析', () => {
  test('首单夹具解析为流程 1', () => {
    const order = parseOrderUrl(ORDER_FIXTURES['first-order']);

    expect(order.pageOrder).toBe(1);
    expect(order.name).toBe('卡塔');
    expect(order.hasSocialSecurity).toBe(true);
    expect(order.autoRenewal).toBe(true);
    expect(order.extraParams.bxres).toBe('0');
  });

  test('非首单夹具解析为流程 2', () => {
    const order = parseOrderUrl(ORDER_FIXTURES['repeat-order']);

    expect(order.pageOrder).toBe(2);
    expect(order.extraParams.bxres).toBe('1');
    expect(order.extraParams.shangdan).toBe('安康一生');
  });

  test('拒绝不包含模板标识的链接', () => {
    expect(() => parseOrderUrl('https://example.com/?dingdan=1')).toThrow('temp-lp-jing');
  });

  test('拒绝非法流程参数', () => {
    const invalid = ORDER_FIXTURES['first-order'].replace('shunxu=1', 'shunxu=3');
    expect(() => parseOrderUrl(invalid)).toThrow('shunxu 必须是 1 或 2');
  });
});
