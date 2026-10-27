import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from '@vercel/blob';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

test('installed Blob SDK actually bypasses the CDN for consistent private reads', async () => {
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  try {
    const origin = 'https://synthetic-test.private.blob.vercel-storage.com';
    const pool = mock.get(origin);
    // First check is a missing slug; the next represents the completed write.
    // Requiring cache=0 here catches SDKs whose typings accept useCache but
    // whose actual network implementation silently ignores it (v2.5.0).
    pool.intercept({ path: '/slugs/test?cache=0', method: 'GET' }).reply(404, '');
    pool.intercept({ path: '/slugs/test?cache=0', method: 'GET' }).reply(200, 'synthetic-person', { headers: { 'content-type': 'text/plain' } });
    const options = { access: 'private', useCache: false, token: 'vercel_blob_rw_synthetic-test_fake-not-a-real-token' };
    assert.equal(await get(origin + '/slugs/test', options), null);
    const result = await get(origin + '/slugs/test', options);
    assert.equal(await new Response(result.stream).text(), 'synthetic-person');
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous);
    await mock.close();
  }
});
