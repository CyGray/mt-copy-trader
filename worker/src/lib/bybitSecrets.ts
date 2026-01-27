import { decryptText, encryptText } from './crypto';
import { initFirestore } from './firestoreAdmin';
import { logger } from './logger';
import { writeSystemLog } from './systemLog';

export type BybitCredentials = {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
};

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase() === 'true' || value === '1';
}

function getEnvCredentials(): BybitCredentials | null {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    apiKey,
    apiSecret,
    testnet: parseBool(process.env.BYBIT_TESTNET),
  };
}

async function storeCredentialsIfMissing(creds: BybitCredentials): Promise<void> {
  const firestore = initFirestore();
  if (!firestore) return;

  const settingsRef = firestore.collection('settings').doc('default');
  const snap = await settingsRef.get();
  const data = snap.data() as
    | { trading?: { bybit?: { apiKeyEnc?: string; apiSecretEnc?: string } } }
    | undefined;

  const existing = data?.trading?.bybit;
  if (existing?.apiKeyEnc && existing?.apiSecretEnc) return;

  try {
    const apiKeyEnc = encryptText(creds.apiKey);
    const apiSecretEnc = encryptText(creds.apiSecret);

    await settingsRef.set(
      {
        trading: {
          bybit: {
            apiKeyEnc,
            apiSecretEnc,
            testnet: creds.testnet,
            updated_at: new Date().toISOString(),
          },
        },
      },
      { merge: true },
    );

    await writeSystemLog('info', 'bybit', 'credentials_stored', {
      testnet: creds.testnet,
    });
  } catch (error) {
    logger.error('bybit_credentials_store_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getBybitCredentials(): Promise<BybitCredentials> {
  const firestore = initFirestore();

  if (firestore) {
    try {
      const snap = await firestore.collection('settings').doc('default').get();
      const data = snap.data() as
        | {
            trading?: {
              bybit?: {
                apiKeyEnc?: string;
                apiSecretEnc?: string;
                testnet?: boolean;
              };
            };
          }
        | undefined;

      const stored = data?.trading?.bybit;
      if (stored?.apiKeyEnc && stored?.apiSecretEnc) {
        return {
          apiKey: decryptText(stored.apiKeyEnc),
          apiSecret: decryptText(stored.apiSecretEnc),
          testnet: stored.testnet ?? false,
        };
      }
    } catch (error) {
      logger.warn('bybit_credentials_fetch_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const envCreds = getEnvCredentials();
  if (envCreds) {
    await storeCredentialsIfMissing(envCreds);
    return envCreds;
  }

  throw new Error('BYBIT credentials not configured.');
}
