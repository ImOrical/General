const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const C = require('../../extension/lib/config.js');
require('../../extension/lib/detect.js');
const F = require('../../extension/lib/flow.js');
const V = require('../../extension/lib/vault.js');

const settings = C.resolveSettings({});
const store = (id) => C.resolveStore(id, settings);
const page = (html, url = 'https://www.amazon.com/ap/signin') => new JSDOM(html, { url }).window.document;

test('vault: round-trips logins and CVV with the right passphrase', async () => {
  const data = { cvv: '123', logins: { bestbuy: { email: 'me@example.com', password: 'hunter2!' } } };
  const sealed = await V.seal(data, 'correct horse');
  assert.ok(!JSON.stringify(sealed).includes('hunter2'), 'ciphertext does not contain the password');
  assert.deepEqual(await V.open(sealed, 'correct horse'), data);
});

test('vault: wrong passphrase is rejected', async () => {
  const sealed = await V.seal({ cvv: '123', logins: {} }, 'correct horse');
  await assert.rejects(V.open(sealed, 'wrong horse'), /Wrong passphrase/);
});

test('vault: short passphrases are refused', async () => {
  await assert.rejects(V.seal({ cvv: '1', logins: {} }, '123'), /at least 6/);
});

test('vault: each seal uses a fresh salt and IV', async () => {
  const a = await V.seal({ cvv: '1', logins: {} }, 'passphrase');
  const b = await V.seal({ cvv: '1', logins: {} }, 'passphrase');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test('sign-in: Amazon email-first page', () => {
  const doc = page('<form name="signIn"><input type="email" id="ap_email" name="email"><span class="a-button"><input id="continue" type="submit" aria-labelledby="c"></span></form>');
  const a = F.signInAction(doc, store('amazon'));
  assert.equal(a.kind, 'email');
  assert.equal(a.email.id, 'ap_email');
  assert.equal(a.submit.id, 'continue');
});

test('sign-in: password page with "Keep me signed in"', () => {
  const doc = page(`<form><p>me@example.com <a href="#">Change</a></p>
    <input type="password" id="ap_password" name="password">
    <input type="checkbox" name="rememberMe"> Keep me signed in
    <input id="signInSubmit" type="submit" value="Sign in"></form>`);
  const a = F.signInAction(doc, store('amazon'));
  assert.equal(a.kind, 'password');
  assert.equal(a.password.id, 'ap_password');
  assert.equal(a.submit.id, 'signInSubmit');
  assert.equal(a.remember.name, 'rememberMe');
});

test('sign-in: generic email + password form found by text', () => {
  const doc = page('<form><label>Email <input name="userEmail"></label><label>Password <input type="password" name="pw"></label><button type="submit">Sign In</button></form>', 'https://www.walmart.com/account/login');
  const a = F.signInAction(doc, store('walmart'));
  assert.equal(a.kind, 'password');
  assert.equal(a.email.name, 'userEmail');
  assert.equal(a.submit.textContent, 'Sign In');
});

test('sign-in: a one-time code page is OTP, never auto-filled', () => {
  const doc = page('<h1>Two-Step Verification</h1><p>We sent a code to the number ending in 42. Enter the verification code.</p><input type="tel" name="otpCode"><button>Submit</button>', 'https://www.amazon.com/ap/mfa');
  assert.equal(F.signInAction(doc, store('amazon')).kind, 'otp');
});

test('sign-in: OTP detected from wording even with a plain text box', () => {
  const doc = page('<p>We emailed you a 6-digit code.</p><input type="text" name="c1"><button>Verify</button>', 'https://identity.walmart.com/account/login');
  assert.equal(F.signInAction(doc, store('walmart')).kind, 'otp');
});

test('sign-in: hidden inputs are ignored', () => {
  const doc = page('<form><input type="hidden" name="email" value="x"><p>Loading…</p></form>');
  assert.equal(F.signInAction(doc, store('bestbuy')).kind, 'none');
});

test('sign-in steps exist for every store and point at sign-in URLs', () => {
  const urls = {
    psdirect: 'https://my.account.sony.com/central/signin/?client_id=x',
    bestbuy: 'https://www.bestbuy.com/identity/signin?token=x',
    target: 'https://www.target.com/login?client_id=ecom-web',
    walmart: 'https://identity.walmart.com/account/login?client_id=x',
    amazon: 'https://www.amazon.com/ap/signin?openid.return_to=x',
    gamestop: 'https://www.gamestop.com/login/',
  };
  for (const [id, url] of Object.entries(urls)) {
    assert.ok(F.stepsFor(store(id), url).some((s) => s.signin), id);
    assert.ok(store(id).accountUrl, `${id} has an account page for the sign-in check`);
  }
});

test('CVV: finds empty security-code boxes by standard and store-specific names', () => {
  const doc = page('<input autocomplete="cc-csc"><input id="credit-card-cvv"><input name="securityCode" value="123"><input name="zip">', 'https://www.bestbuy.com/checkout/r/fast-track');
  const found = F.emptyCvvFields(doc, store('bestbuy'));
  assert.equal(found.length, 2);
  assert.ok(found.every((el) => !el.value));
});

test('signed-out detection: a visible "Sign In" link', () => {
  assert.ok(F.signedOutLink(page('<header><a href="/identity/signin">Sign In</a></header>', 'https://www.bestbuy.com/site/customer/myaccount'), store('bestbuy')));
  assert.equal(F.signedOutLink(page('<header><a href="/account">Hi, Austin</a></header>', 'https://www.bestbuy.com/site/customer/myaccount'), store('bestbuy')), null);
});
