import { fetch, ProxyAgent } from 'undici';
import type { Connection } from '../src/types';
import { authHeaders } from './providers';

export type BalanceResult = { text: string; detail?: string };

/**
 * 余额接口没有统一标准，只能对着已知的两家试：OpenRouter 的 `…/api/v1/credits` 与 DeepSeek 的
 * `/user/balance`。这里按用户填的 Base URL 推几个候选地址，依次试到返回 200 且能解析为止。
 *
 * 所有候选都从用户自己的地址派生（只换路径，不换域名），所以 API Key 不会被发到别的主机上。
 */
export function balanceCandidates(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  const origin = new URL(base).origin;
  return [...new Set([
    `${base}/credits`,          // Base URL 已经带 /api/v1（OpenRouter 预设就是）
    `${base}/api/v1/credits`,   // Base URL 只到域名
    `${origin}/api/v1/credits`, // Base URL 带了别的路径（如 DeepSeek 的 /anthropic）
    `${origin}/user/balance`,   // DeepSeek
    `${base}/user/balance`,
  ])];
}

function amountText(value: number, currency?: string) {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' || !currency ? '$' : `${currency} `;
  return `${symbol}${value.toFixed(2)}`;
}

/** 把两家（以及将来别的）返回体翻译成一行余额；认不出来就返回 undefined，让调用方继续试下一个地址。 */
export function parseBalance(payload: unknown): BalanceResult | undefined {
  const data = payload as any;
  // OpenRouter：总额度与已用量分开给，余额要自己减。
  const credits = data?.data ?? data;
  if (typeof credits?.total_credits === 'number' && typeof credits?.total_usage === 'number') {
    const remaining = credits.total_credits - credits.total_usage;
    return { text: amountText(remaining, 'USD'), detail: `额度 ${amountText(credits.total_credits, 'USD')} · 已用 ${amountText(credits.total_usage, 'USD')}` };
  }
  // DeepSeek：按币种各给一条，通常只有一条。
  const infos = data?.balance_infos;
  if (Array.isArray(infos) && infos.length) {
    const parts = infos.map((info: any) => ({ currency: info?.currency, total: Number(info?.total_balance) })).filter(part => Number.isFinite(part.total));
    if (parts.length) return { text: parts.map(part => amountText(part.total, part.currency)).join(' / '), ...(data?.is_available === false ? { detail: '账户当前不可用' } : {}) };
  }
  return undefined;
}

export async function fetchBalance(connection: Connection, signal: AbortSignal): Promise<BalanceResult> {
  const headers = authHeaders(connection);
  const dispatcher = connection.proxy ? new ProxyAgent(connection.proxy) : undefined;
  const failures: string[] = [];
  for (const url of balanceCandidates(connection.baseUrl)) {
    try {
      // 余额查询是顺手看的，不该按聊天那套超时（可能是 120 秒）干等。
      const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]), dispatcher });
      if (!response.ok) { failures.push(`${new URL(url).pathname} → ${response.status}`); continue; }
      const parsed = parseBalance(await response.json().catch(() => null));
      if (parsed) return parsed;
      failures.push(`${new URL(url).pathname} → 返回格式无法识别`);
    } catch (error) {
      failures.push(`${new URL(url).pathname} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`没有找到可用的余额接口（${failures.join('；')}）`);
}
