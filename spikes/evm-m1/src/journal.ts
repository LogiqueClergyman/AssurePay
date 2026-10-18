import { open, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Address, Hex } from "viem";
import { NATIVE_USDC } from "./preflight.js";
import { PUBLIC_GAS_CAPS, PUBLIC_MAX_TOTAL_GAS, type PublicConfig } from "./public-config.js";

export const JOURNAL_VERSION = 1 as const;
export const JOURNAL_TERMS = Object.freeze({
  gross: "100",
  providerNet: "93",
  premium: "7",
});

export type PublicTransactionKind = "deploy" | "success" | "admission" | "revert";

export type PreparedTransactionRecord = Readonly<{
  kind: PublicTransactionKind;
  chainId: 84532;
  transactionHash: Hex;
  from: Address;
  to: Address | null;
  nonce: string;
  calldataHash: Hex;
  intentHash?: Hex;
}>;

export type PublicSession = Readonly<{
  version: typeof JOURNAL_VERSION;
  config: Readonly<{
    chainId: 84532;
    token: typeof NATIVE_USDC;
    payer: Address;
    relayer: Address;
    providerPayout: Address;
    budget: Readonly<{
      maxFeePerGasAtomic: string;
      maxPriorityFeePerGasAtomic: string;
      maxTotalGas: string;
      maxL1FeeWei: string;
      gasCaps: Readonly<Record<PublicTransactionKind, string>>;
    }>;
  }>;
  terms: typeof JOURNAL_TERMS;
  transactions: readonly PreparedTransactionRecord[];
}>;

export type JournalCode =
  | "EXECUTION_NOT_ENABLED"
  | "SESSION_EXISTS"
  | "SESSION_UNAVAILABLE"
  | "SESSION_INVALID"
  | "SESSION_WRITE_FAILED"
  | "RECORD_EXISTS"
  | "RECORD_INVALID"
  | "RECORD_WRITE_FAILED";

export class JournalError extends Error {
  constructor(readonly code: JournalCode) {
    super(`M1_JOURNAL_${code}`);
    this.name = "JournalError";
  }
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const MAX_JSON_BYTES = 32_768;
const SESSION_KEYS = ["version", "config", "terms"];
const SESSION_CONFIG_KEYS = ["chainId", "token", "payer", "relayer", "providerPayout", "budget"];
const BUDGET_KEYS = ["maxFeePerGasAtomic", "maxPriorityFeePerGasAtomic", "maxTotalGas", "maxL1FeeWei", "gasCaps"];
const RECORD_KEYS_WITHOUT_INTENT = ["kind", "chainId", "transactionHash", "from", "to", "nonce", "calldataHash"];
const RECORD_KEYS_WITH_INTENT = [...RECORD_KEYS_WITHOUT_INTENT, "intentHash"];
const KINDS: readonly PublicTransactionKind[] = ["deploy", "success", "admission", "revert"];

function objectWithExactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new JournalError("SESSION_INVALID");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== expected.length || expected.some((key) => !Object.hasOwn(object, key))) {
    throw new JournalError("SESSION_INVALID");
  }
  return object;
}

function exactPublicConfig(config: PublicConfig): PublicSession["config"] {
  if (config.mode !== "execute" || config.chainId !== 84532 || config.token !== NATIVE_USDC) {
    throw new JournalError("EXECUTION_NOT_ENABLED");
  }
  return {
    chainId: 84532,
    token: NATIVE_USDC,
    payer: config.payer,
    relayer: config.relayer,
    providerPayout: config.providerPayout,
    budget: {
      maxFeePerGasAtomic: config.budget.maxFeePerGasAtomic.toString(),
      maxPriorityFeePerGasAtomic: config.budget.maxPriorityFeePerGasAtomic.toString(),
      maxTotalGas: config.budget.maxTotalGas.toString(),
      maxL1FeeWei: config.budget.maxL1FeeWei.toString(),
      gasCaps: {
        deploy: PUBLIC_GAS_CAPS.deploy.toString(),
        success: PUBLIC_GAS_CAPS.success.toString(),
        admission: PUBLIC_GAS_CAPS.admission.toString(),
        revert: PUBLIC_GAS_CAPS.revert.toString(),
      },
    },
  };
}

function parseAddress(value: unknown, nullable = false): Address | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ADDRESS_RE.test(value) || /^0x0{40}$/.test(value)) {
    throw new JournalError("RECORD_INVALID");
  }
  return value as Address;
}

function parseHash(value: unknown): Hex {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new JournalError("RECORD_INVALID");
  return value as Hex;
}

