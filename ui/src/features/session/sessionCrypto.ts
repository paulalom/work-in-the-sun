import type { PinUnlock, ServerIdentity, SessionStatus } from "../../shared/types";

export interface InitialAccessToken {
  token: string;
  startupSecurityMessage: string;
}

export interface PinUnlockPayload {
  request: {
    keyFingerprint: string;
    encryptedPin: string;
  };
  responseKey: Uint8Array;
}

export interface PinGateState {
  visible: boolean;
  enabled: boolean;
  message: string;
  identity: ServerIdentity;
  pinUnlock: PinUnlock | null;
}

export function readAccessToken(): InitialAccessToken {
  const names = ["wits_token", "access_token", "token"];
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = names.map((name) => searchParams.get(name) || hashParams.get(name)).find(Boolean);

  if (!token) {
    return {
      token: sessionStorage.getItem("witsAccessToken") || "",
      startupSecurityMessage: "",
    };
  }

  names.forEach((name) => {
    searchParams.delete(name);
    hashParams.delete(name);
  });

  const nextSearch = searchParams.toString();
  const nextHash = hashParams.toString();
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
    nextHash ? `#${nextHash}` : ""
  }`;
  window.history.replaceState(null, "", nextUrl);

  if (!isSafePinTransport()) {
    return {
      token: "",
      startupSecurityMessage: "Remote unlock requires HTTPS. The URL token was ignored.",
    };
  }

  sessionStorage.setItem("witsAccessToken", token);
  return {
    token,
    startupSecurityMessage: "",
  };
}

export function isLoopbackHostname(hostname: string) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" || value.startsWith("127.");
}

export function isSafePinTransport() {
  return window.isSecureContext || isLoopbackHostname(window.location.hostname);
}

export function base64ToBytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return window.btoa(binary);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function encryptedPinUnlockPayload(pin: string, pinUnlock: PinUnlock): Promise<PinUnlockPayload> {
  if (!window.crypto?.subtle) {
    throw new Error("Encrypted password unlock is unavailable in this browser.");
  }

  const responseKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(pinUnlock.publicKey),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
  const payload = new TextEncoder().encode(
    JSON.stringify({
      pin,
      responseKey: bytesToBase64(responseKey),
      nonce: bytesToBase64(nonce),
    }),
  );
  const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, payload);

  return {
    request: {
      keyFingerprint: pinUnlock.fingerprint,
      encryptedPin: bytesToBase64(new Uint8Array(encrypted)),
    },
    responseKey,
  };
}

export async function decryptPinUnlockResponse(result: unknown, responseKey: Uint8Array) {
  const encryptedResult = result as {
    encrypted?: boolean;
    algorithm?: string;
    iv?: string;
    aad?: string;
    ciphertext?: string;
  };

  if (!encryptedResult.encrypted || encryptedResult.algorithm !== "A256GCM") {
    throw new Error("Encrypted unlock response was not returned.");
  }

  const key = await crypto.subtle.importKey("raw", bytesToArrayBuffer(responseKey), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const iv = base64ToBytes(encryptedResult.iv || "");
  const ciphertext = base64ToBytes(encryptedResult.ciphertext || "");
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytesToArrayBuffer(iv),
      additionalData: new TextEncoder().encode(encryptedResult.aad || "work-in-the-sun:pin-unlock:v1"),
    },
    key,
    bytesToArrayBuffer(ciphertext),
  );

  return JSON.parse(new TextDecoder().decode(decrypted)) as { accessToken?: string };
}

export function validatePinUnlock(pinUnlock: PinUnlock | null | undefined) {
  if (!pinUnlock?.encrypted || !pinUnlock.publicKey || !pinUnlock.fingerprint) {
    throw new Error("Encrypted password unlock is not available.");
  }

  const remembered = localStorage.getItem("witsPinKeyFingerprint");

  if (remembered && remembered !== pinUnlock.fingerprint) {
    throw new Error("Server unlock key changed. Check the desktop before entering the password.");
  }
}

export function rememberPinFingerprint(pinUnlock: PinUnlock | null | undefined) {
  if (pinUnlock?.fingerprint) {
    localStorage.setItem("witsPinKeyFingerprint", pinUnlock.fingerprint);
  }
}

export function formatPasswordUnlockError(message: string | undefined) {
  const text = String(message || "").trim();

  if (!text) {
    return "Invalid password.";
  }

  return text
    .replace(/^PIN\b/, "Password")
    .replace(/\bPIN\b/g, "password")
    .replace(/\bpin\b/g, "password");
}

export function gateFromSession(session: SessionStatus, message = ""): PinGateState {
  return {
    visible: true,
    enabled: true,
    message,
    identity: session.identity || {},
    pinUnlock: session.pinUnlock || null,
  };
}
