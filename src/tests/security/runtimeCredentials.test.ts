import { generateKeyPairSync } from "crypto";
import { requiredEnvironmentValue, requiredPrivateKey } from "../../utils/runtimeCredentials";
import { firebaseAppOptions, firebaseCredential } from "../../utils/firebaseCredentials";
import admin from "firebase-admin";

jest.mock("firebase-admin", () => ({
  credential: {
    applicationDefault: jest.fn(() => ({ kind: "managed-identity" })),
    cert: jest.fn(() => ({ kind: "runtime-service-account" })),
  },
}));

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; jest.clearAllMocks(); });

describe("runtime credentials", () => {
  it("starts without an Apple promotional-offer key", () => {
    delete process.env.APPSTORE_KEY;
    delete process.env.APPSTORE_KEY_ID;
    jest.isolateModules(() => {
      const config = require("../../config").default;
      expect(config.APPSTORE_KEY).toBeUndefined();
      expect(config.APPSTORE_KEY_ID).toBeUndefined();
    });
  });
  it("rejects a partial Apple promotional-offer pair", () => {
    delete process.env.APPSTORE_KEY;
    process.env.APPSTORE_KEY_ID = "fixture-key-id";
    expect(() => jest.isolateModules(() => require("../../config"))).toThrow(
      "APPSTORE_KEY and APPSTORE_KEY_ID must be configured together"
    );
  });
  it("rejects missing and blank required values", () => {
    delete process.env.READINESS_TEST_KEY;
    expect(() => requiredEnvironmentValue("READINESS_TEST_KEY")).toThrow("Missing required environment variable");
    process.env.READINESS_TEST_KEY = "  ";
    expect(() => requiredEnvironmentValue("READINESS_TEST_KEY")).toThrow("Missing required environment variable");
  });
  it("loads a generated private key with escaped or real newlines", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.READINESS_TEST_KEY = pem.replace(/\n/g, "\\n");
    expect(requiredPrivateKey("READINESS_TEST_KEY")).toBe(pem);
    process.env.READINESS_TEST_KEY = pem;
    expect(requiredPrivateKey("READINESS_TEST_KEY")).toBe(pem);
  });
  it("does not echo rejected private key input", () => {
    process.env.READINESS_TEST_KEY = "sensitive-invalid-input";
    expect(() => requiredPrivateKey("READINESS_TEST_KEY")).toThrow(/^Invalid private key in environment variable: READINESS_TEST_KEY$/);
  });
  it("uses managed/default credentials when no explicit Firebase account is set", () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    firebaseCredential();
    expect(admin.credential.applicationDefault).toHaveBeenCalledTimes(1);
    expect(admin.credential.cert).not.toHaveBeenCalled();
  });
  it("keeps notifications disabled without a target project", () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    expect(firebaseAppOptions()).toBeUndefined();
    expect(admin.credential.applicationDefault).not.toHaveBeenCalled();
  });
  it("targets the configured FCM project with managed VM credentials", () => {
    process.env.FIREBASE_PROJECT_ID = "keeper-test-fcm";
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    expect(firebaseAppOptions()).toEqual({
      credential: { kind: "managed-identity" },
      projectId: "keeper-test-fcm",
    });
    expect(admin.credential.applicationDefault).toHaveBeenCalledTimes(1);
    expect(admin.credential.cert).not.toHaveBeenCalled();
  });
  it("uses the explicitly supplied Firebase identity", () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: "service_account", project_id: "unit-test-project", client_email: "fixture@example.invalid", private_key: "fixture\\nvalue",
    });
    firebaseCredential();
    expect(admin.credential.cert).toHaveBeenCalledWith({ projectId: "unit-test-project", clientEmail: "fixture@example.invalid", privateKey: "fixture\nvalue" });
    expect(admin.credential.applicationDefault).not.toHaveBeenCalled();
  });
  it.each(["", "private-invalid-json", "null", JSON.stringify({ type: "service_account" })])("rejects invalid explicit Firebase config without fallback or echo", (value) => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = value;
    expect(() => firebaseCredential()).toThrow(/^Invalid FIREBASE_SERVICE_ACCOUNT_JSON configuration$/);
    expect(admin.credential.applicationDefault).not.toHaveBeenCalled();
  });
  it("hides certificate parser error details", () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: "service_account", project_id: "unit-test-project", client_email: "fixture@example.invalid", private_key: "invalid-input" });
    (admin.credential.cert as jest.Mock).mockImplementationOnce(() => { throw new Error("sensitive provider error"); });
    expect(() => firebaseCredential()).toThrow(/^Invalid FIREBASE_SERVICE_ACCOUNT_JSON configuration$/);
  });
});
