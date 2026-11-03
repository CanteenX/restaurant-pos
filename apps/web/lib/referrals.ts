export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isPlausibleReferralCode(code: string): boolean {
  return /^[A-Z0-9]{6,12}$/.test(normalizeReferralCode(code));
}

export function referralStatusLabel(status: string): string {
  if (status === "PENDING") return "Waiting for first order";
  if (status === "REWARDED") return "Rewarded";
  return status;
}
