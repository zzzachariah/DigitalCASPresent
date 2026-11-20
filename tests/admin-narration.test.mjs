import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, imports = {}) {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => {
    if (Object.hasOwn(imports, name)) return imports[name]; throw new Error(`Unexpected import ${name}`);
  } });
  return module.exports;
}
const readiness = load('../src/lib/readiness.ts');
const { prepareNarrationVariants, adminReadinessForPerson } = load('../src/lib/admin-narration.ts', { './readiness': readiness });
const source = (count = 3, overrides = {}) => ({
  id: 'synthetic', name: 'Synthetic', language: 'auto', script: 'Synthetic private source',
  photoUrl: '/photo', cartoonUrl: '/cartoon', loopVideoUrl: '/video',
  sections: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `Synthetic object ${i}`, content: `Synthetic section ${i}`, cachedAnswers: { zh: `Synthetic Chinese ${i}`, en: `Synthetic English ${i}` } })),
  ...overrides,
});
function success(person, body, { status = 'prepared', reason = 'audio_saved', audio = true } = {}) {
  person.sections = person.sections.map((s) => s.id === body.sectionId ? {
    ...s, cachedAnswers: { ...s.cachedAnswers, [body.language]: s.cachedAnswers?.[body.language] || 'Synthetic new explanation' },
    ...(audio ? { cachedAudio: { ...s.cachedAudio, [body.language]: `/api/photo/synthetic.audio.${s.id}-${body.language}` } } : {}),
  } : s);
  return { ok: true, status: 200, data: { sections: structuredClone(person.sections), results: [{ sectionId: body.sectionId, language: body.language, status, reason }] } };
}

test('auto-language multi-section work is sequential, complete and reuses text via audioOnly', async () => {
  const p = source(); const calls = []; const updates = []; const progress = []; let active = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, {
    request: async (body) => {
      assert.equal(++active, 1); calls.push(body); await Promise.resolve(); active--;
      return success(p, body);
    }, onUpdate: (value) => updates.push(value), onProgress: (value) => progress.push(value),
  });
  assert.equal(result.total, 6); assert.equal(result.completed, 6); assert.equal(result.failures.length, 0);
  assert.deepEqual(calls.map((c) => `${c.sectionId}/${c.language}`), ['s0/zh', 's0/en', 's1/zh', 's1/en', 's2/zh', 's2/en']);
  assert.ok(calls.every((c) => c.audioOnly === true && !c.regenerateText && !c.textOnly && !('script' in c)));
  assert.equal(updates.length, 6); assert.deepEqual(progress.map((x) => x.current), [1, 2, 3, 4, 5, 6]);
  assert.equal(adminReadinessForPerson(result.person).ready, true);
});

test('unapproved speech never requests audio, including when cached text exists', async () => {
  const p = source(1); const calls = [];
  const result = await prepareNarrationVariants(p, { textOnly: true }, { request: async (body) => {
    calls.push(body); return success(p, body, { status: 'skipped', reason: 'text_already_cached', audio: false });
  } });
  assert.ok(calls.every((c) => c.textOnly === true && c.audioOnly === undefined));
  assert.equal(result.completed, 2);
  assert.equal(adminReadinessForPerson(result.person).ready, false);
});

test('audio-only mode never generates missing text and still prepares other existing variants', async () => {
  const p = source(1); delete p.sections[0].cachedAnswers.zh; const calls = [];
  const result = await prepareNarrationVariants(p, { textOnly: false, audioOnly: true }, { request: async (body) => { calls.push(body); return success(p, body); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].language, 'en'); assert.equal(calls[0].audioOnly, true);
  assert.equal(result.completed, 1); assert.equal(result.failures.length, 1); assert.equal(result.failures[0].language, 'zh');
});

test('missing text in normal preparation uses one exact variant without forcing regeneration', async () => {
  const p = source(1, { language: 'zh' }); delete p.sections[0].cachedAnswers.zh; let payload;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => { payload = body; return success(p, body); } });
  assert.equal(payload.sectionId, 's0'); assert.equal(payload.language, 'zh');
  assert.equal(payload.audioOnly, undefined); assert.equal(payload.regenerateText, undefined);
  assert.equal(result.completed, 1);
});

