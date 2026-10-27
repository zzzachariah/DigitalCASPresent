import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/sentences.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { takeSentences } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('Flushing punctuation or whitespace creates no narration chunk', () => {
  for (const text of ['**', '”', '。！？', '...;;;', '*** *** *** ***', '  \n ', '🎉']) {
    assert.deepEqual(takeSentences(text, true), { chunks: [], rest: '' });
  }
});

test('Closing Markdown after a complete Chinese sentence is not spoken separately', () => {
  const text = '**这张照片展示了证据选择如何影响我们对世界的理解。**';
  const streamed = takeSentences(text);
  assert.deepEqual(streamed.chunks, ['**这张照片展示了证据选择如何影响我们对世界的理解。']);
  assert.equal(streamed.rest, '**');
  assert.deepEqual(takeSentences(streamed.rest, true), { chunks: [], rest: '' });
  assert.equal(text, '**这张照片展示了证据选择如何影响我们对世界的理解。**');
});

test('Chinese, English, bilingual and number-only chunks retain their spoken content', () => {
  for (const text of ['你好。', 'Yes.', '这张照片体现了 selection。', '2026。', '𠮷。']) {
    assert.deepEqual(takeSentences(text, true), { chunks: [text], rest: '' });
  }
});

test('Discarded punctuation does not swallow text in the next streamed fragment', () => {
  const pending = takeSentences('**');
  assert.deepEqual(pending, { chunks: [], rest: '**' });
  assert.deepEqual(takeSentences(pending.rest + '这是中文。**', true), { chunks: ['**这是中文。**'], rest: '' });
});
