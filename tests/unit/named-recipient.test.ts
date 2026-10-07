import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNamedRecipient as x } from '../../src/lib/audience/named-recipient';

test('incident text -> name', () => {
  assert.equal(x('Create an email and send to Trevor Otts', 'Create an email and send to Trevor Otts at trevorotts@blackceo.com about my upcoming event'), 'Trevor Otts');
});
test('title only', () => {
  assert.equal(x('Create an email and send to Trevor Otts'), 'Trevor Otts');
  assert.equal(x('Email Jane Smith the invoice'), 'Jane Smith');
  assert.equal(x('Message Dana Cole about Friday'), 'Dana Cole');
});
test('email only falls back to the address', () => {
  assert.equal(x('Send the flyer to info@acme.com'), 'info@acme.com');
});
test('negatives -> null', () => {
  assert.equal(x("Plan this week's social media postings"), null);
  assert.equal(x('Write a blog post for my audience'), null);
  assert.equal(x('Email Campaign Ideas for October'), null);
  assert.equal(x('Write a post for LinkedIn'), null);
  assert.equal(x('My email is me@acme.com, draft a welcome series'), null);
  assert.equal(x(null, null), null);
});
