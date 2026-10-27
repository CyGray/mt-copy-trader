/**
 * fakeFirestore.ts
 *
 * In-memory stand-in for the subset of the firebase-admin Firestore API used by
 * the worker. Test-only: it never touches the network. Shared by the trade set
 * store, engine and signal feed tests; lifecycle and reconciler tests can reuse it.
 *
 * Supported API:
 *  - db.collection(name): doc(id?), add(data), where(field, op, value), orderBy(field, dir?), limit(n), get()
 *  - doc: get(), set(data, { merge? }), create(data), update(data), delete()
 *  - snapshots: exists, id, ref, data(), get(field)
 *  - where operators: ==, in, >, >=, <, <=. Documents without the field never match (as in Firestore).
 *  - orderBy drops documents without the field and sorts stably (ties keep insertion order).
 *  - db.runTransaction(fn): tx.get(ref | query), tx.set / create / update / delete(ref, ...). Transactions run
 *    one at a time. Writes are committed after fn resolves; if fn or the commit throws, the store is restored.
 *  - db.batch(): set / create / update / delete, then commit() applies all writes atomically.
 *  - set options: { merge } deep-merges; { mergeFields: ['a.b'] } writes only the listed paths.
 *  - Errors mirror firebase-admin codes: create on an existing doc → code 6 ALREADY_EXISTS;
 *    update on a missing doc → code 5 NOT_FOUND; injected failures → code 14 UNAVAILABLE by default.
 *  - Like Firestore, an undefined value anywhere in written data throws (code 3 INVALID_ARGUMENT).
 *    Callers must strip undefined fields before writing.
 *
 * Test helpers (not part of the Firestore API):
 *  - seed(path, data) writes directly; peek(path) reads a copy; docs(collection) lists in insertion order
 *  - failNext(op, error?) makes the next call of that operation reject with error
 *  - setOffline(true) makes every operation reject with UNAVAILABLE until setOffline(false) (an outage)
 *  - writes: ordered log of successful writes ({ op, path, data }) for asserting persist-before-send
 *  - asFirestore(fake) casts to FirebaseFirestore.Firestore for vi.mock('./firestoreAdmin') factories
 */

export type FakeData = Record<string, unknown>;
export type FakeOp = 'get' | 'set' | 'create' | 'update' | 'delete' | 'query' | 'transaction' | 'batch';
export interface FakeWrite {
  op: 'set' | 'create' | 'update' | 'delete';
  path: string;
  data?: FakeData;
}
export type FakeWhereOp = '==' | 'in' | '>' | '>=' | '<' | '<=';
export interface FakeSetOptions {
  merge?: boolean;
  /** Only these dotted field paths are written (firebase-admin `mergeFields`). */
  mergeFields?: string[];
}

const UNAVAILABLE_CODE = 14;

export class FakeFirestoreError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`${code} ${message}`);
    this.name = 'FakeFirestoreError';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is FakeData {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function assertWritable(value: unknown, path: string): void {
  if (value === undefined) {
    throw new FakeFirestoreError(3, `INVALID_ARGUMENT: Cannot use "undefined" as a Firestore value (${path})`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new FakeFirestoreError(3, `INVALID_ARGUMENT: unsupported value type ${typeof value} (${path})`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertWritable(item, `${path}[${i}]`));
  } else if (isPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) assertWritable(inner, `${path}.${key}`);
  }
}

function getField(data: FakeData, field: string): unknown {
  let cur: unknown = data;
  for (const part of field.split('.')) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setField(target: FakeData, field: string, value: unknown): void {
  const parts = field.split('.');
  let cur: FakeData = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part] as FakeData;
  }
  cur[parts[parts.length - 1]] = clone(value);
}