test('only request_time_budget is retried once and repeated skips remain incomplete', async () => {
  const p = source(1, { language: 'zh' }); let calls = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
    calls++; return { ok: true, status: 200, data: { sections: p.sections, results: [{ ...body, status: 'skipped', reason: 'request_time_budget' }] } };
  } });
  assert.equal(calls, 2); assert.equal(result.completed, 0); assert.equal(result.failures.length, 1);
});

test('a budget skip can complete on its bounded single-variant retry', async () => {
  const p = source(1, { language: 'zh' }); let calls = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
    if (++calls === 1) return { ok: true, status: 200, data: { sections: p.sections, results: [{ ...body, status: 'skipped', reason: 'request_time_budget' }] } };
    return success(p, body, { status: 'skipped', reason: 'healthy_audio' });
  } });
  assert.equal(calls, 2); assert.equal(result.completed, 1);
});

test('unconfirmed network outcomes stop later calls without an automatic paid retry', async () => {
  let calls = 0;
  const result = await prepareNarrationVariants(source(), { textOnly: false }, { request: async () => { calls++; throw new Error('Connection lost'); } });
  assert.equal(calls, 1); assert.equal(result.completed, 0); assert.equal(result.failures.length, 6);
});

test('an HTTP success or prepared marker without stored audio is not completion', async () => {
  const p = source(1, { language: 'zh' });
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => success(p, body, { audio: false }) });
  assert.equal(result.completed, 0); assert.equal(result.failures.length, 1);
});

test('permission failure stops remaining variants while retaining completed work', async () => {
  const p = source(); let calls = 0;
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
    if (++calls === 1) return success(p, body);
    return { ok: false, status: 403, data: { error: 'Approval changed' } };
  } });
  assert.equal(calls, 2); assert.equal(result.completed, 1); assert.equal(result.failures.length, 5);
  assert.ok(result.person.sections[0].cachedAudio.zh);
});

test('auto readiness requires saved text and audio in both requested languages', () => {
  const p = source(1); p.sections[0].cachedAudio = { zh: '/api/photo/synthetic.audio.zh' };
  assert.equal(adminReadinessForPerson(p).ready, false);
  p.sections[0].cachedAudio.en = '/api/photo/synthetic.audio.en';
  assert.equal(adminReadinessForPerson(p).ready, true);
});

test('known preparation failures retain specific fixed Chinese explanations without provider text', async () => {
  const cases = [
    ['answer_not_approved', '内容审核'], ['generation_failed', '文字讲解生成未完成'],
    ['tts_failed', '配音合成失败'], ['download_failed', '音频下载失败'],
    ['audio_save_failed', '音频保存失败'], ['audio_verification_failed', '音频校验未通过'],
    ['source_recheck_failed', '复核讲解内容'], ['persist_failed', '记录保存失败'],
  ];
  for (const [reason, expected] of cases) {
    const p = source(1, { language: 'zh' }); let calls = 0;
    const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
      calls++;
      return { ok: false, status: 502, data: {
        error: 'PRIVATE-UPSTREAM-MESSAGE sk-sensitive-token', sections: p.sections,
        results: [{ ...body, status: 'failed', reason, message: 'PRIVATE-ESSAY-CONTENT' }],
      } };
    } });
    assert.equal(calls, 1); assert.equal(result.completed, 0); assert.equal(result.failures.length, 1);
    assert.ok(result.failures[0].reason.includes(expected), reason);
    assert.doesNotMatch(result.failures[0].reason, /PRIVATE|sk-sensitive|UPSTREAM/);
    assert.equal(result.failures[0].sectionId, 's0');
  }
});

test('safe review diagnostics render only known phases, review outcomes and criteria', async () => {
  const p = source(1, { language: 'zh' });
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => ({
    ok: false, status: 502, data: { error: 'SECRET-RAW-ERROR', sections: p.sections, results: [{
      ...body, status: 'failed', reason: 'answer_not_approved', phase: 'review', reviewReason: 'model_rejection',
      rejectedCriteria: ['grounded', 'private', 'SECRET-MANUSCRIPT', 'grounded', '__proto__'],
      diagnostic: { message: 'SECRET-PROVIDER-RESPONSE', url: 'https://secret.invalid' },
    }] },
  }) });
  const text = result.failures[0].reason;
  assert.match(text, /环节：内容审核/);
  assert.match(text, /审核模型未批准/);
  assert.match(text, /依据充分性、保密要求/);
  assert.doesNotMatch(text, /SECRET|https|__proto__|grounded/);
});

