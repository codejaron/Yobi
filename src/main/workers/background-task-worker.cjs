const zod = require('zod');

const factDraftSchema = zod.z.object({
  entity: zod.z.string().min(1).max(80),
  key: zod.z.string().min(1).max(80),
  value: zod.z.string().min(1).max(400),
  category: zod.z.enum(['identity', 'preference', 'event', 'goal', 'relationship', 'emotion_pattern']).default('event'),
  confidence: zod.z.number().min(0).max(1).default(0.65),
  ttl_class: zod.z.enum(['permanent', 'stable', 'active', 'session']).default('stable'),
  source: zod.z.string().max(120).optional(),
  source_range: zod.z.string().max(120).optional()
});
const factOperationSchema = zod.z.object({ action: zod.z.enum(['add', 'update', 'supersede']), fact: factDraftSchema });
const extractionSchema = zod.z.object({ operations: zod.z.array(factOperationSchema).max(60).default([]) });
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
  significance: zod.z.number().min(0).max(1).default(0.4)
});
const proactiveRewriteSchema = zod.z.object({
  shouldSend: zod.z.boolean(),
  reason: zod.z.string().max(200).default(''),
  rewrittenMessage: zod.z.string().max(160).default('')
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
function rewriteCustomOpenAIRequestBody(body) {
  if (typeof body !== 'string') return body;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return body; }
  if (!isPlainRecord(parsed)) return body;
  const nextMessages = downgradeDeveloperRoleEntries(parsed.messages);
  const nextInput = downgradeDeveloperRoleEntries(parsed.input);
  if (nextMessages === parsed.messages && nextInput === parsed.input) return body;
  return JSON.stringify({ ...parsed, messages: nextMessages, input: nextInput });
}
function createCustomOpenAICompatFetch(baseFetch = fetch) {
  return async (input, init) => {
    if (!init) return baseFetch(input);
    const rewrittenBody = rewriteCustomOpenAIRequestBody(init.body);
    if (rewrittenBody === init.body) return baseFetch(input, init);
    return baseFetch(input, { ...init, body: rewrittenBody });
  };
}
function normalizeCustomOpenAIBaseUrl(raw) {
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
function resolveProviderOptions(config, routeKey) {
  const route = config.modelRouting[routeKey];
  const provider = config.providers.find((candidate) => candidate.id === route.providerId);
  if (!provider) return undefined;
  const usesResponsesApi = (provider.kind === 'openai' || provider.kind === 'custom-openai') && provider.apiMode === 'responses';
  if (!usesResponsesApi) return undefined;
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
  const { createOpenAI } = await import('@ai-sdk/openai');
  if (provider.kind === 'custom-openai') {
    const client = createOpenAI({ apiKey: provider.apiKey, baseURL: normalizeCustomOpenAIBaseUrl(provider.baseUrl), fetch: createCustomOpenAICompatFetch() });
    return provider.apiMode === 'responses' ? client.responses(route.model) : client.chat(route.model);
  }
  const client = createOpenAI({ apiKey: provider.apiKey });
  return provider.apiMode === 'responses' ? client.responses(route.model) : client.chat(route.model);
}

async function runFactExtraction(message) {
  const { generateObject } = await import('ai');
  const model = await createModelForRoute(message.config, 'factExtraction');
  const system = [
    '你负责从对话片段中提取结构化事实。',
    '你输出 JSON，仅包含 operations。',
    'action 仅可为 add / update / supersede。',
    '不要复述对话，不要输出解释文本。'
  ].join('\n');
  const prompt = JSON.stringify({
    message_window: message.messages.map((item) => ({ id: item.id, ts: item.ts, role: item.role, text: item.text })),
    existing_facts: message.existingFacts,
    profile_hint: message.profileHint,
    now_iso: new Date().toISOString()
  }, null, 2);
  const result = await generateObject({
    model,
    providerOptions: resolveProviderOptions(message.config, 'factExtraction'),
    schema: extractionSchema,
    system,
    prompt,
    maxOutputTokens: Math.max(128, message.maxOutputTokens ?? 800)
  });
  const parsed = extractionSchema.parse(result.object ?? { operations: [] });
  return {
    operations: parsed.operations.map((operation) => ({
      action: operation.action,
      fact: {
        entity: operation.fact.entity.trim(),
        key: operation.fact.key.trim(),
        value: operation.fact.value.trim(),
        category: operation.fact.category,
        confidence: operation.fact.confidence,
        ttl_class: operation.fact.ttl_class,
        source: operation.fact.source,
        source_range: operation.fact.source_range
      }
    })),
    tokenUsage: result.usage
  };
}

async function runDailyEpisode(message) {
  const { generateObject } = await import('ai');
  const model = await createModelForRoute(message.config, 'reflection');
  const system = '你负责把当天对话整理成一条简短 episode，总结当天对话、未解事项和重要性。';
  const prompt = JSON.stringify({ date: message.date, message_window: message.todayItems.slice(-80) });
  const result = await generateObject({ model, providerOptions: resolveProviderOptions(message.config, 'reflection'), schema: dailyEpisodeSummarySchema, system, prompt, maxOutputTokens: 240 });
  const parsed = dailyEpisodeSummarySchema.parse(result.object ?? {});
  return { summary: parsed.summary, unresolved: parsed.unresolved, significance: parsed.significance, tokenUsage: result.usage };
}

async function runProfileSemantic(message) {
  const { generateObject } = await import('ai');
  const model = await createModelForRoute(message.config, 'reflection');
  const system = '你根据最近对话模式更新用户画像，保持小幅变化，不要发散猜测。只输出 schema 字段。';
  const prompt = JSON.stringify({ profile: message.profile, recent_episodes: message.episodes }, null, 2);
  const result = await generateObject({ model, providerOptions: resolveProviderOptions(message.config, 'reflection'), schema: semanticProfileSchema, system, prompt, maxOutputTokens: 400 });
  return { result: semanticProfileSchema.parse(result.object ?? {}), tokenUsage: result.usage };
}

async function runDailyReflection(message) {
  const { generateObject } = await import('ai');
  const model = await createModelForRoute(message.config, 'reflection');
  const system = '你是 Yobi 的反思模块，请给出一个可执行的微调建议和评分。分数越高表示证据越充分。';
  const prompt = JSON.stringify({ recent_episodes: message.episodes }, null, 2);
  const result = await generateObject({ model, providerOptions: resolveProviderOptions(message.config, 'reflection'), schema: reflectionSchema, system, prompt, maxOutputTokens: 400 });
  return { result: reflectionSchema.parse(result.object), tokenUsage: result.usage };
}

async function runProactiveRewrite(message) {
  const { generateObject } = await import('ai');
  const model = await createModelForRoute(message.config, 'reflection');
  const system = [
    '你是 Yobi，一个有社交感知力的 AI 伙伴。',
    '现在系统想向用户发一条主动消息，你需要根据上下文判断：',
    '1. 现在是否适合发送主动消息？',
    '2. 如果适合，用什么措辞？',
    '',
    '判断原则：',
    '- 如果上次主动消息用户没有回复，且间隔较短（几小时内），不要再发',
    '- 如果上次主动消息用户没有回复，但已经过了很久（比如隔天了），可以再试一次',
    '- 不要连续发类似内容的消息',
    '- 根据关系阶段调整语气：stranger 要礼貌克制，close/intimate 可以更自然亲近',
    '- 参考最近的聊天内容，让消息衔接自然',
    '',
    '返回 shouldSend: false 表示不发送，shouldSend: true 时在 rewrittenMessage 里写消息内容。',
    'reason 里简短写你的判断理由。'
  ].join('\n');

  const historyLines = (message.recentHistory || []).map((item) => {
    const tag = item.proactive ? ' [主动消息]' : '';
    return `[${item.timestamp}] ${item.role}${tag}: ${item.text}`;
  });

  const prompt = JSON.stringify({
    candidate_message: message.message,
    stage: message.stage,
    emotional: message.emotional,
    recent_history: historyLines,
    last_proactive_at: message.lastProactiveAt,
    last_user_message_at: message.lastUserMessageAt,
    now: message.now
  });
  const result = await generateObject({
    model,
    providerOptions: resolveProviderOptions(message.config, 'reflection'),
    schema: proactiveRewriteSchema,
    system,
    prompt,
    maxOutputTokens: 200
  });
  const parsed = proactiveRewriteSchema.parse(result.object ?? {});
  return {
    rewrittenMessage: parsed.shouldSend ? parsed.rewrittenMessage : '',
    tokenUsage: result.usage
  };
}

process.parentPort.on('message', async (message) => {
  const payload = unwrapMessage(message);
  const id = payload?.id;
  try {
    let result;
    if (payload?.type === 'fact-extraction') result = await runFactExtraction(payload);
    else if (payload?.type === 'daily-episode') result = await runDailyEpisode(payload);
    else if (payload?.type === 'profile-semantic-update') result = await runProfileSemantic(payload);
    else if (payload?.type === 'daily-reflection') result = await runDailyReflection(payload);
    else if (payload?.type === 'proactive-rewrite') result = await runProactiveRewrite(payload);
    else throw new Error(`unknown-background-task:${String(payload?.type || '')}`);
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    process.parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
