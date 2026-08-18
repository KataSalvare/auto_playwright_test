import type { OrderInput, PageOrder } from './types';

const REQUIRED_PARAMS = [
  'dingdan',
  'shouji',
  'xingming',
  'shenfen',
  'shebao',
  'xubao',
  'shunxu',
] as const;

const OPTIONAL_PARAMS = [
  'jichu',
  'shengji',
  'shangdan',
  'bxres',
  'outerid',
  '__test_env__',
] as const;

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`URL 缺少必要参数：${name}`);
  return value;
}

function binaryParam(url: URL, name: 'shebao' | 'xubao'): boolean {
  const value = requiredParam(url, name);
  if (value !== '0' && value !== '1') {
    throw new Error(`${name} 必须是 0 或 1，当前值：${value}`);
  }
  return value === '1';
}

function pageOrderParam(url: URL): PageOrder {
  const value = requiredParam(url, 'shunxu');
  if (value !== '1' && value !== '2') {
    throw new Error(`shunxu 必须是 1 或 2，当前值：${value}`);
  }
  return value === '1' ? 1 : 2;
}

export function parseOrderUrl(rawUrl: string): OrderInput {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('传入的订单链接不是有效 URL');
  }

  if (!url.href.includes('temp-lp-jing')) {
    throw new Error('订单链接必须包含模板标识 temp-lp-jing');
  }

  for (const name of REQUIRED_PARAMS) requiredParam(url, name);

  const phone = requiredParam(url, 'shouji');
  if (!/^\d{6,20}$/.test(phone)) throw new Error('shouji 必须是数字手机号');

  const identityNumber = requiredParam(url, 'shenfen');
  if (!/^\d{17}[\dXx]$/.test(identityNumber)) {
    throw new Error('shenfen 必须是 18 位身份证号格式');
  }

  const extraParams: Record<string, string> = {};
  for (const name of OPTIONAL_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) extraParams[name] = value;
  }

  return {
    orderId: requiredParam(url, 'dingdan'),
    phone,
    name: requiredParam(url, 'xingming'),
    identityNumber: identityNumber.toUpperCase(),
    hasSocialSecurity: binaryParam(url, 'shebao'),
    autoRenewal: binaryParam(url, 'xubao'),
    pageOrder: pageOrderParam(url),
    sourceUrl: url.toString(),
    extraParams,
  };
}

export function safeUrlDescription(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}