test('review service failures lead with no verdict, never a rejected-content claim', async () => {
  for (const [reviewReason, expected] of [['review_timeout', '审核服务超时，未获得审核结论'], ['review_format', '审核服务返回格式异常，未获得审核结论'], ['review_upstream_error', '审核服务暂时失败，未获得审核结论']]) {
    const p = source(1, { language: 'zh' });
    const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => ({
      ok: false, status: 502, data: { error: 'PRIVATE-UPSTREAM', sections: p.sections, results: [{ ...body, status: 'failed', reason: 'answer_not_approved', phase: 'review', reviewReason, rejectedCriteria: ['private'] }] },
    }) });
    assert.ok(result.failures[0].reason.startsWith(expected));
    assert.doesNotMatch(result.failures[0].reason, /未通过|未批准|PRIVATE|保密要求/);
    assert.equal(result.completed, 0);
  }
});

test('only explicit review rejections describe content checks as failed', async () => {
  for (const reviewReason of ['local_rejection', 'model_rejection', undefined, 'unknown']) {
    const p = source(1, { language: 'zh' });
    const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => ({
      ok: true, status: 200, data: { sections: p.sections, results: [{ ...body, status: 'failed', reason: 'answer_not_approved', reviewReason }] },
    }) });
    assert.equal(result.completed, 0);
    if (reviewReason?.endsWith('_rejection')) assert.match(result.failures[0].reason, /内容检查未通过/);
    else { assert.match(result.failures[0].reason, /尚未获得有效的内容审核结论/); assert.doesNotMatch(result.failures[0].reason, /未通过|未批准/); }
  }
});

test('three failed reviews retain every failed item and every saved English audio without retrying', async () => {
  const p = source(3); const calls = []; const outcomes = [];
  for (const section of p.sections) section.cachedAudio = { en: `/api/photo/synthetic.audio.${section.id}-en-existing` };
  const original = structuredClone(p.sections);
  const result = await prepareNarrationVariants(p, { textOnly: false }, { onResult: (item) => outcomes.push(item), request: async (body) => {
    calls.push(body);
    return { ok: true, status: 200, data: { sections: structuredClone(p.sections), results: [{
      ...body, status: body.language === 'en' ? 'skipped' : 'failed', reason: body.language === 'en' ? 'healthy_audio' : 'answer_not_approved',
      ...(body.language === 'zh' ? { reviewReason: 'review_upstream_error', phase: 'review' } : {}),
    }] } };
  } });
  assert.equal(calls.length, 6); assert.equal(result.completed, 3); assert.equal(result.failures.length, 3);
  assert.equal(outcomes.length, 6); assert.equal(outcomes.filter((item) => item.completed).length, 3);
  assert.ok(result.failures.every((item) => item.reason.startsWith('审核服务暂时失败，未获得审核结论')));
  assert.deepEqual(result.person.sections, original);
});

test('readiness counts all requested languages and identifies missing sections and languages', () => {
  const p = source(4);
  p.sections[0].cachedAnswers.zh = '';
  for (const section of p.sections) section.cachedAudio = { en: '/api/photo/existing-english' };
  const readiness = adminReadinessForPerson(p);
  const text = readiness.items.find((item) => item.key === 'answers');
  const audio = readiness.items.find((item) => item.key === 'audio');
  assert.equal(text.label, '固定讲解 7/8'); assert.match(text.detail, /Synthetic object 0（中文）/);
  assert.equal(audio.label, '固定语音 4/8'); assert.match(audio.detail, /另 1 项见下方各段状态/);
  assert.equal(readiness.ready, false);
});

