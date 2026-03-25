const zod = require('zod');
const { generateStructuredJson } = require('./structured-json.cjs');

const semanticProfileSchema = zod.z.object({
  preferredComfortStyle: zod.z.string().min(1).max(30).optional(),
  humorReceptivity: zod.z.number().min(0).max(1).optional(),
  adviceReceptivity: zod.z.number().min(0).max(1).optional(),
  emotionalOpenness: zod.z.number().min(0).max(1).optional(),
  whatWorks: zod.z.array(zod.z.string().min(1).max(120)).max(5).default([]),
  whatFails: zod.z.array(zod.z.string().min(1).max(120)).max(5).default([])
});
const reflectionSchema = zod.z.object({
  summary: zod.z.string().min(1).max(200),
  evidence: zod.z.array(zod.z.string().min(1).max(160)).max(5).default([]),
  scores: zod.z.object({
    specificity: zod.z.number().min(0).max(1),
    evidence: zod.z.number().min(0).max(1),
    novelty: zod.z.number().min(0).max(1),
    usefulness: zod.z.number().min(0).max(1)
  })
});
const dailyEpisodeSummarySchema = zod.z.object({
  summary: zod.z.string().min(1).max(240),
  unresolved: zod.z.array(zod.z.string().min(1).max(120)).max(5).default([]),
  significance: zod.z.number().min(0).max(1).default(0.4),
  user_mood: zod.z.string().min(1).max(30).default('unknown'),
  yobi_mood: zod.z.string().min(1).max(30).default('neutral')
});

function unwrapMessage(message) {
  if (message && typeof message === 'object' && 'data' in message) {
    return message.data;
  }
  return message;
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function downgradeDeveloperRoleEntries(value) {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const mapped = value.map((item) => {
    if (!isPlainRecord(item) || item.role !== 'developer') return item;
    changed = true;
    return { ...item, role: 'system' };
  });
  return changed ? mapped : value;
}
function rewriteOpenAICompatibleRequestBody(body) {
  if (typeof body !== 'string') return body;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return body; }
  if (!isPlainRecord(parsed)) return body;
  const nextMessages = downgradeDeveloperRoleEntries(parsed.messages);
  const nextInput = downgradeDeveloperRoleEntries(parsed.input);
  if (nextMessages === parsed.messages && nextInput === parsed.input) return body;
  return JSON.stringify({ ...parsed, messages: nextMessages, input: nextInput });
}
function createOpenAICompatibleFetch(baseFetch = fetch) {
  return async (input, init) => {
    if (!init) return baseFetch(input);
    const rewrittenBody = rewriteOpenAICompatibleRequestBody(init.body);
    if (rewrittenBody === init.body) return baseFetch(input, init);
    return baseFetch(input, { ...init, body: rewrittenBody });
  };
}
function normalizeOpenAICompatibleBaseUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return input;
  let parsed;
  try { parsed = new URL(input); } catch { return input; }
  const pathname = parsed.pathname.trim();
  if (pathname === '' || pathname === '/') {
    parsed.pathname = '/v1';
    return parsed.toString().replace(/\/$/, '');
  }
  return input.replace(/\/$/, '');
}
function resolveProviderBaseUrl(provider) {
  if (provider.kind === 'custom-openai') {
    return provider.baseUrl ? normalizeOpenAICompatibleBaseUrl(provider.baseUrl) : 'https://api.openai.com/v1';
  }
  if (provider.kind === 'openai') return 'https://api.openai.com/v1';
  if (provider.kind === 'deepseek') return 'https://api.deepseek.com';
  if (provider.kind === 'qwen') {
    return provider.qwenRegion === 'intl'
      ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
      : 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  }
  if (provider.kind === 'moonshot') return 'https://api.moonshot.ai/v1';
  if (provider.kind === 'zhipu') return 'https://open.bigmodel.cn/api/paas/v4';
  if (provider.kind === 'minimax') return 'https://api.minimax.io/v1';
  return undefined;
}
function providerUsesResponsesApi(provider) {
  return (provider.kind === 'openai' || provider.kind === 'custom-openai') && provider.apiMode === 'responses';
}
function resolveProviderOptions(config, routeKey) {
  const route = config.modelRouting[routeKey];
  const provider = config.providers.find((candidate) => candidate.id === route.providerId);
  if (!provider) return undefined;
  if (!providerUsesResponsesApi(provider)) return undefined;
  return { openai: { store: false } };
}
async function createModelForRoute(config, routeKey) {
  const route = config.modelRouting[routeKey];
  const provider = config.providers.find((candidate) => candidate.id === route.providerId);
  if (!provider || !provider.enabled) throw new Error(`missing provider:${routeKey}`);
  if (provider.kind === 'anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    return createAnthropic({ apiKey: provider.apiKey })(route.model);
  }
  if (provider.kind === 'openrouter') {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
    return createOpenRouter({ apiKey: provider.apiKey }).chat(route.model);
  }
  if (provider.kind === 'deepseek') {
    const { createDeepSeek } = await import('@ai-sdk/deepseek');
    return createDeepSeek({ apiKey: provider.apiKey, baseURL: resolveProviderBaseUrl(provider) }).chat(route.model);
  }
  if (provider.kind === 'qwen') {
    const { createAlibaba } = await import('@ai-sdk/alibaba');
    return createAlibaba({ apiKey: provider.apiKey, baseURL: resolveProviderBaseUrl(provider) }).chatModel(route.model);
  }
  if (provider.kind === 'moonshot') {
    const { createMoonshotAI } = await import('@ai-sdk/moonshotai');
    return createMoonshotAI({ apiKey: provider.apiKey, baseURL: resolveProviderBaseUrl(provider) }).chatModel(route.model);
  }
  if (provider.kind === 'zhipu') {
    const { createZhipu } = await import('zhipu-ai-provider');
    return createZhipu({ apiKey: provider.apiKey, baseURL: resolveProviderBaseUrl(provider) }).chat(route.model);
  }
  if (provider.kind === 'minimax') {
    const { createMinimaxOpenAI } = await import('vercel-minimax-ai-provider');
    return createMinimaxOpenAI({ apiKey: provider.apiKey, baseURL: resolveProviderBaseUrl(provider) }).chat(route.model);
  }
  const { createOpenAI } = await import('@ai-sdk/openai');
  if (provider.kind === 'custom-openai') {
    const client = createOpenAI({ apiKey: provider.apiKey, baseURL: resolveProviderBaseUrl(provider), fetch: createOpenAICompatibleFetch() });
    return providerUsesResponsesApi(provider) ? client.responses(route.model) : client.chat(route.model);
  }
  const client = createOpenAI({ apiKey: provider.apiKey });
  return providerUsesResponsesApi(provider) ? client.responses(route.model) : client.chat(route.model);
}

