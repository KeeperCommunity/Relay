import config from "../config";
import ElectrumCli from "electrum-client";
import reverse from "buffer-reverse";
import * as bitcoinJS from "bitcoinjs-lib";
import { ElectrumUTXO } from "../interface";
import * as ecc from "tiny-secp256k1";
bitcoinJS.initEccLib(ecc);

export enum ElectrumClientType {
  TESTNET = "TESTNET",
  MAINNET = "MAINNET",
}

function shufflePeers(peers) {
  for (let i = peers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [peers[i], peers[j]] = [peers[j], peers[i]];
  }
  return peers;
}

const ELECTRUM_CLIENT_CONFIG = {
  predefinedTestnetPeers: shufflePeers([
    { host: "mempool.space", ssl: "40002" },
    { host: "blackie.c3-soft.com", ssl: "57010" },
  ]),
  predefinedPeers: shufflePeers([
    { host: "electrum.acinq.co", ssl: "50002" },
    { host: "electrum.bitaroo.net", ssl: "50002" },
    { host: "electrumx-core.1209k.com", ssl: "50002" },
    { host: "electrum.hodlister.co", ssl: "50002" },
  ]),
};

export default class ElectrumClient {
  public static async connect(type: ElectrumClientType, peerIndex: number = 0) {
    let activePeer = null;
    let client = null;
    try {
      if (type === ElectrumClientType.TESTNET)
        activePeer = ELECTRUM_CLIENT_CONFIG.predefinedTestnetPeers[peerIndex];
      else activePeer = ELECTRUM_CLIENT_CONFIG.predefinedPeers[peerIndex];

      if (!activePeer) {
        console.log("No active peer is available");
        return;
      }

      client = new ElectrumCli(
        activePeer?.ssl,
        activePeer?.host,
        activePeer?.ssl ? "tls" : "tcp"
      ); // tcp or tls

      client.onError = (error) => {
        console.log("Electrum mainClient.onError():", error?.message);
        if (client.close) client.close();
        console.log("Error: close the connection");
      };

      await client.connect();
      const ver = await client.server_version("bitcoin-keeper-relay", "1.4");
      if (ver && ver[0]) {
        console.log("connected to:", activePeer);
        return client;
      }
    } catch (error) {
      console.log("Bad connection:", activePeer);
    }

    return ElectrumClient.connect(type, peerIndex + 1);
  }

  public static disconnect(client) {
    if (client.close) client.close();
    return client;
  }

  public static splitIntoChunks(arr, chunkSize) {
    const groups = [];
    for (let itr = 0; itr < arr.length; itr += chunkSize)
      groups.push(arr.slice(itr, itr + chunkSize));
    return groups;
  }

  public static async syncUTXOByAddress(
    client,
    addresses: string[],
    network: bitcoinJS.Network = config.NETWORK,
    batchsize: number = 150
  ): Promise<{ [address: string]: ElectrumUTXO[] }> {
    if (!client) throw new Error("Electrum client is not connected");
    const res = {};

    const chunks = ElectrumClient.splitIntoChunks(addresses, batchsize);
    for (let itr = 0; itr < chunks.length; itr += 1) {
      const chunk = chunks[itr];
      const scripthashes = [];
      const scripthash2addr = {};

      for (let index = 0; index < chunk.length; index += 1) {
        const addr = chunk[index];
        const script = bitcoinJS.address.toOutputScript(addr, network);
        const hash = bitcoinJS.crypto.sha256(script);
        const reversedHash = Buffer.from(reverse(hash));
        const reversedHashHex = reversedHash.toString("hex");
        scripthashes.push(reversedHashHex);
        scripthash2addr[reversedHashHex] = addr;
      }

      // eslint-disable-next-line no-await-in-loop
      const results = await client.blockchainScripthash_listunspentBatch(
        scripthashes
      );

      for (let index = 0; index < results.length; index += 1) {
        const utxos = results[index];
        const address = scripthash2addr[utxos.param];
        res[address] = utxos.result;

        for (let utIdx = 0; utIdx < res[address].length; utIdx += 1) {
          const utxo = res[address][utIdx];
          utxo.address = address;
          utxo.txId = utxo.tx_hash;
          utxo.vout = utxo.tx_pos;
          delete utxo.tx_pos;
          delete utxo.tx_hash;
        }
      }
    }

    return res;
  }

  public static async broadcast(client, txHex: string) {
    if (!client) throw new Error("Electrum client is not connected");
    return client.blockchainTransaction_broadcast(txHex);
  }
}