function parseUintString(value: unknown): string {
  if (typeof value !== "string" || value.length > 78 || !UINT_RE.test(value)) {
    throw new JournalError("RECORD_INVALID");
  }
  if (BigInt(value) > (1n << 256n) - 1n) throw new JournalError("RECORD_INVALID");
  return value;
}

function parseRecord(value: unknown): PreparedTransactionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new JournalError("RECORD_INVALID");
  const candidate = value as Record<string, unknown>;
  const isSettlement = candidate.kind === "success" || candidate.kind === "revert";
  const record = objectWithExactKeys(value, isSettlement ? RECORD_KEYS_WITH_INTENT : RECORD_KEYS_WITHOUT_INTENT);
  if (!KINDS.includes(record.kind as PublicTransactionKind) || record.chainId !== 84532) {
    throw new JournalError("RECORD_INVALID");
  }
  const kind = record.kind as PublicTransactionKind;
  const to = parseAddress(record.to, true);
  if ((kind === "deploy") !== (to === null)) throw new JournalError("RECORD_INVALID");
  const parsed: PreparedTransactionRecord = {
    kind,
    chainId: 84532,
    transactionHash: parseHash(record.transactionHash),
    from: parseAddress(record.from) as Address,
    to,
    nonce: parseUintString(record.nonce),
    calldataHash: parseHash(record.calldataHash),
    ...(isSettlement ? { intentHash: parseHash(record.intentHash) } : {}),
  };
  return Object.freeze(parsed);
}

function parseSessionConfig(value: unknown): PublicSession["config"] {
  const object = objectWithExactKeys(value, SESSION_CONFIG_KEYS);
  const budget = objectWithExactKeys(object.budget, BUDGET_KEYS);
  const gasCaps = objectWithExactKeys(budget.gasCaps, ["deploy", "success", "admission", "revert"]);
  if (object.chainId !== 84532 || object.token !== NATIVE_USDC) throw new JournalError("SESSION_INVALID");
  const payer = parseAddress(object.payer) as Address;
  const relayer = parseAddress(object.relayer) as Address;
  const providerPayout = parseAddress(object.providerPayout) as Address;
  if (new Set([payer, relayer, providerPayout]).size !== 3) throw new JournalError("SESSION_INVALID");
  const parsedCaps = {
    deploy: parseUintString(gasCaps.deploy),
    success: parseUintString(gasCaps.success),
    admission: parseUintString(gasCaps.admission),
    revert: parseUintString(gasCaps.revert),
  };
  const expectedCaps = {
    deploy: PUBLIC_GAS_CAPS.deploy.toString(),
    success: PUBLIC_GAS_CAPS.success.toString(),
    admission: PUBLIC_GAS_CAPS.admission.toString(),
    revert: PUBLIC_GAS_CAPS.revert.toString(),
  };
  if (JSON.stringify(parsedCaps) !== JSON.stringify(expectedCaps)) throw new JournalError("SESSION_INVALID");
  const maxFeePerGasAtomic = parseUintString(budget.maxFeePerGasAtomic);
  const maxPriorityFeePerGasAtomic = parseUintString(budget.maxPriorityFeePerGasAtomic);
  const maxTotalGas = parseUintString(budget.maxTotalGas);
  const maxL1FeeWei = parseUintString(budget.maxL1FeeWei);
  const totalGasCap = Object.values(PUBLIC_GAS_CAPS).reduce((sum, cap) => sum + cap, 0n);
  if (BigInt(maxFeePerGasAtomic) === 0n || BigInt(maxPriorityFeePerGasAtomic) > BigInt(maxFeePerGasAtomic) ||
      BigInt(maxTotalGas) < totalGasCap || BigInt(maxTotalGas) > PUBLIC_MAX_TOTAL_GAS || BigInt(maxL1FeeWei) === 0n) {
    throw new JournalError("SESSION_INVALID");
  }
  return Object.freeze({
    chainId: 84532,
    token: NATIVE_USDC,
    payer,
    relayer,
    providerPayout,
    budget: Object.freeze({
      maxFeePerGasAtomic,
      maxPriorityFeePerGasAtomic,
      maxTotalGas,
      maxL1FeeWei,
      gasCaps: Object.freeze(parsedCaps),
    }),
  });
}

