import { test, expect } from 'bun:test';
import { generateKeyPairSync, privateDecrypt, createDecipheriv } from 'node:crypto';
import { PlaudEnrollment } from './plaud-enrollment';
test('only approved key receives an authenticated identity envelope, with expiry and acknowledgement', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); let now = 0;
  const identity = { serial: 'test-device', bindingToken: 'private-binding', signature: 'private-signature', privateKey: 'private-key', publicKey: 'public-key' };
  const service = new PlaudEnrollment(async () => identity, () => now);
  const request = service.create({ name: 'Test phone', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
  expect(service.get(request.id).envelope).toBeUndefined(); expect(JSON.stringify(service.list())).not.toContain('private-');
  await expect(service.approve(request.id, 'WRONG!')).rejects.toThrow('does not match');
  await service.approve(request.id, request.code); const envelope = service.get(request.id).envelope!;
  expect(JSON.stringify(envelope)).not.toContain('private-');
  const key = privateDecrypt({ key: keys.privateKey, oaepHash: 'sha1' }, Buffer.from(envelope.wrappedKey, 'base64'));
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const open = (aad: string) => { const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64')); cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(ciphertext.subarray(-16)); return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]).toString(); };
  expect(JSON.parse(open(request.id))).toEqual(identity); expect(() => open('wrong-request')).toThrow();
  now = 600001; expect(() => service.get(request.id)).toThrow('expired'); expect(service.list()).toEqual([]);
});

test('approval records the phone without any secret', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const approved: unknown[] = [];
  const service = new PlaudEnrollment(async () => ({ serial: 'test-device', bindingToken: 'private-binding', signature: 'private-signature', privateKey: 'private-key', publicKey: 'public-key' }), () => 0, phone => approved.push(phone));
  const request = service.create({ name: 'iPhone', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
  await service.approve(request.id, request.code);
  await service.approve(request.id, request.code); // repeated approval is not a second phone
  expect(approved).toEqual([{ id: request.id, name: 'iPhone', code: request.code, serial: 'test-device', approvedAt: '1970-01-01T00:00:00.000Z' }]);
});
