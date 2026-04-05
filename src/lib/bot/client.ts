import { Wallet } from "@ethersproject/wallet";
import { getStoredCreds, saveStoredCreds, clearStoredCreds } from "./store";
import type { StoredCreds } from "./types";

// ============================================================
// ENV HELPERS
// ============================================================

function getPrivateKey(): string {
  const key = process.env.POLYMARKET_PRIVATE_KEY;
  if (!key) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  return key;
}

export function getFunderAddress(): string {
  const funder = process.env.POLYMARKET_FUNDER;
  if (!funder) throw new Error("POLYMARKET_FUNDER not set");
  return funder;
}

export function getSigType(): number {
  return parseInt(process.env.POLYMARKET_SIG_TYPE ?? "1", 10);
}

export function getWalletAddress(): string {
  const wallet = new Wallet(getPrivateKey());
  return wallet.address;
}

// ============================================================
// CLOB CLIENT
// ============================================================

let _client: unknown = null;

export async function getClobClient() {
  if (_client) return _client;

  const { ClobClient, Chain } = await import("@polymarket/clob-client");

  const privateKey = getPrivateKey();
  const funder = getFunderAddress();
  const sigType = getSigType();
  const wallet = new Wallet(privateKey);

  // Try stored creds first
  let creds = await getStoredCreds();

  if (!creds) {
    creds = await deriveAndStoreCreds(wallet);
  }

  const client = new ClobClient(
    "https://clob.polymarket.com",
    Chain.POLYGON,
    wallet,
    {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
    sigType,
    funder
  );

  _client = client;
  return client;
}

// ============================================================
// DERIVE + STORE CREDENTIALS
// ============================================================

export async function deriveAndStoreCreds(
  wallet?: Wallet
): Promise<StoredCreds> {
  const { ClobClient, Chain } = await import("@polymarket/clob-client");

  const privateKey = getPrivateKey();
  const funder = getFunderAddress();
  const sigType = getSigType();
  const w = wallet ?? new Wallet(privateKey);

  // Temporary client without creds to derive them
  const tempClient = new ClobClient(
    "https://clob.polymarket.com",
    Chain.POLYGON,
    w,
    undefined,
    sigType,
    funder
  );

  const apiCreds = await tempClient.createOrDeriveApiKey();

  const creds: StoredCreds = {
    key: apiCreds.key,
    secret: apiCreds.secret,
    passphrase: apiCreds.passphrase,
    derivedAt: new Date().toISOString(),
  };

  await saveStoredCreds(creds);
  _client = null; // Reset so next call uses new creds
  return creds;
}

// ============================================================
// RE-AUTH (call when API returns 401)
// ============================================================

export async function reAuth(): Promise<void> {
  _client = null;
  await clearStoredCreds();
  await deriveAndStoreCreds();
}

// ============================================================
// BALANCE
// ============================================================

export async function getUsdcBalance(): Promise<number> {
  try {
    const client = await getClobClient() as any;
    const balance = await client.getBalance();
    return parseFloat(balance ?? "0");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("unauthorized")) {
      await reAuth();
      const client = await getClobClient() as any;
      const balance = await client.getBalance();
      return parseFloat(balance ?? "0");
    }
    throw err;
  }
}