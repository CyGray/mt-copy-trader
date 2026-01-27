import { RestClientV5 } from 'bybit-api';
import { BybitCredentials } from './bybitSecrets';

let cachedKey = '';
let cachedSecret = '';
let cachedTestnet = false;
let cachedClient: RestClientV5 | null = null;

export function getBybitClient(creds: BybitCredentials): RestClientV5 {
  if (
    cachedClient &&
    cachedKey === creds.apiKey &&
    cachedSecret === creds.apiSecret &&
    cachedTestnet === creds.testnet
  ) {
    return cachedClient;
  }

  cachedKey = creds.apiKey;
  cachedSecret = creds.apiSecret;
  cachedTestnet = creds.testnet;
  cachedClient = new RestClientV5({
    key: creds.apiKey,
    secret: creds.apiSecret,
    testnet: creds.testnet,
  });

  return cachedClient;
}
