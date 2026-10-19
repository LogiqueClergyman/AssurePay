import { open, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const VAULT_SETUP_DEFAULT_PATH = fileURLToPath(new URL("../.env.vault.local", import.meta.url));
export const VAULT_JOURNAL_DEFAULT_PATH = fileURLToPath(new URL("../.local-vault-funding", import.meta.url));
export const VAULT_CHAIN_ID = 84532 as const;
export const VAULT_TARGET_WEI = "410000000000000" as const;
export const VAULT_GAS = "21000" as const;
export const VAULT_MAX_FEE_PER_GAS_WEI = "100000000" as const;
export const VAULT_MAX_PRIORITY_FEE_PER_GAS_WEI = "1000000" as const;
export const VAULT_MAX_AUXILIARY_FEE_WEI = "100000000000000" as const;

export type VaultSetupSummary = Readonly<{ vault: Address; configurationPath: string }>;
export type FundingKind = "excess" | "top-up";
export type FundingPrepared = Readonly<{
  kind: FundingKind;
  transactionHash: Hex;
  from: Address;
  to: Address;
  nonce: string;
  valueWei: string;
  gas: typeof VAULT_GAS;
  maxFeePerGasWei: typeof VAULT_MAX_FEE_PER_GAS_WEI;
  maxPriorityFeePerGasWei: typeof VAULT_MAX_PRIORITY_FEE_PER_GAS_WEI;
  chainId: typeof VAULT_CHAIN_ID;
  calldata: "0x";
}>;
export type CanonicalConfirmation = Readonly<{
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  status: "success";
}>;
export type FundingSession = Readonly<{
  version: 1;
  config: Readonly<{ chainId: typeof VAULT_CHAIN_ID; relayer: Address; vault: Address; targetWei: typeof VAULT_TARGET_WEI }>;
  prepared: readonly FundingPrepared[];
  confirmations: readonly Readonly<{ kind: FundingKind; confirmation: CanonicalConfirmation }>[];
}>;

export type VaultStorageCode = "configuration_exists" | "configuration_write_failed" | "session_exists" |
  "session_invalid" | "session_unavailable" | "record_exists" | "record_invalid" | "record_write_failed";
export class VaultStorageError extends Error {
  constructor(readonly code: VaultStorageCode) {
    super(`M1_VAULT_${code.toUpperCase()}`);
    this.name = "VaultStorageError";
  }
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const MAX_JSON_BYTES = 16_384;
const KINDS: readonly FundingKind[] = ["excess", "top-up"];
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new VaultStorageError("session_invalid");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== keys.length || keys.some((key) => !Object.hasOwn(obj, key))) throw new VaultStorageError("session_invalid");
  return obj;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS_RE.test(value) || /^0x0{40}$/.test(value)) throw new VaultStorageError("record_invalid");
  return value as Address;
}
function hash(value: unknown): Hex {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new VaultStorageError("record_invalid");
  return value as Hex;
}
function uint(value: unknown): string {
  if (typeof value !== "string" || value.length > 78 || !UINT_RE.test(value) || BigInt(value) > (1n << 256n) - 1n) throw new VaultStorageError("record_invalid");
  return value;
}
function parsePrepared(value: unknown): FundingPrepared {
  const obj = exactObject(value, ["kind", "transactionHash", "from", "to", "nonce", "valueWei", "gas", "maxFeePerGasWei", "maxPriorityFeePerGasWei", "chainId", "calldata"]);
  if (!KINDS.includes(obj.kind as FundingKind) || obj.chainId !== VAULT_CHAIN_ID || obj.gas !== VAULT_GAS ||
      obj.maxFeePerGasWei !== VAULT_MAX_FEE_PER_GAS_WEI || obj.maxPriorityFeePerGasWei !== VAULT_MAX_PRIORITY_FEE_PER_GAS_WEI || obj.calldata !== "0x") throw new VaultStorageError("record_invalid");
  return Object.freeze({ kind: obj.kind as FundingKind, transactionHash: hash(obj.transactionHash), from: address(obj.from), to: address(obj.to), nonce: uint(obj.nonce), valueWei: uint(obj.valueWei), gas: VAULT_GAS, maxFeePerGasWei: VAULT_MAX_FEE_PER_GAS_WEI, maxPriorityFeePerGasWei: VAULT_MAX_PRIORITY_FEE_PER_GAS_WEI, chainId: VAULT_CHAIN_ID, calldata: "0x" });
}
function parseConfirmation(value: unknown): CanonicalConfirmation {
  const obj = exactObject(value, ["transactionHash", "blockNumber", "blockHash", "status"]);
  if (obj.status !== "success") throw new VaultStorageError("record_invalid");
  return Object.freeze({ transactionHash: hash(obj.transactionHash), blockNumber: uint(obj.blockNumber), blockHash: hash(obj.blockHash), status: "success" });
}
function parseSession(value: unknown): Omit<FundingSession, "prepared" | "confirmations"> {
  const obj = exactObject(value, ["version", "config"]);
  const cfg = exactObject(obj.config, ["chainId", "relayer", "vault", "targetWei"]);
  if (obj.version !== 1 || cfg.chainId !== VAULT_CHAIN_ID || cfg.targetWei !== VAULT_TARGET_WEI) throw new VaultStorageError("session_invalid");
  const relayer = address(cfg.relayer), vault = address(cfg.vault);
  if (relayer === vault) throw new VaultStorageError("session_invalid");
  return Object.freeze({ version: 1, config: Object.freeze({ chainId: VAULT_CHAIN_ID, relayer, vault, targetWei: VAULT_TARGET_WEI }) });
}
async function syncDir(path: string): Promise<void> { const h = await open(path, "r"); try { await h.sync(); } finally { await h.close(); } }
async function writeExclusive(path: string, contents: string, code: VaultStorageCode): Promise<void> {
  let h;
  try { h = await open(path, "wx", 0o600); await h.writeFile(contents, "utf8"); await h.sync(); }
  catch { if (h) await h.close().catch(() => undefined); throw new VaultStorageError(code); }
  await h.close().catch(() => { throw new VaultStorageError(code); });
}

