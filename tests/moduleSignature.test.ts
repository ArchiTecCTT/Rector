import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ModuleRegistry,
  verifyModuleSignature,
  getModulePublicKey,
} from "../src/modules/registry.js";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import type { ModuleManifest } from "../src/modules/manifest.js";

/** Helper: generate an Ed25519 key pair for testing. */
function generateEd25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

/** Helper: sign a module manifest payload with an Ed25519 private key. */
function signManifest(
  manifest: Pick<ModuleManifest, "id" | "version" | "apiVersion">,
  privateKey: ReturnType<typeof generateEd25519KeyPair>["privateKey"],
): string {
  const payload = JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
  });
  const sig = sign(null, Buffer.from(payload), privateKey);
  return sig.toString("base64");
}

/** Build a minimal valid module manifest. */
function makeManifest(
  overrides: Partial<ModuleManifest> & { id: string } = { id: "test-mod" },
): ModuleManifest {
  return {
    id: overrides.id ?? "test-mod",
    name: overrides.name ?? "Test Module",
    version: overrides.version ?? "1.0.0",
    apiVersion: overrides.apiVersion ?? "rector.modules.v1alpha1",
    hooks: overrides.hooks ?? [],
    ...overrides,
  } as ModuleManifest;
}

describe("verifyModuleSignature", () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const publicKeyDER = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  it("returns true for a valid Ed25519 signature", () => {
    const manifest = makeManifest();
    const signature = signManifest(manifest, privateKey);
    const result = verifyModuleSignature(
      { ...manifest, signature } as ModuleManifest & { signature: string },
      publicKeyDER,
    );
    expect(result).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const manifest = makeManifest();
    const result = verifyModuleSignature(
      { ...manifest, signature: "invalidsig==" } as ModuleManifest & { signature: string },
      publicKeyDER,
    );
    expect(result).toBe(false);
  });

  it("returns false when the payload is tampered (different id)", () => {
    const manifest = makeManifest();
    const signature = signManifest(manifest, privateKey);
    const tampered = { ...manifest, id: "tampered-mod", signature } as ModuleManifest & {
      signature: string;
    };
    expect(verifyModuleSignature(tampered, publicKeyDER)).toBe(false);
  });

  it("returns false when the payload is tampered (different version)", () => {
    const manifest = makeManifest();
    const signature = signManifest(manifest, privateKey);
    const tampered = {
      ...manifest,
      version: "9.9.9",
      signature,
    } as ModuleManifest & { signature: string };
    expect(verifyModuleSignature(tampered, publicKeyDER)).toBe(false);
  });

  it("returns false when using the wrong public key", () => {
    const otherKey = generateEd25519KeyPair();
    const manifest = makeManifest();
    const signature = signManifest(manifest, privateKey);
    const otherPubDER = otherKey.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    expect(
      verifyModuleSignature(
        { ...manifest, signature } as ModuleManifest & { signature: string },
        otherPubDER,
      ),
    ).toBe(false);
  });

  it("returns false for a malformed public key", () => {
    const manifest = makeManifest();
    const signature = signManifest(manifest, privateKey);
    expect(
      verifyModuleSignature(
        { ...manifest, signature } as ModuleManifest & { signature: string },
        Buffer.from("not-a-key"),
      ),
    ).toBe(false);
  });
});

describe("getModulePublicKey", () => {
  const origEnv = process.env.RECTOR_MODULE_PUBLIC_KEY;

  beforeEach(() => {
    delete process.env.RECTOR_MODULE_PUBLIC_KEY;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.RECTOR_MODULE_PUBLIC_KEY = origEnv;
    } else {
      delete process.env.RECTOR_MODULE_PUBLIC_KEY;
    }
  });

  it("returns undefined when RECTOR_MODULE_PUBLIC_KEY is not set", () => {
    expect(getModulePublicKey()).toBeUndefined();
  });

  it("returns a Buffer when RECTOR_MODULE_PUBLIC_KEY is set", () => {
    process.env.RECTOR_MODULE_PUBLIC_KEY = Buffer.from("test-key").toString("base64");
    const key = getModulePublicKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.toString()).toBe("test-key");
  });

  it("returns undefined for empty string env var", () => {
    process.env.RECTOR_MODULE_PUBLIC_KEY = "";
    const key = getModulePublicKey();
    expect(key).toBeUndefined();
  });
});

