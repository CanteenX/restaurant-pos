import { hitIntegrationWrite } from './key-rate-limiter';

describe('hitIntegrationWrite', () => {
  afterEach(() => delete process.env.INTEGRATION_WRITE_LIMIT_PER_MIN);

  it('charges one shared per-key bucket at INTEGRATION_WRITE_LIMIT_PER_MIN', () => {
    process.env.INTEGRATION_WRITE_LIMIT_PER_MIN = '2';
    const t = 1_000_000;
    expect(hitIntegrationWrite('shared-a', t)).toBe(0);
    expect(hitIntegrationWrite('shared-a', t + 1)).toBe(0);
    expect(hitIntegrationWrite('shared-a', t + 2)).toBeGreaterThan(0);
    // another key has its own budget
    expect(hitIntegrationWrite('shared-b', t + 3)).toBe(0);
    // the window resets after a minute
    expect(hitIntegrationWrite('shared-a', t + 60_000)).toBe(0);
  });

  it('defaults to 30 writes per minute', () => {
    const t = 2_000_000;
    for (let i = 0; i < 30; i++) {
      expect(hitIntegrationWrite('shared-default', t + i)).toBe(0);
    }
    expect(hitIntegrationWrite('shared-default', t + 30)).toBeGreaterThan(0);
  });
});