/** Generate a fresh test-only EOA and persist it once in a private runtime env file. */
export async function setupVault(configurationPath = VAULT_SETUP_DEFAULT_PATH): Promise<VaultSetupSummary> {
  const privateKey = generatePrivateKey();
  const vault = privateKeyToAccount(privateKey).address;
  const path = resolve(configurationPath);
  const journalPath = VAULT_JOURNAL_DEFAULT_PATH;
  const contents = ["# Test-only Base Sepolia vault. Keep private.", `VAULT_ADDRESS=${vault}`, `VAULT_PRIVATE_KEY=${privateKey}`, `VAULT_FUNDING_JOURNAL_DIR=${journalPath}`, ""].join("\n");
  let h;
  try { h = await open(path, "wx", 0o600); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") throw new VaultStorageError("configuration_exists");
    throw new VaultStorageError("configuration_write_failed");
  }
  try { await h.chmod(0o600); await h.writeFile(contents, "utf8"); await h.sync(); await h.close(); await syncDir(dirname(path)); }
  catch { await h.close().catch(() => undefined); throw new VaultStorageError("configuration_write_failed"); }
  return Object.freeze({ vault, configurationPath: path });
}

export async function createFundingSession(path: string, config: { chainId: 84532; relayer: Address; vault: Address; targetWei: "410000000000000" }): Promise<FundingSession> {
  const normalized = parseSession({ version: 1, config: { ...config, relayer: config.relayer.toLowerCase(), vault: config.vault.toLowerCase() } });
  try { await mkdir(path, { mode: 0o700 }); await mkdir(join(path, "records"), { mode: 0o700 });
    await writeExclusive(join(path, "session.json"), `${JSON.stringify(normalized)}\n`, "record_write_failed");
    await syncDir(join(path, "records")); await syncDir(path); await syncDir(dirname(path));
  } catch (error) {
    if (error instanceof VaultStorageError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") throw new VaultStorageError("session_exists");
    throw new VaultStorageError("record_write_failed");
  }
  return Object.freeze({ ...normalized, prepared: Object.freeze([]), confirmations: Object.freeze([]) });
}

export async function readFundingSession(path: string): Promise<FundingSession> {
  try {
    const root = await lstat(path), recordsDir = join(path, "records");
    if (!root.isDirectory() || root.isSymbolicLink() || JSON.stringify((await readdir(path)).sort()) !== JSON.stringify(["records", "session.json"])) throw new VaultStorageError("session_invalid");
    const sf = await lstat(join(path, "session.json")), rd = await lstat(recordsDir);
    if (!sf.isFile() || sf.isSymbolicLink() || sf.size > MAX_JSON_BYTES || !rd.isDirectory() || rd.isSymbolicLink()) throw new VaultStorageError("session_invalid");
    const base = parseSession(JSON.parse(await readFile(join(path, "session.json"), "utf8")));
    const names = (await readdir(recordsDir)).sort();
    if (names.some((n) => !["excess.json", "top-up.json", "excess.confirmed.json", "top-up.confirmed.json"].includes(n))) throw new VaultStorageError("session_invalid");
    const prepared: FundingPrepared[] = [], confirmations: { kind: FundingKind; confirmation: CanonicalConfirmation }[] = [];
    for (const kind of KINDS) {
      const recordPath = join(recordsDir, `${kind}.json`);
      if (names.includes(`${kind}.json`)) {
        const info = await lstat(recordPath); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) throw new VaultStorageError("session_invalid");
        const record = parsePrepared(JSON.parse(await readFile(recordPath, "utf8")));
        if (record.kind !== kind || (kind === "excess" ? record.from !== base.config.relayer || record.to !== base.config.vault : record.from !== base.config.vault || record.to !== base.config.relayer)) throw new VaultStorageError("record_invalid");
        prepared.push(record);
      }
      const confirmPath = join(recordsDir, `${kind}.confirmed.json`);
      if (names.includes(`${kind}.confirmed.json`)) {
        const info = await lstat(confirmPath); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) throw new VaultStorageError("session_invalid");
        const record = exactObject(JSON.parse(await readFile(confirmPath, "utf8")), ["kind", "confirmation"]);
        const confirmation = parseConfirmation(record.confirmation);
        const preparedRecord = prepared.find((r) => r.kind === kind);
        if (!preparedRecord || record.kind !== kind || confirmation.transactionHash !== preparedRecord.transactionHash) throw new VaultStorageError("record_invalid");
        confirmations.push(Object.freeze({ kind, confirmation }));
      }
    }
    if (prepared.some((r) => r.kind === "top-up") && !confirmations.some((c) => c.kind === "excess")) throw new VaultStorageError("record_invalid");
    return Object.freeze({ ...base, prepared: Object.freeze(prepared), confirmations: Object.freeze(confirmations) });
  } catch (error) {
    if (error instanceof VaultStorageError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") throw new VaultStorageError("session_unavailable");
    throw new VaultStorageError("session_invalid");
  }
}