async function runDailyEpisode(message) {
  const model = await createModelForRoute(message.config, 'reflection');
  const system = [
    'You summarize one full day of conversation into a short episode record.',
    'Return a JSON object with summary, unresolved, significance, user_mood, and yobi_mood.',
    'Do not include markdown fences or explanations.'
  ].join('\n');
  const prompt = JSON.stringify({
    date: message.date,
    fallback_summary: message.fallbackSummary,
    user_message_count: message.userMessageCount,
    message_window: Array.isArray(message.dayItems) ? message.dayItems.slice(-120) : []
  }, null, 2);
  const result = await generateStructuredJson({
    model,
    providerOptions: resolveProviderOptions(message.config, 'reflection'),
    schema: dailyEpisodeSummarySchema,
    system,
    prompt,
    maxOutputTokens: 240,
    maxAttempts: 3
  });
  const parsed = result.object;
  return {
    summary: parsed.summary,
    unresolved: parsed.unresolved,
    significance: parsed.significance,
    user_mood: parsed.user_mood,
    yobi_mood: parsed.yobi_mood,
    tokenUsage: result.usage
  };
}

async function runProfileSemantic(message) {
  const model = await createModelForRoute(message.config, 'reflection');
  const system = [
    'Update the user profile from recent conversation patterns.',
    'Make only small, evidence-based adjustments and avoid speculation.',
    'Return JSON only.'
  ].join('\n');
  const prompt = JSON.stringify({ profile: message.profile, recent_episodes: message.episodes }, null, 2);
  const result = await generateStructuredJson({
    model,
    providerOptions: resolveProviderOptions(message.config, 'reflection'),
    schema: semanticProfileSchema,
    system,
    prompt,
    maxOutputTokens: 400,
    maxAttempts: 3
  });
  return { result: result.object, tokenUsage: result.usage };
}

async function runDailyReflection(message) {
  const model = await createModelForRoute(message.config, 'reflection');
  const system = [
    'You are Yobi\'s reflection module.',
    'Return one actionable tuning suggestion with supporting evidence and scores.',
    'Return JSON only.'
  ].join('\n');
  const prompt = JSON.stringify({ recent_episodes: message.episodes }, null, 2);
  const result = await generateStructuredJson({
    model,
    providerOptions: resolveProviderOptions(message.config, 'reflection'),
    schema: reflectionSchema,
    system,
    prompt,
    maxOutputTokens: 400,
    maxAttempts: 3
  });
  return { result: result.object, tokenUsage: result.usage };
}

process.parentPort.on('message', async (message) => {
  const payload = unwrapMessage(message);
  const id = payload?.id;
  try {
    let result;
    if (payload?.type === 'daily-episode') result = await runDailyEpisode(payload);
    else if (payload?.type === 'profile-semantic-update') result = await runProfileSemantic(payload);
    else if (payload?.type === 'daily-reflection') result = await runDailyReflection(payload);
    else throw new Error(`unknown-background-task:${String(payload?.type || '')}`);
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    process.parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
