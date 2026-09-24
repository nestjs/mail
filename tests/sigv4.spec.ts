/**
 * AWS Signature Version 4 against the AWS test suite, copied byte for byte from botocore
 * (tests/unit/auth/aws4_testsuite, commit b770c0d17bc9a518e1292a8f2bae5570843ba965; Apache
 * 2.0, see fixtures/sigv4/LICENSE and NOTICE). botocore's copy is the AWS suite
 * (awslabs/aws-c-auth) with the two `post-x-www-form-urlencoded*` cases made
 * self-consistent. `post-sts-header-after` (a token added after signing) is left out: the
 * transport always signs the token.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signV4 } from '../lib/transports/sigv4.util.js';

const dir = join(import.meta.dirname, 'fixtures/sigv4');
const cases = readdirSync(dir)
  .filter((file) => file.endsWith('.req'))
  .map((file) => file.slice(0, -4));
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const date = new Date('2015-08-30T12:36:00Z');

function parseRequest(text: string) {
  const [head, ...bodyParts] = text.split('\n\n');
  const [requestLine, ...headerLines] = head.split('\n');
  const tokens = requestLine.split(' ');
  const method = tokens[0];
  const target = tokens.slice(1, -1).join(' ');
  const [path, query = ''] = target.split(/\?(.*)/s);

  const headers: [string, string][] = [];
  for (const line of headerLines) {
    if (line === '') {
      continue; // two files end with a newline
    }
    if (/^\s/.test(line)) {
      headers[headers.length - 1][1] += ` ${line.trim()}`; // obs-fold
    } else {
      headers.push([line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]);
    }
  }

  return { method, path, query, headers, body: bodyParts.join('\n\n').replace(/\n$/, '') };
}

describe('SigV4 (AWS test suite)', () => {
  it('has the suite', () => expect(cases.length).toBeGreaterThanOrEqual(30));

  it.each(cases)('%s', (name) => {
    const read = (ext: string) => readFileSync(join(dir, `${name}.${ext}`), 'utf8');
    const request = parseRequest(read('req'));
    const creq = read('creq');
    const token = /^x-amz-security-token:(.*)$/m.exec(creq)?.[1];

    const signature = signV4(
      {
        method: request.method,
        path: request.path,
        query: request.query,
        // The signer adds X-Amz-Date and X-Amz-Security-Token itself
        headers: request.headers.filter(([h]) => !/^x-amz-(date|security-token)$/i.test(h)),
        body: request.body,
      },
      { credentials: { ...credentials, ...(token && { sessionToken: token }) }, region: 'us-east-1', service: 'service', date },
    );

    expect(signature.canonicalRequest).toBe(creq);
    expect(signature.stringToSign).toBe(read('sts'));
    expect(signature.authorization).toBe(read('authz'));
  });
});
