import { chunkForTokens, estimateTextTokens } from '../src/domain';

/**
 * 分段摘要用的系统提示。这里要的是「资料读懂以后的要点」，不是对话摘要：
 * 用户的问题与指令必须原样留下，否则摘要会悄悄改掉他到底在问什么。
 */
export const CONDENSE_SYSTEM_PROMPT = `把下面这段资料压缩成摘要，供之后回答用户的问题使用。
保留：事实、数字、名称、时间、地点、结论、约束、引用来源，以及用户提出的全部问题或指令——问题与指令请一字不改地照抄，不要改写、不要归纳。
不得添加原文没有的内容，也不要做推断。只输出摘要本身，不要前言、不要客套。`;

/**
 * 把超长资料压到 budgetTokens 以内：先按 chunkTokens 切块逐段摘要（map），拼起来如果还超，
 * 就对拼好的结果再来一轮（reduce），最多三轮。
 *
 * 摘要函数是注入的：这样这段「切块—摘要—再压」的控制流可以脱离网络单测，主进程只负责把
 * summarize 接到真实的模型请求上。
 */
export async function condenseToBudget(material: string, budgetTokens: number, chunkTokens: number, summarize: (text: string) => Promise<string>, maxRounds = 3) {
  let current = material;
  for (let round = 0; round < maxRounds; round++) {
    if (estimateTextTokens(current) <= budgetTokens) return current;
    const chunks = chunkForTokens(current, chunkTokens);
    const parts: string[] = [];
    for (const chunk of chunks) {
      const summary = (await summarize(chunk)).trim();
      if (!summary) throw new Error('摘要模型没有返回内容');
      parts.push(summary);
    }
    // 标上段号：拼接后的摘要仍要能被后续轮次看出这是一份合并稿，也让界面上分得清来源。
    current = parts.map((part, index) => `【第 ${index + 1}/${parts.length} 段摘要】\n${part}`).join('\n\n');
  }
  const final = estimateTextTokens(current);
  if (final > budgetTokens) throw new Error(`分段摘要后仍有约 ${final.toLocaleString('zh-CN')} token，超过预算 ${budgetTokens.toLocaleString('zh-CN')}；请换用窗口更大的摘要模型，或删减附件`);
  return current;
}
