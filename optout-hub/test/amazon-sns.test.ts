import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIsOptedOut, awsError } from '../src/adapters/amazon_sns.js';

test('parseIsOptedOut reads the isOptedOut flag', () => {
  const optedOut = `<CheckIfPhoneNumberIsOptedOutResponse><CheckIfPhoneNumberIsOptedOutResult>
    <isOptedOut>true</isOptedOut></CheckIfPhoneNumberIsOptedOutResult></CheckIfPhoneNumberIsOptedOutResponse>`;
  const optedIn = `<CheckIfPhoneNumberIsOptedOutResult><isOptedOut>false</isOptedOut></CheckIfPhoneNumberIsOptedOutResult>`;
  assert.equal(parseIsOptedOut(optedOut), true);
  assert.equal(parseIsOptedOut(optedIn), false);
  assert.equal(parseIsOptedOut('<empty/>'), false);
});

test('awsError extracts Code and Message from an AWS error response', () => {
  const xml = `<ErrorResponse><Error><Type>Sender</Type><Code>AuthorizationError</Code>
    <Message>User is not authorized</Message></Error></ErrorResponse>`;
  assert.equal(awsError(xml), 'AuthorizationError: User is not authorized');
});

test('awsError returns null when there is no error element', () => {
  assert.equal(awsError('<ok/>'), null);
});
