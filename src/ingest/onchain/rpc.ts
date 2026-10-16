import { HttpClient } from '../../core/http.js';

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(`RPC ${code}: ${message}`);
  }
}

/** Shapes of the jsonParsed getTransaction fields we rely on. */
export interface ParsedTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}
export interface ParsedTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: ParsedTokenBalance[];
    postTokenBalances?: ParsedTokenBalance[];
  } | null;
  transaction: {
    message: { accountKeys: { pubkey: string; signer: boolean; writable: boolean }[] };
    signatures: string[];
  };
}

/**
 * Thin JSON-RPC client. Uses two buckets: standard RPC and DAS (Helius limits DAS
 * separately — 2 rps on Free).
 */
export class SolanaRpc {
  private id = 1;
  constructor(
    private url: string,
    private http: HttpClient,
    private dasHttp: HttpClient = http,
  ) {}

  async call<T>(method: string, params: unknown, das = false): Promise<T> {
    const client = das ? this.dasHttp : this.http;
    const res = await client.json<{ result?: T; error?: { code: number; message: string } }>(this.url, {
      method: 'POST',
      body: { jsonrpc: '2.0', id: this.id++, method, params },
      label: `rpc:${method}`,
    });
    if (res.error) throw new RpcError(res.error.code, res.error.message);
    return res.result as T;
  }

  getTransaction(signature: string): Promise<ParsedTx | null> {
    return this.call('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
  }

  async getAccountData(address: string): Promise<Buffer | null> {
    const r = await this.call<{ value: { data: [string, string] } | null }>('getAccountInfo', [
      address,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    return r.value ? Buffer.from(r.value.data[0], 'base64') : null;
  }

  async getTokenSupply(mint: string): Promise<{ amount: bigint; decimals: number }> {
    const r = await this.call<{ value: { amount: string; decimals: number } }>('getTokenSupply', [mint]);
    return { amount: BigInt(r.value.amount), decimals: r.value.decimals };
  }

  async getTokenLargestAccounts(mint: string): Promise<{ address: string; amount: bigint }[]> {
    const r = await this.call<{ value: { address: string; amount: string }[] }>('getTokenLargestAccounts', [
      mint,
      { commitment: 'confirmed' },
    ]);
    return r.value.map((v) => ({ address: v.address, amount: BigInt(v.amount) }));
  }

  /** Owners of SPL token accounts (jsonParsed). */
  async getTokenAccountOwners(addresses: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!addresses.length) return out;
    const r = await this.call<{ value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[] }>(
      'getMultipleAccounts',
      [addresses, { encoding: 'jsonParsed' }],
    );
    r.value.forEach((acc, i) => {
      const owner = acc?.data?.parsed?.info?.owner;
      if (owner) out.set(addresses[i]!, owner);
    });
    return out;
  }

  /** Helius DAS `getTokenAccounts` page (holder counting). */
  dasTokenAccounts(mint: string, page: number, limit = 1000) {
    return this.call<{ total: number; token_accounts: { owner: string; amount: number }[] }>(
      'getTokenAccounts',
      { mint, page, limit, options: { showZeroBalance: false } },
      true,
    );
  }
}
