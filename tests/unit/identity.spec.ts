import { expect, test } from '@playwright/test';
import { hasValidIdentityChecksum } from '../../src/automation/identity';

test.describe('身份证校验位', () => {
  test('识别校验位正确的号码', () => {
    expect(hasValidIdentityChecksum('11010519491231002X')).toBe(true);
  });

  test('识别测试链接中校验位错误的号码', () => {
    expect(hasValidIdentityChecksum('350200199001010101')).toBe(false);
  });

  test('拒绝格式不完整的号码', () => {
    expect(hasValidIdentityChecksum('35020019900101010')).toBe(false);
  });
});
