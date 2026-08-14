/**
 * SMS delivery.
 *
 * Uses Twilio when it is configured. Outside production it otherwise falls
 * back to "dev mode", where the code is printed to the server console and
 * handed back to the browser. Production fails closed when Twilio is absent.
 *
 * To send real messages set:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 */

const crypto = require('node:crypto');

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM = process.env.TWILIO_FROM || '';

const configured = Boolean(SID && TOKEN && FROM);
// Explicit opt-in: allow the on-screen "dev code" fallback even in production
// when Twilio is not configured. Appropriate for a small, trusted group (the
// code is shown in the browser). Leave unset for public deployments so sign-in
// fails closed instead of handing a code to anyone who knows the number.
const devCodeFallback = process.env.SMS_DEV_CODE === 'true';
const developmentFallback = process.env.NODE_ENV !== 'production' || devCodeFallback;

/**
 * @returns {Promise<{delivered: boolean, devCode?: string, error?: string, configurationRequired?: boolean}>}
 */
async function sendCode(phone, code) {
  const body = `${code} is your VChat verification code. It expires in 5 minutes. Never share this code with anyone.`;

  if (!configured) {
    if (!developmentFallback) {
      console.error('[sms] production phone verification is unavailable: configure all Twilio SMS variables');
      return {
        delivered: false,
        configurationRequired: true,
        error: 'Phone verification is temporarily unavailable. Try again later.',
      };
    }
    console.log('');
    console.log('  ┌───────────────────────────────────────────┐');
    console.log(`  │  VChat code for ${phone.padEnd(17)}         │`);
    console.log(`  │  →  ${code}                                 │`);
    console.log('  └───────────────────────────────────────────┘');
    console.log('');
    return { delivered: false, devCode: code };
  }

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: FROM, Body: body }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('[sms] twilio rejected the message:', res.status, detail.slice(0, 200));
      return { delivered: false, error: 'Could not send the SMS. Check the number and try again.' };
    }
    return { delivered: true };
  } catch (err) {
    console.error('[sms] send failed:', err.message);
    return { delivered: false, error: 'SMS service unreachable. Try again in a moment.' };
  }
}

async function sendText(phone, text) {
  const body = String(text || '').trim().slice(0, 1400);
  if (!body) return { delivered: false, error: 'Message is empty' };

  if (!configured) {
    if (!developmentFallback) {
      return {
        delivered: false,
        configurationRequired: true,
        error: 'SMS delivery is unavailable. Use Cloud or configure Twilio.',
      };
    }
    console.log(`[sms] cloud-fallback text for ${phone}: ${body.slice(0, 120)}`);
    return { delivered: false, devPreview: body };
  }

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: FROM, Body: body }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('[sms] twilio rejected the text:', res.status, detail.slice(0, 200));
      return { delivered: false, error: 'Could not send the SMS. Try Cloud instead.' };
    }
    return { delivered: true };
  } catch (err) {
    console.error('[sms] text send failed:', err.message);
    return { delivered: false, error: 'SMS service unreachable. Try Cloud instead.' };
  }
}

function twilioSignatureValid(url, params, signature) {
  if (!TOKEN || !signature) return false;
  const data = Object.keys(params || {}).sort()
    .reduce((acc, key) => acc + key + String(params[key] ?? ''), url);
  const expected = crypto.createHmac('sha1', TOKEN).update(data).digest('base64');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sendCode, sendText, twilioSignatureValid, configured };
