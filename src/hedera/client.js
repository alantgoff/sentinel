import { Client, PrivateKey, AccountId } from '@hashgraph/sdk';

/**
 * Build a Hedera SDK Client for the given network and operator credentials.
 * Sentinel only ever calls this with testnet — the config layer rejects mainnet.
 *
 * @param {object} params
 * @param {'testnet'|'previewnet'|'mainnet'} params.network
 * @param {string} params.accountId   e.g. "0.0.1234"
 * @param {string} params.privateKey  ECDSA hex
 * @returns {Client}
 */
export function buildClient({ network, accountId, privateKey }) {
  let client;
  switch (network) {
    case 'testnet':
      client = Client.forTestnet();
      break;
    case 'previewnet':
      client = Client.forPreviewnet();
      break;
    case 'mainnet':
      throw new Error('Sentinel refuses to construct a mainnet client.');
    default:
      throw new Error(`Unknown network: ${network}`);
  }
  client.setOperator(AccountId.fromString(accountId), PrivateKey.fromStringECDSA(privateKey));
  return client;
}

/**
 * Returns the canonical mirror node REST base URL for a given network.
 *
 * @param {'testnet'|'previewnet'|'mainnet'} network
 * @returns {string}
 */
export function mirrorBaseFor(network) {
  switch (network) {
    case 'testnet':
      return 'https://testnet.mirrornode.hedera.com';
    case 'previewnet':
      return 'https://previewnet.mirrornode.hedera.com';
    case 'mainnet':
      return 'https://mainnet-public.mirrornode.hedera.com';
    default:
      throw new Error(`Unknown network: ${network}`);
  }
}
