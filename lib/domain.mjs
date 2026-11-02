export const TASKS = Object.freeze({
  kr_trade: '국내 매매 판단 A/B', us_trade: '미국 매매 판단 A/B',
  kr_feedback: '국내 피드백', us_feedback: '미국 피드백'
});
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function validateSettings(value) {
  if (!value || !Object.hasOwn(TASKS, value.task_key)) throw new Error('올바른 작업을 선택하세요.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,99}$/.test(value.model ?? '')) throw new Error('올바른 모델 ID가 필요합니다.');
  if (!EFFORTS.includes(value.effort)) throw new Error('올바른 추론 수준이 필요합니다.');
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('설정 버전이 필요합니다.');
  if (typeof value.enabled !== 'boolean') throw new Error('활성 상태가 필요합니다.');
  return { task_key: value.task_key, model: value.model, effort: value.effort, enabled: value.enabled, version: value.version };
}
export function supported(catalog, model, effort) {
  const entry = catalog.find(x => (x.id === model || x.model === model));
  return !!entry?.supportedReasoningEfforts?.some(x => x.reasoningEffort === effort);
}
export function normalizeUsage(usage = {}) {
  const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
  const input = count(usage.input_tokens ?? usage.inputTokens);
  const output = count(usage.output_tokens ?? usage.outputTokens);
  return {
    input_tokens: input,
    cached_input_tokens: count(usage.cached_input_tokens ?? usage.cachedInputTokens),
    output_tokens: output,
    reasoning_output_tokens: count(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens),
    // Cache is part of input; reasoning is part of output. Never add them twice.
    total_tokens: input === null || output === null ? null : input + output
  };
}
export function summarizeUsage(runs) {
  const result = { jobs: runs.length, known_jobs: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 };
  for (const r of runs) {
    if (r.total_tokens === null || r.total_tokens === undefined) continue;
    result.known_jobs++;
    for (const key of ['input_tokens','output_tokens','cached_input_tokens','total_tokens']) result[key] += r[key] ?? 0;
  }
  return result;
}
