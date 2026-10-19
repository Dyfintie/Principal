import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentity } from '../runtime/antigravity-identity.mjs';
const fixture = claims => JSON.stringify({ token: {}, id_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature` });
test('native token file identity metadata', () => {
  assert.deepEqual(parseIdentity(fixture({ email: 'fixture@example.test' })), { identity: 'fixture@example.test', plan: null });
  assert.equal(parseIdentity(fixture({ sub: 'fixture-subject' })).identity, 'fixture-subject');
});
test('unsupported identity formats fail closed without revealing secrets', () => {
  for (const value of ['secret', '{}', fixture({}), fixture({ email: 3 })])
    assert.throws(() => parseIdentity(value), /credential format unsupported/);
});