describe("ModuleRegistry — signature verification", () => {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  const publicKeyDER = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const publicKeyB64 = publicKeyDER.toString("base64");

  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.RECTOR_MODULE_PUBLIC_KEY;
    process.env.RECTOR_MODULE_PUBLIC_KEY = publicKeyB64;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.RECTOR_MODULE_PUBLIC_KEY = origEnv;
    } else {
      delete process.env.RECTOR_MODULE_PUBLIC_KEY;
    }
  });

  it("registers a signed module with a valid signature", () => {
    const registry = new ModuleRegistry();
    const manifest = makeManifest({ id: "signed-mod" });
    const signature = signManifest(manifest, privateKey);
    registry.register({
      manifest: { ...manifest, signature },
      handlers: {},
    });
    expect(registry.isEnabled("signed-mod")).toBe(true);
    expect(registry.isSignatureVerified("signed-mod")).toBe(true);
  });

  it("rejects a signed module with an invalid signature", () => {
    const registry = new ModuleRegistry();
    const manifest = makeManifest({ id: "bad-sig-mod" });
    expect(() =>
      registry.register({
        manifest: { ...manifest, signature: "invalidsig==" },
        handlers: {},
      }),
    ).toThrow("signature verification failed");
  });

  it("throws when a signed module is registered without RECTOR_MODULE_PUBLIC_KEY", () => {
    delete process.env.RECTOR_MODULE_PUBLIC_KEY;
    const registry = new ModuleRegistry();
    const manifest = makeManifest({ id: "no-key-mod" });
    expect(() =>
      registry.register({
        manifest: { ...manifest, signature: "anysig==" },
        handlers: {},
      }),
    ).toThrow("RECTOR_MODULE_PUBLIC_KEY is not set");
  });

  it("allows unsigned modules with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new ModuleRegistry();
    const manifest = makeManifest({ id: "unsigned-mod" });
    registry.register({ manifest, handlers: {} });
    expect(registry.isEnabled("unsigned-mod")).toBe(true);
    expect(registry.isSignatureVerified("unsigned-mod")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsigned-mod"),
    );
    warnSpy.mockRestore();
  });

  it("strips onBoot hook from unsigned modules", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new ModuleRegistry();
    const manifest = makeManifest({ id: "unsigned-boot", hooks: ["onBoot", "enrichContext"] });
    registry.register({ manifest, handlers: {} });
    // The hook should have been stripped during register
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("onBoot hook removed"),
    );
    warnSpy.mockRestore();
  });

  it("allows signed modules to keep onBoot hooks", () => {
    const registry = new ModuleRegistry();
    const manifest = makeManifest({ id: "signed-boot", hooks: ["onBoot"] });
    const signature = signManifest(manifest, privateKey);
    registry.register({
      manifest: { ...manifest, signature },
      handlers: {},
    });
    expect(registry.isSignatureVerified("signed-boot")).toBe(true);
  });

  it("unsigned module onBoot hook is not invoked", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = new ModuleRegistry();
    const called: string[] = [];
    const manifest = makeManifest({ id: "unsigned-invoke", hooks: ["onBoot"] });
    registry.register({
      manifest,
      handlers: {
        onBoot: () => {
          called.push("onBoot");
        },
      },
    });
    await registry.invokeOnBoot({ mode: "local" } as any);
    // onBoot should NOT have been called because unsigned module had onBoot stripped
    expect(called).toEqual([]);
    warnSpy.mockRestore();
  });

  it("signed module onBoot hook IS invoked", async () => {
    const registry = new ModuleRegistry();
    const called: string[] = [];
    const manifest = makeManifest({ id: "signed-invoke", hooks: ["onBoot"] });
    const signature = signManifest(manifest, privateKey);
    registry.register({
      manifest: { ...manifest, signature },
      handlers: {
        onBoot: () => {
          called.push("onBoot");
        },
      },
    });
    // Enable the module first
    registry.enable("signed-invoke");
    await registry.invokeOnBoot({ mode: "local" } as any);
    expect(called).toEqual(["onBoot"]);
  });
});
