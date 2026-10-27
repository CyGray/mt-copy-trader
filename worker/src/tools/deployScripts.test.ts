/**
 * deploy/deploy-v2.sh and deploy/rollback-v2.sh in a sandbox: a fake repo tree,
 * a fake service manager, a fake compiler and a fake preflight. Nothing here
 * touches the real worker/dist, systemd, MT5 or Firestore.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = path.resolve(__dirname, '../../../deploy');

interface Sandbox {
  dir: string;
  root: string;
  home: string;
  units: string;
  tmp: string;
  log: string;
  env: Record<string, string>;
}

function write(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function sandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bytrader-deploy-test-'));
  const root = path.join(dir, 'repo');
  const home = path.join(dir, 'deploy-home');
  const units = path.join(dir, 'units');
  const tmp = path.join(dir, 'tmp');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(tmp);
  write(path.join(root, 'worker/dist/autotrader.js'), 'v1 autotrader\n');
  write(path.join(root, 'worker/dist/lib/mt5Client.js'), 'v1 client\n');
  write(path.join(root, 'worker/tsconfig.json'), '{}\n');
  write(path.join(units, 'bytrader-autotrader.service'), 'ExecStart=node dist/autotrader.js\n');
  write(path.join(units, 'bytrader-worker.service'), 'ExecStart=node dist/index.js\n');
  // Fake service manager: records every call.
  write(path.join(dir, 'bin/systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> "${log}"\n`, 0o755);
  // Fake compiler: writes a "v2" build into --outDir.
  write(
    path.join(dir, 'bin/tsc'),
    `#!/usr/bin/env bash\nout=""\nwhile [[ $# -gt 0 ]]; do [[ "$1" == "--outDir" ]] && out="$2"; shift; done\nmkdir -p "$out/lib"\necho "v2 autotrader" > "$out/autotrader.js"\necho "v2 client" > "$out/lib/mt5Client.js"\necho "tsc $out" >> "${log}"\n`,
    0o755,
  );
  // Fake preflight: exit code chosen per stage by FAKE_PRE_RC / FAKE_POST_RC.
  write(
    path.join(dir, 'bin/preflight'),
    `#!/usr/bin/env bash\necho "preflight $*" >> "${log}"\nif [[ " $* " == *" --stage post "* ]]; then exit "\${FAKE_POST_RC:-0}"; fi\nexit "\${FAKE_PRE_RC:-0}"\n`,
    0o755,
  );
  write(path.join(dir, 'bin/health'), `#!/usr/bin/env bash\necho "health $*" >> "${log}"\nexit "\${FAKE_HEALTH_RC:-0}"\n`, 0o755);
  return {
    dir,
    root,
    home,
    units,
    tmp,
    log,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      TMPDIR: tmp,
      BYTRADER_ROOT: root,
      BYTRADER_DEPLOY_HOME: home,
      BYTRADER_UNIT_DIR: units,
      BYTRADER_SYSTEMCTL: path.join(dir, 'bin/systemctl'),
      BYTRADER_TSC: path.join(dir, 'bin/tsc'),
      BYTRADER_PREFLIGHT: path.join(dir, 'bin/preflight'),
      BYTRADER_HEALTH_CMD: path.join(dir, 'bin/health'),
      BYTRADER_SETTLE_SEC: '0',
    },
  };
}

function run(sb: Sandbox, script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [path.join(SCRIPTS, script), ...args], {
    env: { ...sb.env, ...env },
    input: '',
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function calls(sb: Sandbox): string[] {
  return fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function tree(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}=${fs.readFileSync(full, 'utf8')}`);
    }
  };
  walk(dir);
  return out.join('|');
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('deploy-v2.sh', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  });

  it('a dry run changes nothing and never touches the services', () => {
    const before = tree(sb.root) + tree(sb.units);
    const r = run(sb, 'deploy-v2.sh', []);
    expect(r.code).toBe(0);
    expect(r.out).toContain('DRY RUN');
    expect(tree(sb.root) + tree(sb.units)).toBe(before);
    expect(fs.existsSync(sb.home)).toBe(false);
    expect(calls(sb).filter((c) => c.startsWith('systemctl'))).toEqual([]);
    // The temporary build lived in worker/.dist-dryrun-* and is gone.
    expect(calls(sb).find((c) => c.startsWith('tsc'))).toMatch(/\/worker\/\.dist-dryrun-/);
    expect(fs.readdirSync(path.join(sb.root, 'worker')).filter((n) => n.startsWith('.dist-'))).toEqual([]);
  });

  it('a dry run reports a failing preflight through its exit code', () => {
    const r = run(sb, 'deploy-v2.sh', [], { FAKE_PRE_RC: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAILS');
  });

  it('--execute aborts before any change when the preflight fails, and removes its staging build', () => {
    const before = tree(sb.root);
    const r = run(sb, 'deploy-v2.sh', ['--execute'], { FAKE_PRE_RC: '1', BYTRADER_CONFIRM: 'ignored' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('preflight failed; nothing was changed');
    expect(tree(sb.root)).toBe(before);
    expect(calls(sb).filter((c) => c.startsWith('systemctl'))).toEqual([]);
  });

  it('--execute aborts without the exact typed confirmation', () => {
    const before = tree(sb.root);
    const r = run(sb, 'deploy-v2.sh', ['--execute'], { BYTRADER_CONFIRM: 'DEPLOY V2' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('confirmation did not match');
    expect(tree(sb.root)).toBe(before);
    expect(calls(sb).filter((c) => c.startsWith('systemctl'))).toEqual([]);
  });

  function deployWithStamp(extra: Record<string, string> = {}) {
    // Freeze `date` inside the script so the confirmation phrase is predictable.
    write(path.join(sb.dir, 'bin/date'), '#!/usr/bin/env bash\necho 20261021T120000Z\n', 0o755);
    const env = { ...sb.env, PATH: `${path.join(sb.dir, 'bin')}:${sb.env.PATH}`, BYTRADER_CONFIRM: 'DEPLOY V2 20261021T120000Z', ...extra };
    const r = spawnSync('bash', [path.join(SCRIPTS, 'deploy-v2.sh'), '--execute'], { env, input: '', encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('--execute backs up, stops in order, swaps, waits for the EA, starts in order and checks health', () => {
    const r = deployWithStamp({ BYTRADER_EA_CONFIRM: 'EA V2 ATTACHED' });
    expect(r.code, r.out).toBe(0);
    const run1 = path.join(sb.home, '20261021T120000Z');
    expect(read(path.join(sb.root, 'worker/dist/autotrader.js'))).toBe('v2 autotrader\n');
    expect(read(path.join(sb.root, 'worker/.dist-prev-20261021T120000Z/autotrader.js'))).toBe('v1 autotrader\n');
    expect(read(path.join(run1, 'backup/dist/autotrader.js'))).toBe('v1 autotrader\n');
    expect(read(path.join(run1, 'backup/units/bytrader-autotrader.service'))).toContain('ExecStart');
    expect(read(path.join(run1, 'manifest.sha256'))).toMatch(/\.\/dist\/autotrader\.js/);
    expect(fs.readlinkSync(path.join(sb.home, 'latest'))).toBe(run1);
    expect(calls(sb).filter((c) => c.startsWith('systemctl'))).toEqual([
      'systemctl stop bytrader-autotrader.service',
      'systemctl stop bytrader-worker.service',
      'systemctl start bytrader-worker.service',
      'systemctl start bytrader-autotrader.service',
    ]);
    const post = calls(sb).find((c) => c.includes('--stage post'));
    expect(post).toContain('--expect-account DEMO');
    expect(r.out).toContain('execution disabled');
  });

  it('a failed post check leaves a safe stopped AutoTrader and points to the rollback', () => {
    const r = deployWithStamp({ BYTRADER_EA_CONFIRM: 'EA V2 ATTACHED', FAKE_POST_RC: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('SAFE STOP');
    expect(r.out).toContain('rollback-v2.sh --execute');
    expect(calls(sb).filter((c) => c.startsWith('systemctl')).at(-1)).toBe('systemctl stop bytrader-autotrader.service');
  });

  it('stopping at the EA step leaves both services stopped', () => {
    const r = deployWithStamp({ BYTRADER_EA_CONFIRM: 'ABORT' });
    expect(r.code).toBe(1);
    expect(calls(sb).filter((c) => c.startsWith('systemctl start'))).toEqual([]);
  });
});

describe('rollback-v2.sh', () => {
  let sb: Sandbox;
  const STAMP = '20261021T120000Z';

  beforeEach(() => {
    sb = sandbox();
    write(path.join(sb.dir, 'bin/date'), `#!/usr/bin/env bash\necho ${STAMP}\n`, 0o755);
    sb.env.PATH = `${path.join(sb.dir, 'bin')}:${sb.env.PATH}`;
    const r = spawnSync('bash', [path.join(SCRIPTS, 'deploy-v2.sh'), '--execute'], {
      env: { ...sb.env, BYTRADER_CONFIRM: `DEPLOY V2 ${STAMP}`, BYTRADER_EA_CONFIRM: 'EA V2 ATTACHED' },
      input: '',
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    fs.rmSync(sb.log, { force: true });
  });

  afterEach(() => {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  });

  it('a dry run lists what would be restored and changes nothing', () => {
    const before = tree(sb.root);
    const r = run(sb, 'rollback-v2.sh', []);
    expect(r.code).toBe(0);
    expect(r.out).toContain('DRY RUN');
    expect(tree(sb.root)).toBe(before);
    expect(calls(sb)).toEqual([]);
  });

  it('--execute restores the previous build, keeps the failed one, and restarts in order', () => {
    const r = run(sb, 'rollback-v2.sh', ['--execute'], { BYTRADER_ROLLBACK_CONFIRM: `ROLLBACK ${STAMP}`, BYTRADER_EA_CONFIRM: 'EA V1 RESTORED' });
    expect(r.code, r.out).toBe(0);
    expect(read(path.join(sb.root, 'worker/dist/autotrader.js'))).toBe('v1 autotrader\n');
    expect(read(path.join(sb.root, `worker/.dist-failed-${STAMP}/autotrader.js`))).toBe('v2 autotrader\n');
    expect(calls(sb).filter((c) => c.startsWith('systemctl'))).toEqual([
      'systemctl stop bytrader-autotrader.service',
      'systemctl stop bytrader-worker.service',
      'systemctl start bytrader-worker.service',
      'systemctl start bytrader-autotrader.service',
    ]);
    expect(calls(sb).filter((c) => c.startsWith('health'))).toHaveLength(2);
  });

  it('restores from the verified backup copy when the previous build is gone, and refuses a tampered backup', () => {
    fs.rmSync(path.join(sb.root, `worker/.dist-prev-${STAMP}`), { recursive: true });
    write(path.join(sb.home, STAMP, 'backup/dist/autotrader.js'), 'tampered\n');
    const r = run(sb, 'rollback-v2.sh', ['--execute'], { BYTRADER_ROLLBACK_CONFIRM: `ROLLBACK ${STAMP}`, BYTRADER_EA_CONFIRM: 'SKIP' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not match the backup manifest');
    expect(calls(sb).filter((c) => c.startsWith('systemctl start'))).toEqual([]);
  });

  it('refuses to restore a v1 build that needs the Bybit SDK when node_modules no longer has it', () => {
    write(path.join(sb.root, `worker/.dist-prev-${STAMP}/lib/bybitClient.js`), 'require("bybit-api")\n');
    const r = run(sb, 'rollback-v2.sh', ['--execute'], { BYTRADER_ROLLBACK_CONFIRM: `ROLLBACK ${STAMP}`, BYTRADER_EA_CONFIRM: 'SKIP' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('node_modules/bybit-api');
    expect(calls(sb)).toEqual([]);

    fs.mkdirSync(path.join(sb.root, 'node_modules/bybit-api'), { recursive: true });
    const dry = run(sb, 'rollback-v2.sh', []);
    expect(dry.code).toBe(0);
  });

  it('refuses without the typed confirmation', () => {
    const before = tree(sb.root);
    const r = run(sb, 'rollback-v2.sh', ['--execute'], { BYTRADER_ROLLBACK_CONFIRM: 'ROLLBACK' });
    expect(r.code).toBe(1);
    expect(tree(sb.root)).toBe(before);
  });
});
