/**
 * A bcrypt hash of a random throwaway string (never stored on any account).
 * Credential checks compare against it when the account is missing, inactive
 * or has no PIN, so a failed login costs the same bcrypt work either way and
 * response time does not reveal which login IDs exist. Its cost (12) must
 * match the cost used for real password and PIN hashes.
 */
export const DUMMY_PASSWORD_HASH =
  '$2b$12$mJHSnZRbDJwOTA5txXO1Fu5PDUZcd1bcNLoRKDSomMGx67MXWN5Du';
