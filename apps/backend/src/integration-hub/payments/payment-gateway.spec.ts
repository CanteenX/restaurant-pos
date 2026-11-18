import {
  GATEWAY_QR_CLOSE_GRACE_MS,
  GATEWAY_QR_LIFETIME_MS,
  gatewayQrOpenSince,
  gatewayQrPastClose,
} from './payment-gateway';

describe('gateway QR close time', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  const bound = GATEWAY_QR_LIFETIME_MS + GATEWAY_QR_CLOSE_GRACE_MS;

  it('keeps a QR inside its lifetime plus grace payable', () => {
    const created = new Date(now.getTime() - bound + 1_000);
    expect(gatewayQrPastClose(created, now)).toBe(false);
  });

  it('treats a QR past its close time plus grace as closed', () => {
    const created = new Date(now.getTime() - bound - 1);
    expect(gatewayQrPastClose(created, now)).toBe(true);
  });

  it('gives the earliest createdAt that can still be payable', () => {
    expect(gatewayQrOpenSince(now).getTime()).toBe(now.getTime() - bound);
  });

  it('allows a grace beyond the 15 minute QR lifetime', () => {
    expect(GATEWAY_QR_LIFETIME_MS).toBe(15 * 60_000);
    expect(GATEWAY_QR_CLOSE_GRACE_MS).toBeGreaterThan(0);
  });
});
