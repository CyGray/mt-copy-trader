// Read-only MT5 bridge queries. Refuses any mutating action. Masks login.
import { createRequire } from 'node:module';
const require = createRequire('/home/kyle/projects/ByTrader/worker/package.json');
const zmq = require('zeromq');
const MUT = new Set(['ORDER_SEND','POSITION_MODIFY','ORDER_MODIFY','PENDING_MODIFY','CLOSE_POSITION','CANCEL_ORDER']);
export async function ro(action, params = {}) {
  if (MUT.has(action)) throw new Error('mutating action refused');
  const s = new zmq.Request(); s.connect('tcp://127.0.0.1:5555'); s.sendTimeout = 5000; s.receiveTimeout = 5000;
  const id = 'ro-' + Math.random().toString(36).slice(2);
  await s.send(JSON.stringify({ ...params, v: 2, request_id: id, action }));
  const [f] = await s.receive(); s.close();
  const r = JSON.parse(f.toString());
  return r;
}
if (process.argv[1].endsWith('bridge_ro.mjs')) {
  const mask = (o) => { if (o && o.login !== undefined) o.login = '***' + String(o.login).slice(-3); return o; };
  const show = (n, r) => console.log(n, JSON.stringify(r.ok ? mask(r.data) : { ok: false, retcode: r.retcode, error: r.error }));
  show('PING', await ro('PING'));
  show('ACCOUNT_INFO', await ro('ACCOUNT_INFO'));
  for (const sym of process.argv.slice(2)) show('SYMBOL_INFO ' + sym, await ro('SYMBOL_INFO', { symbol: sym, auto_suffix: true }));
  show('GET_POSITIONS', await ro('GET_POSITIONS', {}));
  show('GET_ORDERS', await ro('GET_ORDERS', {}));
}
process.exit(0);
