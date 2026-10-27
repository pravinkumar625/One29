const { describe, it } = require('node:test');
const assert = require('node:assert');
const emailRule = require('../public/email-rule.js');

const {
  isAuthorizedEmail,
  normalize,
  normalizeEmail,
  EMAIL_REGEX,
  regex,
  ACCESS_DENIED_MESSAGE,
  message,
} = emailRule;

describe('Email Access Control - Unit Tests', () => {
  describe('Exports Contract', () => {
    it('exports regex and EMAIL_REGEX matching the required pattern', () => {
      const expectedSource = '^[a-zA-Z]+(?:\\.[a-zA-Z]+)*\\.s\\.129@kalvium\\.community$';
      assert.strictEqual((regex || EMAIL_REGEX).source, expectedSource);
    });

    it('exports ACCESS_DENIED_MESSAGE and message constant', () => {
      const expectedMsg = 'Access denied. Only authorized student email addresses are permitted.';
      assert.strictEqual(ACCESS_DENIED_MESSAGE || message, expectedMsg);
    });

    it('exports normalize / normalizeEmail function', () => {
      assert.strictEqual(typeof (normalize || normalizeEmail), 'function');
    });

    it('exports isAuthorizedEmail function', () => {
      assert.strictEqual(typeof isAuthorizedEmail, 'function');
    });
  });

  describe('Required Accepted Emails', () => {
    it('accepts pravin.kumar.s.129@kalvium.community', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.129@kalvium.community'), true);
    });

    it('accepts lohith.m.s.129@kalvium.community', () => {
      assert.strictEqual(isAuthorizedEmail('lohith.m.s.129@kalvium.community'), true);
    });

    it('accepts rahul.s.129@kalvium.community', () => {
      assert.strictEqual(isAuthorizedEmail('rahul.s.129@kalvium.community'), true);
    });
  });

  describe('Required Rejected Emails', () => {
    it('rejects pravin.kumar.s.128@kalvium.community (wrong student batch number)', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.128@kalvium.community'), false);
    });

    it('rejects pravin.kumar.s.130@kalvium.community (wrong student batch number)', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.130@kalvium.community'), false);
    });

    it('rejects pravin.s.129@gmail.com (wrong domain)', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.s.129@gmail.com'), false);
    });

    it('rejects pravin.kumar@kalvium.community (missing .s.129)', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.kumar@kalvium.community'), false);
    });

    it('rejects pravin123.s.129@kalvium.community (digits in student name)', () => {
      assert.strictEqual(isAuthorizedEmail('pravin123.s.129@kalvium.community'), false);
    });
  });

  describe('Extra Edge Cases', () => {
    it('accepts leading and trailing whitespace after trimming', () => {
      const raw = '  pravin.kumar.s.129@kalvium.community  ';
      assert.strictEqual(isAuthorizedEmail(raw), false, 'untrimmed should be rejected');
      const trimmed = (normalize || normalizeEmail)(raw);
      assert.strictEqual(trimmed, 'pravin.kumar.s.129@kalvium.community');
      assert.strictEqual(isAuthorizedEmail(trimmed), true, 'trimmed should be accepted');
    });

    it('rejects uppercase domain', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.129@KALVIUM.COMMUNITY'), false);
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.129@Kalvium.Community'), false);
    });

    it('rejects trailing newline', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.129@kalvium.community\n'), false);
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.129@kalvium.community\r\n'), false);
    });

    it('rejects text after the domain', () => {
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.129@kalvium.community.attacker.com'), false);
      assert.strictEqual(isAuthorizedEmail('pravin.kumar.s.129@kalvium.community extra'), false);
    });

    it('rejects empty or non-string inputs', () => {
      assert.strictEqual(isAuthorizedEmail(''), false);
      assert.strictEqual(isAuthorizedEmail(null), false);
      assert.strictEqual(isAuthorizedEmail(undefined), false);
      assert.strictEqual(isAuthorizedEmail(12345), false);
      assert.strictEqual(isAuthorizedEmail({}), false);
      assert.strictEqual(isAuthorizedEmail([]), false);
      assert.strictEqual(isAuthorizedEmail(true), false);
    });

    it('normalize only trims leading/trailing whitespace without changing case', () => {
      const fn = normalize || normalizeEmail;
      assert.strictEqual(fn('  hello  '), 'hello');
      assert.strictEqual(fn('  ABC@XYZ  '), 'ABC@XYZ');
      assert.strictEqual(fn(''), '');
      assert.strictEqual(fn(null), '');
      assert.strictEqual(fn(undefined), '');
      assert.strictEqual(fn(123), '');
    });
  });
});