test('an interrupted request reads back saved records once, keeps all outcomes, and makes no paid retry', async () => {
  const p = source(2); const saved = structuredClone(p); saved.sections[0].cachedAudio = { zh: '/api/photo/saved-before-disconnect' };
  let requests = 0; let reads = 0; const outcomes = []; const updates = [];
  const result = await prepareNarrationVariants(p, { textOnly: false }, {
    request: async () => { requests++; throw new Error('PRIVATE-CONNECTION-DETAIL'); },
    recover: async () => { reads++; return saved; },
    onResult: (item) => outcomes.push(item), onUpdate: (person) => updates.push(person),
  });
  assert.equal(requests, 1); assert.equal(reads, 1); assert.equal(result.completed, 0);
  assert.equal(result.failures.length, 4); assert.equal(outcomes.length, 4); assert.equal(updates.length, 1);
  assert.equal(result.person.sections[0].cachedAudio.zh, '/api/photo/saved-before-disconnect');
  assert.match(result.failures[0].reason, /已重新读取保存结果/);
  assert.ok(outcomes.every((item) => !item.completed));
  assert.doesNotMatch(JSON.stringify(result.failures), /PRIVATE/);
});

test('unknown diagnostics and raw top-level errors never appear in failure messages', async () => {
  const p = source(1, { language: 'zh' });
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => ({
    ok: false, status: 502, data: { error: 'PRIVATE-TOPLEVEL', code: 'PRIVATE-CODE', sections: p.sections, results: [{
      ...body, status: 'failed', reason: 'PRIVATE-REASON', phase: 'PRIVATE-PHASE', reviewReason: '__proto__', rejectedCriteria: ['PRIVATE-CRITERION'],
    }] },
  }) });
  assert.equal(result.failures[0].reason, '此项未完成或保存结果尚未确认');
});

test('known permission/configuration codes use safe local text instead of server error.message', async () => {
  const result = await prepareNarrationVariants(source(1, { language: 'zh' }), { textOnly: false }, { request: async () => ({
    ok: false, status: 503, data: { code: 'a2e_key_missing', error: 'PRIVATE-ERROR-MESSAGE' },
  }) });
  assert.equal(result.failures[0].reason, '配音服务密钥尚未配置');
});

test('Blob read failures remain specific while healthy English audio is reused without regeneration', async () => {
  const p = source(4);
  for (const section of p.sections) section.cachedAudio = { en: `/api/photo/synthetic.audio.${section.id}-en-existing` };
  const originalEnglish = p.sections.map((section) => section.cachedAudio.en);
  const calls = [];
  const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
    calls.push(body);
    return {
      ok: body.language === 'en', status: body.language === 'en' ? 200 : 500,
      data: { sections: structuredClone(p.sections), error: 'PRIVATE-BLOB-UPSTREAM-ERROR', results: [{
        ...body, status: body.language === 'en' ? 'skipped' : 'failed',
        reason: body.language === 'en' ? 'healthy_audio' : 'read_failed',
        ...(body.language === 'zh' ? { phase: 'read' } : {}),
      }] },
    };
  } });
  assert.equal(result.completed, 4); assert.equal(result.failures.length, 4); assert.equal(calls.length, 8);
  assert.ok(result.failures.every((failure) => failure.language === 'zh' && failure.reason.includes('读取资料失败')));
  assert.ok(calls.every((body) => body.audioOnly === true && body.regenerateText === undefined));
  assert.deepEqual(result.person.sections.map((section) => section.cachedAudio.en), originalEnglish);
});

test('initial and final record read errors remain safe and do not replay a possibly saved request', async () => {
  for (const includePreparedResult of [false, true]) {
    const p = source(1, { language: 'zh' }); let calls = 0;
    const result = await prepareNarrationVariants(p, { textOnly: false }, { request: async (body) => {
      calls++;
      return { ok: false, status: 503, data: {
        code: 'read_failed', error: 'PRIVATE-STORAGE-ERROR',
        ...(includePreparedResult ? { results: [{ ...body, status: 'prepared', reason: 'audio_saved' }] } : {}),
      } };
    } });
    assert.equal(calls, 1); assert.equal(result.completed, 0); assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].reason, '资料暂时读取失败，请刷新核对已保存结果后重试');
    assert.deepEqual(result.person.sections, p.sections);
  }
});
