import { Logger } from '@nestjs/common';
import {
  UpdateService,
  ghcrBasicAuth,
  resolveImageRepo,
  resolveUpdateRepo,
} from './update.service';

type FetchArgs = [string, RequestInit | undefined];

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('update repo/image config', () => {
  it('defaults to CanteenX/restaurant-pos', () => {
    expect(resolveUpdateRepo({})).toBe('CanteenX/restaurant-pos');
  });

  it('reads UPDATE_REPO from env', () => {
    expect(resolveUpdateRepo({ UPDATE_REPO: ' acme/pos ' })).toBe('acme/pos');
  });

  it('rejects a malformed UPDATE_REPO and falls back to the default', () => {
    expect(resolveUpdateRepo({ UPDATE_REPO: '../evil?x=1' })).toBe(
      'CanteenX/restaurant-pos',
    );
    expect(resolveUpdateRepo({ UPDATE_REPO: 'a/b/c' })).toBe(
      'CanteenX/restaurant-pos',
    );
  });

  it('defaults the image repo to the rebranded GHCR name', () => {
    expect(resolveImageRepo({})).toBe('canteenx/nventra-pos-backend');
  });

  it('reads UPDATE_IMAGE_REPO, lowercased, ghcr.io prefix stripped', () => {
    expect(
      resolveImageRepo({ UPDATE_IMAGE_REPO: 'ghcr.io/Acme/Pos-Backend' }),
    ).toBe('acme/pos-backend');
    expect(resolveImageRepo({ UPDATE_IMAGE_REPO: 'bad repo!' })).toBe(
      'canteenx/nventra-pos-backend',
    );
  });

  it('builds a GHCR basic auth header from a token', () => {
    const h = ghcrBasicAuth('tok123');
    expect(h).toMatch(/^Basic /);
    expect(Buffer.from(h.slice(6), 'base64').toString()).toBe('token:tok123');
  });
});

describe('UpdateService', () => {
  const ENV = { ...process.env };
  let calls: FetchArgs[];
  let routes: (url: string, init?: RequestInit) => Response;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    calls = [];
    process.env = { ...ENV };
    delete process.env.UPDATE_REPO;
    delete process.env.UPDATE_IMAGE_REPO;
    delete process.env.GHCR_TOKEN;
    process.env.APP_VERSION = '1.0.0';
    process.env.UPDATER_URL = 'http://updater:8080';
    jest
      .spyOn(global, 'fetch')
      .mockImplementation((input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push([url, init]);
        return Promise.resolve(routes(url, init));
      });
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = ENV;
  });

  const defaultRoutes =
    (manifestStatus = 200) =>
    (url: string): Response => {
      if (url.includes('api.github.com')) {
        return jsonRes(200, [{ name: 'v1.2.0' }]);
      }
      if (url.startsWith('https://ghcr.io/token')) {
        return jsonRes(200, { token: 'registry-bearer' });
      }
      if (url.includes('/manifests/')) {
        return new Response(null, { status: manifestStatus });
      }
      return new Response(null, { status: 500 });
    };

  it('checks tags and builds the release URL from the default repo', async () => {
    routes = defaultRoutes();
    const info = await new UpdateService().checkForUpdate();
    const gh = calls.find(([u]) => u.includes('api.github.com'))!;
    expect(gh[0]).toBe(
      'https://api.github.com/repos/CanteenX/restaurant-pos/tags?per_page=1',
    );
    expect(info.latestVersion).toBe('v1.2.0');
    expect(info.updateAvailable).toBe(true);
    expect(info.releaseUrl).toBe(
      'https://github.com/CanteenX/restaurant-pos/releases/tag/v1.2.0',
    );
  });

  it('uses UPDATE_REPO from env', async () => {
    process.env.UPDATE_REPO = 'acme/pos';
    routes = defaultRoutes();
    const info = await new UpdateService().checkForUpdate();
    expect(calls[0][0]).toContain('/repos/acme/pos/tags');
    expect(info.releaseUrl).toContain('github.com/acme/pos/releases');
  });

  it('checks the rebranded image manifest anonymously without a token', async () => {
    routes = defaultRoutes();
    await new UpdateService().checkForUpdate();
    const tok = calls.find(([u]) => u.startsWith('https://ghcr.io/token'))!;
    expect(tok[0]).toContain(
      'scope=repository:canteenx/nventra-pos-backend:pull',
    );
    const hdrs = (tok[1]?.headers ?? {}) as Record<string, string>;
    expect(hdrs.Authorization).toBeUndefined();
    const man = calls.find(([u]) => u.includes('/manifests/'))!;
    expect(man[0]).toBe(
      'https://ghcr.io/v2/canteenx/nventra-pos-backend/manifests/1.2.0',
    );
    expect((man[1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer registry-bearer',
    );
  });

  it('authenticates the token request when GHCR_TOKEN is set', async () => {
    process.env.GHCR_TOKEN = 'ghp_secret_value';
    routes = defaultRoutes();
    await new UpdateService().checkForUpdate();
    const tok = calls.find(([u]) => u.startsWith('https://ghcr.io/token'))!;
    expect((tok[1]?.headers as Record<string, string>).Authorization).toBe(
      ghcrBasicAuth('ghp_secret_value'),
    );
  });

  it('reports building when the image tag is not published yet', async () => {
    routes = defaultRoutes(404);
    const info = await new UpdateService().checkForUpdate();
    expect(info.updateAvailable).toBe(false);
    expect(info.building).toBe(true);
  });

  it('never logs the GHCR token', async () => {
    process.env.GHCR_TOKEN = 'ghp_secret_value';
    routes = () => {
      throw new Error('boom ghp_secret_value');
    };
    await new UpdateService().checkForUpdate();
    expect(warn).toHaveBeenCalled();
    for (const args of warn.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('ghp_secret_value');
    }
  });
});
