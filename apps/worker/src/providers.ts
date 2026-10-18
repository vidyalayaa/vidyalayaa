import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
export class DeliveryError extends Error {
  constructor(
    public code: string,
    public permanent = false,
    public retryAfter?: number,
  ) {
    super(code);
  }
}
const circuits = new Map<string, { failures: number; until: number }>();
export async function deliver(
  channel: string,
  address: string,
  message: string,
  id: string,
): Promise<string> {
  const state = circuits.get(channel);
  if (state && state.until > Date.now()) throw new DeliveryError('CIRCUIT_OPEN', false, 60);
  try {
    const result = await send(channel, address, message, id);
    circuits.delete(channel);
    return result;
  } catch (e) {
    const n = (state?.failures || 0) + 1;
    circuits.set(channel, { failures: n, until: n >= 5 ? Date.now() + 60000 : 0 });
    throw e;
  }
}
async function send(channel: string, address: string, message: string, id: string) {
  if (channel === 'PUSH') {
    if (!getApps().length) {
      if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64)
        throw new DeliveryError('PROVIDER_UNCONFIGURED');
      initializeApp({
        credential: cert(
          JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString()),
        ),
      });
    }
    try {
      return await getMessaging().send({
        token: address,
        notification: { title: 'Vidyalayaa', body: message },
        data: { delivery_id: id },
        webpush: { fcmOptions: { link: process.env.PUBLIC_WEB_URL || '/' } },
      });
    } catch (e) {
      const code = (e as { code?: string }).code || 'PUSH_FAILED';
      throw new DeliveryError(
        code,
        [
          'messaging/registration-token-not-registered',
          'messaging/invalid-registration-token',
        ].includes(code),
      );
    }
  }
  if (channel === 'EMAIL') {
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
      throw new DeliveryError('PROVIDER_UNCONFIGURED');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': id,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [address],
        subject: 'Vidyalayaa school update',
        text: message,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new DeliveryError(
        `EMAIL_HTTP_${response.status}`,
        response.status >= 400 && response.status < 500 && response.status !== 429,
        Number(response.headers.get('retry-after')) || undefined,
      );
    return ((await response.json()) as { id: string }).id;
  }
  if (channel === 'SMS') {
    if (!process.env.SMS_ADAPTER_URL || !process.env.SMS_ADAPTER_TOKEN)
      throw new DeliveryError('PROVIDER_UNCONFIGURED');
    if (!process.env.SMS_ADAPTER_URL.startsWith('https://'))
      throw new DeliveryError('SMS_HTTPS_REQUIRED', true);
    const response = await fetch(process.env.SMS_ADAPTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SMS_ADAPTER_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': id,
      },
      body: JSON.stringify({
        to: address,
        message,
        template: process.env.SMS_TEMPLATE_ID,
        idempotency_key: id,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new DeliveryError(
        `SMS_HTTP_${response.status}`,
        response.status >= 400 && response.status < 500 && response.status !== 429,
        Number(response.headers.get('retry-after')) || undefined,
      );
    return ((await response.json()) as { message_id: string }).message_id;
  }
  throw new DeliveryError('UNKNOWN_CHANNEL', true);
}
