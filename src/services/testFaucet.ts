import BIP32Factory, { BIP32Interface } from "bip32";
import * as bip39 from "bip39";
import * as bitcoinJS from "bitcoinjs-lib";
import coinselect from "coinselect";
import config from "../config";
import ElectrumClient, { ElectrumClientType } from "./electrumClient";
import * as ecc from "tiny-secp256k1";
import axios from "axios";

const bip32 = BIP32Factory(ecc);
bitcoinJS.initEccLib(ecc);

const network = bitcoinJS.networks.testnet;
const deriveKeyPair = () => {
  const seed: Buffer = bip39.mnemonicToSeedSync(config.FAUCET_MNEMONIC);
  const path: string = "m/44'/1'/0'/0/0";
  const root = bip32.fromSeed(seed, network);
  return root.derivePath(path);
};
const keyPair = deriveKeyPair();

export default class TestnetFaucet {
  public static getP2SH = (
    keyPair: BIP32Interface
  ): bitcoinJS.payments.Payment =>
    bitcoinJS.payments.p2sh({
      redeem: bitcoinJS.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: network,
      }),
      network: network,
    });

  public static getAddress = (): string =>
    bitcoinJS.payments.p2sh({
      redeem: bitcoinJS.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: network,
      }),
      network: network,
    }).address;

  public static isValidAddress = (address: string): boolean => {
    try {
      bitcoinJS.address.toOutputScript(address, network);
      return true;
    } catch (err) {
      return false;
    }
  };

  public static sortOutputs = (
    outputs: Array<{
      address: string;
      value: number;
    }>
  ): Array<{
    address: string;
    value: number;
  }> => {
    for (const output of outputs) {
      if (!output.address) {
        output.address = TestnetFaucet.getAddress();
        // console.log(`adding the change address: ${output.address}`);
      }
    }

    outputs.sort((out1, out2) => {
      if (out1.address < out2.address) {
        return -1;
      }
      if (out1.address > out2.address) {
        return 1;
      }
      return 0;
    });

    return outputs;
  };

  static mockFeeRates = () => {
    // final safety net

    // high fee: 10 minutes
    const highFeeBlockEstimate = 1;
    const high = {
      feePerByte: 50,
      estimatedBlocks: highFeeBlockEstimate,
    };

    // medium fee: 30 mins
    const mediumFeeBlockEstimate = 3;
    const medium = {
      feePerByte: 30,
      estimatedBlocks: mediumFeeBlockEstimate,
    };

    // low fee: 60 mins
    const lowFeeBlockEstimate = 6;
    const low = {
      feePerByte: 10,
      estimatedBlocks: lowFeeBlockEstimate,
    };
    const feeRatesByPriority = { high, medium, low };
    return feeRatesByPriority;
  };

  static fetchTestnetFeeRatesByPriority = async () => {
    try {
      const endpoint = "https://mempool.space/testnet4/api/v1/fees/recommended";
      const res = await axios.get(endpoint);
      const mempoolFee: {
        economyFee: number;
        fastestFee: number;
        halfHourFee: number;
        hourFee: number;
        minimumFee: number;
      } = res.data;

      // high fee: 10 minutes
      const highFeeBlockEstimate = 1;
      const high = {
        feePerByte: mempoolFee.fastestFee,
        estimatedBlocks: highFeeBlockEstimate,
      };

      // medium fee: 30 minutes
      const mediumFeeBlockEstimate = 3;
      const medium = {
        feePerByte: mempoolFee.halfHourFee,
        estimatedBlocks: mediumFeeBlockEstimate,
      };

      // low fee: 60 minutes
      const lowFeeBlockEstimate = 6;
      const low = {
        feePerByte: mempoolFee.hourFee,
        estimatedBlocks: lowFeeBlockEstimate,
      };

      const feeRatesByPriority = { high, medium, low };
      return feeRatesByPriority;
    } catch (err) {
      console.log("Failed to fetch fee via mempool.space", {
        err: err?.response?.data,
      });
      return TestnetFaucet.mockFeeRates();
    }
  };

  public static createTransaction = async (
    client,
    recipientAddress: string,
    amount: number,
    txnPriority?: string,
    nSequence?: number
  ): Promise<
    | {
        fee: number;
        balance: number;
        inputs?: undefined;
        PSBT?: undefined;
      }
    | {
        inputs: Array<{
          txId: string;
          vout: number;
          value: number;
          address: string;
        }>;
        PSBT: bitcoinJS.Psbt;
        fee: number;
        balance: number;
      }
  > => {
    try {
      const faucetAddress = TestnetFaucet.getAddress();
      const utxosByAddress = await ElectrumClient.syncUTXOByAddress(
        client,
        [faucetAddress],
        network
      );

      let balance: number = 0;
      const UTXOs = [];
      for (const address in utxosByAddress) {
        const utxos = utxosByAddress[address];
        for (const utxo of utxos) {
          balance += utxo.value;
          UTXOs.push(utxo);
        }
      }

      const { high } = await TestnetFaucet.fetchTestnetFeeRatesByPriority();
      const feePerByte = high.feePerByte;

      const outputUTXOs = [{ address: recipientAddress, value: amount }];
      const { inputs, outputs, fee } = coinselect(
        UTXOs,
        outputUTXOs,
        feePerByte
      );

      if (!inputs) {
        // insufficient input utxos to compensate for output utxos + fee
        return { fee, balance };
      }

      const PSBT: bitcoinJS.Psbt = new bitcoinJS.Psbt({
        network: network,
      });

      const p2wpkh = bitcoinJS.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: network,
      });
      const p2sh = bitcoinJS.payments.p2sh({
        redeem: p2wpkh,
      });

      inputs.forEach((input) =>
        PSBT.addInput({
          hash: input.txId,
          index: input.vout,
          sequence: nSequence,
          witnessUtxo: {
            script: p2sh.output,
            value: input.value,
          },
          redeemScript: p2wpkh.output,
        })
      );

      const sortedOuts = TestnetFaucet.sortOutputs(outputs);
      sortedOuts.forEach((output) => {
        // console.log("Adding Output:", output);
        PSBT.addOutput({
          address: output.address,
          value: output.value,
        });
      });

      return {
        inputs,
        PSBT,
        fee,
        balance,
      };
    } catch (err) {
      throw new Error(`Transaction creation failed: ${err.message}`);
    }
  };

  public static signTransaction = (
    inputs: any,
    PSBT: bitcoinJS.Psbt
  ): bitcoinJS.Psbt => {
    let vin = 0;
    inputs.forEach((input) => {
      PSBT.signInput(vin, keyPair);
      vin += 1;
    });

    return PSBT;
  };

  public static transfer = async (recipientAddress: string, amount = 10000) => {
    if (TestnetFaucet.isValidAddress(recipientAddress)) {
      // const amount = 50000; // 50K sats
      // connect electrum client
      const client = await ElectrumClient.connect(ElectrumClientType.TESTNET);
      if (!client) throw new Error("Failed to connect to Electrum Server");

      const { inputs, PSBT, fee, balance } =
        await TestnetFaucet.createTransaction(client, recipientAddress, amount);

      if (balance + fee < amount) {
        throw new Error(
          "Insufficient balance to compensate for transfer amount and the txn fee"
        );
      }
      const signedPSBT = TestnetFaucet.signTransaction(inputs, PSBT);
      const txHex = signedPSBT.finalizeAllInputs().extractTransaction().toHex();
      const txid = await ElectrumClient.broadcast(client, txHex);
      ElectrumClient.disconnect(client); // disconnect electrum client
      return { txid };
    } else {
      throw new Error(
        "Testenet faucet transfer failed: invalid recipient address"
      );
    }
  };
}
