import http from 'k6/http';
import { check, sleep } from 'k6';
export const options = {
  scenarios: {
    devices: { executor: 'constant-vus', vus: 5, duration: '5m' },
    dashboards: { executor: 'constant-vus', exec: 'dashboard', vus: 100, duration: '5m' },
  },
  thresholds: {
    'http_req_duration{kind:device}': ['p(95)<500', 'p(99)<1500'],
    'http_req_duration{kind:dashboard}': ['p(95)<400'],
    http_req_failed: ['rate<0.001'],
    checks:['rate>0.999'],
  },
};
const api = __ENV.API_ORIGIN;
const readers = (() => {
  try {
    return JSON.parse(__ENV.K6_DEVICE_SECRETS_JSON || '[]');
  } catch {
    throw new Error('Invalid staging device JSON. Credential values are not logged.');
  }
})();
const users=(()=>{try{return JSON.parse(__ENV.K6_USERS_JSON||'[]');}catch{throw new Error('Invalid staging user-session JSON.');}})();
if(readers.length<5||!__ENV.API_ORIGIN||users.length<100||new Set(users.map(u=>u.user_id)).size<100||users.some(u=>!u.access_token||!u.school_id))
 throw new Error('Configure five staging readers and 100 distinct authorized staging users. Do not share one user token across virtual users.');

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
export default function () {
  const reader = readers[(__VU - 1) % readers.length];
  if (!reader.card_uids?.length) throw new Error('Each reader requires valid staging card_uids.');
  const at = new Date().toISOString(),
    sequence = Date.now() * 1000 + __VU * 100;
  const payload = {
    batch_id: uuid(),
    device_id: reader.code,
    firmware_version: 'load-test',
    sent_at: at,
    events: reader.card_uids.slice(0, 20).map((card_uid, i) => ({
      event_id: uuid(),
      device_id: reader.code,
      card_uid,
      event_timestamp: at,
      time_source: 'NTP',
      sequence_number: sequence + i,
      boot_id: reader.boot_id || uuid(),
      firmware_version: 'load-test',
    })),
  };
  const r = http.post(`${api}/api/v1/device/events/batch`, JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': reader.code,
      Authorization: `Bearer ${reader.secret}`,
    },
    tags: { kind: 'device' },
  });
  check(r, {
    'acknowledges only committed events': (r) =>
      r.status === 200 &&
      r.json('results').every((x) => x.status === 'RECORDED' && x.device_action === 'DELETE'),
  });
  sleep(2.1);
}
export function dashboard() {
  const user=users[(__VU-1)%users.length];
  const r = http.get(`${api}/api/v1/dashboard`, {
    headers: { Authorization: `Bearer ${user.access_token}`, 'X-School-Id': user.school_id },
    tags: { kind: 'dashboard' },
  });
  check(r, { 'dashboard available': (r) => r.status === 200 });
  sleep(2);
}
