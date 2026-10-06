import { pbkdf2Sync as nativePbkdf2 } from "crypto";

const { pbkdf2, pbkdf2Sync } = require("pbkdf2");
const browserPbkdf2 = require("pbkdf2/lib/sync-browser");

// Synthetic algorithm inputs only: no wallet, mnemonic, or stored key material.
for (const digest of ["sha256", "sha512"]) {
  for (const length of [32, 128, 1024]) {
    it(`preserves ${digest} results for a ${length}-byte input after the security patch`, async () => {
      const password = Buffer.alloc(length, 0x61);
      const salt = Buffer.from("public-pbkdf2-compatibility-fixture");
      const expected = nativePbkdf2(password, salt, 2048, 64, digest);
      expect(pbkdf2Sync(password, salt, 2048, 64, digest)).toEqual(expected);
      expect(browserPbkdf2(password, salt, 2048, 64, digest)).toEqual(expected);
      const asynchronous = await new Promise<Buffer>((resolve, reject) => {
        pbkdf2(password, salt, 2048, 64, digest, (error: Error, result: Buffer) => {
          if (error) reject(error);
          else resolve(result);
        });
      });
      expect(asynchronous).toEqual(expected);
    });
  }
}