function parseSession(value: unknown): Omit<PublicSession, "transactions"> {
  const session = objectWithExactKeys(value, SESSION_KEYS);
  if (session.version !== JOURNAL_VERSION) throw new JournalError("SESSION_INVALID");
  const terms = objectWithExactKeys(session.terms, ["gross", "providerNet", "premium"]);
  if (terms.gross !== JOURNAL_TERMS.gross || terms.providerNet !== JOURNAL_TERMS.providerNet ||
      terms.premium !== JOURNAL_TERMS.premium) throw new JournalError("SESSION_INVALID");
  return Object.freeze({
    version: JOURNAL_VERSION,
    config: parseSessionConfig(session.config),
    terms: JOURNAL_TERMS,
  });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(path: string, contents: string, failureCode: JournalCode): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    throw new JournalError(failureCode);
  }
  await handle.close().catch(() => { throw new JournalError(failureCode); });
}

/** Create a fresh session before generating an intent or asking any signer to sign. */
export async function createSession(path: string, config: PublicConfig): Promise<PublicSession> {
  const publicConfig = exactPublicConfig(config);
  const dir = await mkdir(path, { mode: 0o700 }).then(() => true).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new JournalError("SESSION_EXISTS");
    }
    throw new JournalError("SESSION_WRITE_FAILED");
  });
  if (!dir) throw new JournalError("SESSION_WRITE_FAILED");
  const session = {
    version: JOURNAL_VERSION,
    config: publicConfig,
    terms: JOURNAL_TERMS,
  } as const;
  try {
    await mkdir(join(path, "transactions"), { mode: 0o700 });
    await writeExclusive(join(path, "session.json"), `${JSON.stringify(session)}\n`, "SESSION_WRITE_FAILED");
    await syncDirectory(join(path, "transactions"));
    await syncDirectory(path);
    await syncDirectory(dirname(path));
    return Object.freeze({ ...parseSession(session), transactions: Object.freeze([]) });
  } catch (error) {
    // Remove only the directory this invocation created. A failed journal must not be reused.
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof JournalError) throw error;
    throw new JournalError("SESSION_WRITE_FAILED");
  }
}

/** Persist public transaction identity before broadcast; existing kinds are never overwritten. */
export async function recordPrepared(path: string, input: PreparedTransactionRecord): Promise<PreparedTransactionRecord> {
  const session = await readSession(path);
  const record = parseRecord(input);
  if (record.from !== session.config.relayer || record.chainId !== session.config.chainId) {
    throw new JournalError("RECORD_INVALID");
  }
  const target = join(path, "transactions", `${record.kind}.json`);
  await writeExclusive(target, `${JSON.stringify(record)}\n`, "RECORD_WRITE_FAILED");
  await syncDirectory(join(path, "transactions")).catch(() => { throw new JournalError("RECORD_WRITE_FAILED"); });
  return record;
}

/** Read-only recovery. Any malformed/unknown field or unexpected file fails closed. */
export async function readSession(path: string): Promise<PublicSession> {
  try {
    const dirInfo = await lstat(path);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new JournalError("SESSION_INVALID");
    const rootEntries = (await readdir(path)).sort();
    if (JSON.stringify(rootEntries) !== JSON.stringify(["session.json", "transactions"])) {
      throw new JournalError("SESSION_INVALID");
    }
    const sessionInfo = await lstat(join(path, "session.json"));
    const transactionsInfo = await lstat(join(path, "transactions"));
    if (!sessionInfo.isFile() || sessionInfo.isSymbolicLink() || sessionInfo.size > MAX_JSON_BYTES ||
        !transactionsInfo.isDirectory() || transactionsInfo.isSymbolicLink()) {
      throw new JournalError("SESSION_INVALID");
    }
    const parsed = parseSession(JSON.parse(await readFile(join(path, "session.json"), "utf8")));
    const transactionEntries = (await readdir(join(path, "transactions"))).sort();
    const allowed = KINDS.map((kind) => `${kind}.json`);
    if (transactionEntries.some((name) => !allowed.includes(name))) throw new JournalError("SESSION_INVALID");
    const transactions: PreparedTransactionRecord[] = [];
    for (const name of transactionEntries) {
      const transactionPath = join(path, "transactions", name);
      const info = await lstat(transactionPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) throw new JournalError("SESSION_INVALID");
      const record = parseRecord(JSON.parse(await readFile(transactionPath, "utf8")));
      if (`${record.kind}.json` !== name || record.from !== parsed.config.relayer) throw new JournalError("RECORD_INVALID");
      transactions.push(record);
    }
    return Object.freeze({ ...parsed, transactions: Object.freeze(transactions) });
  } catch (error) {
    if (error instanceof JournalError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new JournalError("SESSION_UNAVAILABLE");
    }
    throw new JournalError("SESSION_INVALID");
  }
}