/** Deep merge: nested plain objects merge, arrays and scalars replace. */
function mergeInto(target: FakeData, source: FakeData): void {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key] as FakeData, value);
    } else {
      target[key] = clone(value);
    }
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compareValues(a: unknown, b: unknown): number | undefined {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

interface FakeFilter {
  field: string;
  op: FakeWhereOp;
  value: unknown;
}

interface FakeOrder {
  field: string;
  direction: 'asc' | 'desc';
}

function matches(data: FakeData, filter: FakeFilter): boolean {
  const actual = getField(data, filter.field);
  if (actual === undefined) return false;
  switch (filter.op) {
    case '==':
      return sameValue(actual, filter.value);
    case 'in':
      return Array.isArray(filter.value) && filter.value.some((item) => sameValue(actual, item));
    case '>': {
      const c = compareValues(actual, filter.value);
      return c !== undefined && c > 0;
    }
    case '>=': {
      const c = compareValues(actual, filter.value);
      return c !== undefined && c >= 0;
    }
    case '<': {
      const c = compareValues(actual, filter.value);
      return c !== undefined && c < 0;
    }
    case '<=': {
      const c = compareValues(actual, filter.value);
      return c !== undefined && c <= 0;
    }
  }
}

export class FakeDocumentSnapshot {
  readonly id: string;
  readonly ref: FakeDocumentRef;
  readonly exists: boolean;
  private readonly body: FakeData | undefined;

  constructor(ref: FakeDocumentRef, body: FakeData | undefined) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = body !== undefined;
    this.body = body === undefined ? undefined : clone(body);
  }

  data(): FakeData | undefined {
    return this.body === undefined ? undefined : clone(this.body);
  }

  get(field: string): unknown {
    return this.body === undefined ? undefined : clone(getField(this.body, field));
  }
}

export class FakeQuerySnapshot {
  readonly docs: FakeDocumentSnapshot[];

  constructor(docs: FakeDocumentSnapshot[]) {
    this.docs = docs;
  }

  get empty(): boolean {
    return this.docs.length === 0;
  }

  get size(): number {
    return this.docs.length;
  }

  forEach(callback: (doc: FakeDocumentSnapshot) => void): void {
    this.docs.forEach(callback);
  }
}

export class FakeDocumentRef {
  constructor(
    private readonly fs: FakeFirestore,
    readonly collectionName: string,
    readonly id: string,
  ) {}

  get path(): string {
    return `${this.collectionName}/${this.id}`;
  }

  async get(): Promise<FakeDocumentSnapshot> {
    return this.fs.readSnapshot(this);
  }

  async set(data: FakeData, options?: FakeSetOptions): Promise<void> {
    this.fs.writeSet(this, data, options);
  }

  async create(data: FakeData): Promise<void> {
    this.fs.writeCreate(this, data);
  }

  async update(data: FakeData): Promise<void> {
    this.fs.writeUpdate(this, data);
  }

  async delete(): Promise<void> {
    this.fs.writeDelete(this);
  }
}

export class FakeQuery {
  constructor(
    private readonly fs: FakeFirestore,
    private readonly collectionName: string,
    private readonly filters: FakeFilter[] = [],
    private readonly orders: FakeOrder[] = [],
    private readonly limitCount: number | null = null,
  ) {}

  where(field: string, op: FakeWhereOp, value: unknown): FakeQuery {
    return new FakeQuery(
      this.fs,
      this.collectionName,
      [...this.filters, { field, op, value }],
      this.orders,
      this.limitCount,
    );
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.fs, this.collectionName, this.filters, [...this.orders, { field, direction }], this.limitCount);
  }

  limit(count: number): FakeQuery {
    return new FakeQuery(this.fs, this.collectionName, this.filters, this.orders, count);
  }

  async get(): Promise<FakeQuerySnapshot> {
    return this.fs.runQuery(this.collectionName, this.filters, this.orders, this.limitCount);
  }
}

export class FakeCollectionRef extends FakeQuery {
  constructor(
    private readonly store: FakeFirestore,
    readonly name: string,
  ) {
    super(store, name);
  }

