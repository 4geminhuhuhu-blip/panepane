const ITERATIONS = 600000;
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function deriveHash(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    key,
    HASH_LENGTH * 8
  );

  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 1024) {
    throw new Error("Password must be between 8 and 1024 characters");
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await deriveHash(password, salt);

  return {
    password_hash: toBase64(hash),
    password_salt: toBase64(salt),
  };
}

export async function verifyPassword(password, storedHash, storedSalt) {
  if (
    typeof password !== "string" ||
    typeof storedHash !== "string" ||
    typeof storedSalt !== "string"
  ) {
    return false;
  }

  try {
    const salt = fromBase64(storedSalt);
    const expectedHash = fromBase64(storedHash);

    if (salt.length !== SALT_LENGTH || expectedHash.length !== HASH_LENGTH) {
      return false;
    }

    const actualHash = await deriveHash(password, salt);

    let difference = 0;
    for (let i = 0; i < HASH_LENGTH; i++) {
      difference |= actualHash[i] ^ expectedHash[i];
    }

    return difference === 0;
  } catch {
    return false;
  }
}