export async function recordFundingPrepared(path: string, input: FundingPrepared): Promise<FundingPrepared> {
  const session = await readFundingSession(path), record = parsePrepared(input);
  if (record.chainId !== session.config.chainId || (record.kind === "excess" ? record.from !== session.config.relayer || record.to !== session.config.vault : record.from !== session.config.vault || record.to !== session.config.relayer)) throw new VaultStorageError("record_invalid");
  if (record.kind === "excess" && BigInt(record.valueWei) === 0n) throw new VaultStorageError("record_invalid");
  if (record.kind === "top-up" && (!session.confirmations.some((c) => c.kind === "excess") || BigInt(record.valueWei) === 0n || BigInt(record.valueWei) > BigInt(session.config.targetWei))) throw new VaultStorageError("record_invalid");
  const dest = join(path, "records", `${record.kind}.json`);
  try { await writeExclusive(dest, `${JSON.stringify(record)}\n`, "record_exists"); await syncDir(dirname(dest)); }
  catch (error) { if (error instanceof VaultStorageError) throw error; throw new VaultStorageError("record_write_failed"); }
  return record;
}

/** Record a read-only canonical successful receipt before preparing the one allowed top-up. */
export async function recordFundingConfirmed(path: string, kind: FundingKind, input: CanonicalConfirmation): Promise<CanonicalConfirmation> {
  const session = await readFundingSession(path), confirmation = parseConfirmation(input);
  const prepared = session.prepared.find((record) => record.kind === kind);
  if (!prepared || prepared.transactionHash !== confirmation.transactionHash) throw new VaultStorageError("record_invalid");
  const dest = join(path, "records", `${kind}.confirmed.json`);
  try { await writeExclusive(dest, `${JSON.stringify({ kind, confirmation })}\n`, "record_exists"); await syncDir(dirname(dest)); }
  catch (error) { if (error instanceof VaultStorageError) throw error; throw new VaultStorageError("record_write_failed"); }
  return confirmation;
}
