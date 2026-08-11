/**
 * SMS delivery.
 *
 * Uses Twilio when it is configured, otherwise falls back to "dev mode",
 * where the code is printed to the server console and handed back to the
 * browser so you can sign in without a real phone.
 *
 * To send real messages set:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 */

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM = process.env.TWILIO_FROM || '';

const configured = Boolean(SID && TOKEN && FROM);

/**
 * @returns {Promise<{delivered: boolean, devCode?: string, error?: string}>}
 */
async function sendCode(phone, code) {
  const body = `${code} is your VChat verification code. It expires in 5 minutes. Never share this code with anyone.`;

  if (!configured) {
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

module.exports = { sendCode, configured };