  doc(id?: string): FakeDocumentRef {
    return new FakeDocumentRef(this.store, this.name, id ?? this.store.nextAutoId());
  }

  async add(data: FakeData): Promise<FakeDocumentRef> {
    const ref = this.doc();
    this.store.writeCreate(ref, data);
    return ref;
  }
}

export interface FakeTransaction {
  get(ref: FakeDocumentRef): Promise<FakeDocumentSnapshot>;
  get(query: FakeQuery): Promise<FakeQuerySnapshot>;
  set(ref: FakeDocumentRef, data: FakeData, options?: FakeSetOptions): FakeTransaction;
  create(ref: FakeDocumentRef, data: FakeData): FakeTransaction;
  update(ref: FakeDocumentRef, data: FakeData): FakeTransaction;
  delete(ref: FakeDocumentRef): FakeTransaction;
}

export interface FakeWriteBatch {
  set(ref: FakeDocumentRef, data: FakeData, options?: FakeSetOptions): FakeWriteBatch;
  create(ref: FakeDocumentRef, data: FakeData): FakeWriteBatch;
  update(ref: FakeDocumentRef, data: FakeData): FakeWriteBatch;
  delete(ref: FakeDocumentRef): FakeWriteBatch;
  commit(): Promise<void>;
}

export class FakeFirestore {
  private readonly collections = new Map<string, Map<string, FakeData>>();
  private readonly failures = new Map<FakeOp, Error[]>();
  private readonly writeLog: FakeWrite[] = [];
  private autoIdCounter = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private offline = false;

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }

  /** Runs fn with buffered writes. Transactions are serialized. */
  runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => this.executeTransaction(fn));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A write batch: nothing is applied until commit(), which applies everything or nothing. */
  batch(): FakeWriteBatch {
    const pending: Array<() => void> = [];
    const batch: FakeWriteBatch = {
      set: (ref, data, options) => {
        assertWritable(data, ref.path);
        pending.push(() => this.applySet(ref, data, options));
        return batch;
      },
      create: (ref, data) => {
        assertWritable(data, ref.path);
        pending.push(() => this.applyCreate(ref, data));
        return batch;
      },
      update: (ref, data) => {
        assertWritable(data, ref.path);
        pending.push(() => this.applyUpdate(ref, data));
        return batch;
      },
      delete: (ref) => {
        pending.push(() => this.applyDelete(ref));
        return batch;
      },
      commit: async () => {
        this.take('batch');
        const snapshot = this.snapshotState();
        const logLength = this.writeLog.length;
        try {
          for (const apply of pending) apply();
        } catch (err) {
          this.restoreState(snapshot);
          this.writeLog.length = logLength;
          throw err;
        }
      },
    };
    return batch;
  }

  /** Writes a document directly, bypassing failure injection and the write log. */
  seed(path: string, data: FakeData): void {
    const [collectionName, id] = this.splitPath(path);
    assertWritable(data, path);
    this.bucket(collectionName).set(id, clone(data));
  }

  /** Copy of the stored document, or undefined. */
  peek(path: string): FakeData | undefined {
    const [collectionName, id] = this.splitPath(path);
    const body = this.collections.get(collectionName)?.get(id);
    return body === undefined ? undefined : clone(body);
  }

  /** All documents of a collection in insertion order. */
  docs(collectionName: string): { id: string; data: FakeData }[] {
    const bucket = this.collections.get(collectionName);
    if (!bucket) return [];
    return [...bucket.entries()].map(([id, data]) => ({ id, data: clone(data) }));
  }

  /** Successful writes in order (transactions log only when committed). */
  get writes(): FakeWrite[] {
    return this.writeLog.map((w) => ({ ...w, data: w.data === undefined ? undefined : clone(w.data) }));
  }

  /** Makes the next call of `op` reject with `error` (default: code 14 UNAVAILABLE). */
  failNext(op: FakeOp, error?: Error): void {
    const queue = this.failures.get(op) ?? [];
    queue.push(error ?? new FakeFirestoreError(UNAVAILABLE_CODE, `UNAVAILABLE: injected ${op} failure`));
    this.failures.set(op, queue);
  }

  /** While true, every operation rejects with code 14 UNAVAILABLE (seed/peek/docs still work). */
  setOffline(down: boolean): void {
    this.offline = down;
  }

  /** Clears all documents, failures and the write log. */
  reset(): void {
    this.collections.clear();
    this.failures.clear();
    this.offline = false;
    this.writeLog.length = 0;
    this.autoIdCounter = 0;
  }

  // ---- internal surface used by refs, queries and transactions -------------

  nextAutoId(): string {
    this.autoIdCounter += 1;
    return `auto${String(this.autoIdCounter).padStart(6, '0')}`;
  }

  readSnapshot(ref: FakeDocumentRef): FakeDocumentSnapshot {
    this.take('get');
    return new FakeDocumentSnapshot(ref, this.collections.get(ref.collectionName)?.get(ref.id));
  }

  runQuery(
    collectionName: string,
    filters: FakeFilter[],
    orders: FakeOrder[],
    limitCount: number | null,
  ): FakeQuerySnapshot {
    this.take('query');
    const bucket = this.collections.get(collectionName) ?? new Map<string, FakeData>();
    let rows = [...bucket.entries()].filter(([, data]) => filters.every((f) => matches(data, f)));
    for (const order of [...orders].reverse()) {
      rows = rows.filter(([, data]) => getField(data, order.field) !== undefined);
      rows.sort(([, a], [, b]) => {
        const c = compareValues(getField(a, order.field), getField(b, order.field)) ?? 0;
        return order.direction === 'desc' ? -c : c;
      });
    }
    if (limitCount !== null) rows = rows.slice(0, limitCount);
    return new FakeQuerySnapshot(
      rows.map(([id, data]) => new FakeDocumentSnapshot(new FakeDocumentRef(this, collectionName, id), data)),
    );
  }

  writeSet(ref: FakeDocumentRef, data: FakeData, options?: FakeSetOptions): void {
    this.take('set');
    this.applySet(ref, data, options);
  }

  writeCreate(ref: FakeDocumentRef, data: FakeData): void {
    this.take('create');
    this.applyCreate(ref, data);
  }

  writeUpdate(ref: FakeDocumentRef, data: FakeData): void {
    this.take('update');
    this.applyUpdate(ref, data);
  }

  writeDelete(ref: FakeDocumentRef): void {
    this.take('delete');
    this.applyDelete(ref);
  }

  // ---- private helpers -------------------------------------------------------

  private async executeTransaction<T>(fn: (tx: FakeTransaction) => Promise<T> | T): Promise<T> {
    this.take('transaction');
    const pending: Array<() => void> = [];
    const tx = {
      get: async (target: FakeDocumentRef | FakeQuery) => {
        if (target instanceof FakeQuery) return target.get();
        this.take('get');
        return new FakeDocumentSnapshot(target, this.collections.get(target.collectionName)?.get(target.id));
      },
      set: (ref: FakeDocumentRef, data: FakeData, options?: FakeSetOptions) => {
        assertWritable(data, ref.path);
        pending.push(() => this.applySet(ref, data, options));
        return tx;
      },
      create: (ref: FakeDocumentRef, data: FakeData) => {
        assertWritable(data, ref.path);
        pending.push(() => this.applyCreate(ref, data));
        return tx;
      },
      update: (ref: FakeDocumentRef, data: FakeData) => {
        assertWritable(data, ref.path);
        pending.push(() => this.applyUpdate(ref, data));
        return tx;
      },
      delete: (ref: FakeDocumentRef) => {
        pending.push(() => this.applyDelete(ref));
        return tx;
      },
    } as FakeTransaction;

    const snapshot = this.snapshotState();
    const logLength = this.writeLog.length;
    try {
      const result = await fn(tx);
      for (const apply of pending) apply();
      return result;
    } catch (err) {
      this.restoreState(snapshot);
      this.writeLog.length = logLength;
      throw err;
    }
  }

  private take(op: FakeOp): void {
    if (this.offline) throw new FakeFirestoreError(UNAVAILABLE_CODE, `UNAVAILABLE: offline (${op})`);
    const queue = this.failures.get(op);
    if (queue && queue.length > 0) throw queue.shift();
  }

  private splitPath(path: string): [string, string] {
    const parts = path.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`fake firestore: bad document path ${path}`);
    return [parts[0], parts[1]];
  }

  private bucket(name: string): Map<string, FakeData> {
    let bucket = this.collections.get(name);
    if (!bucket) {
      bucket = new Map();
      this.collections.set(name, bucket);
    }
    return bucket;
  }

  private applySet(ref: FakeDocumentRef, data: FakeData, options?: FakeSetOptions): void {
    assertWritable(data, ref.path);
    const bucket = this.bucket(ref.collectionName);
    const existing = bucket.get(ref.id);
    if (options?.mergeFields) {
      const target = existing ?? {};
      for (const field of options.mergeFields) {
        const value = getField(data, field);
        if (value === undefined) {
          throw new FakeFirestoreError(3, `INVALID_ARGUMENT: mergeFields path ${field} is not in the data`);
        }
        setField(target, field, value);
      }
      bucket.set(ref.id, target);
    } else if (options?.merge && existing) {
      mergeInto(existing, data);
    } else {
      bucket.set(ref.id, clone(data));
    }
    this.writeLog.push({ op: 'set', path: ref.path, data: clone(data) });
  }

  private applyCreate(ref: FakeDocumentRef, data: FakeData): void {
    assertWritable(data, ref.path);
    const bucket = this.bucket(ref.collectionName);
    if (bucket.has(ref.id)) {
      throw new FakeFirestoreError(6, `ALREADY_EXISTS: Document already exists: ${ref.path}`);
    }
    bucket.set(ref.id, clone(data));
    this.writeLog.push({ op: 'create', path: ref.path, data: clone(data) });
  }

  private applyUpdate(ref: FakeDocumentRef, data: FakeData): void {
    assertWritable(data, ref.path);
    const existing = this.collections.get(ref.collectionName)?.get(ref.id);
    if (!existing) {
      throw new FakeFirestoreError(5, `NOT_FOUND: No document to update: ${ref.path}`);
    }
    for (const [field, value] of Object.entries(data)) setField(existing, field, value);
    this.writeLog.push({ op: 'update', path: ref.path, data: clone(data) });
  }

  private applyDelete(ref: FakeDocumentRef): void {
    this.collections.get(ref.collectionName)?.delete(ref.id);
    this.writeLog.push({ op: 'delete', path: ref.path });
  }

  private snapshotState(): Map<string, Map<string, FakeData>> {
    const copy = new Map<string, Map<string, FakeData>>();
    for (const [name, bucket] of this.collections) {
      copy.set(name, new Map([...bucket.entries()].map(([id, data]) => [id, clone(data)])));
    }
    return copy;
  }

  private restoreState(snapshot: Map<string, Map<string, FakeData>>): void {
    this.collections.clear();
    for (const [name, bucket] of snapshot) this.collections.set(name, bucket);
  }
}

/** Creates an empty in-memory Firestore. */
export function createFakeFirestore(): FakeFirestore {
  return new FakeFirestore();
}

/** Casts the fake for code that expects FirebaseFirestore.Firestore (use only in tests). */
export function asFirestore(fake: FakeFirestore): FirebaseFirestore.Firestore {
  return fake as unknown as FirebaseFirestore.Firestore;
}
