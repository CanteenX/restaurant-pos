import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  // A newer release exists on GitHub but CI hasn't published its image yet.
  building: boolean;
  releaseUrl: string | null;
  checkedAt: string;
}

const DEFAULT_UPDATE_REPO = 'CanteenX/restaurant-pos';
const DEFAULT_IMAGE_REPO = 'canteenx/nventra-pos-backend';
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IMAGE_REPO_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

type Env = Record<string, string | undefined>;

/** GitHub `owner/repo` whose tags/releases this install updates from. */
export function resolveUpdateRepo(env: Env = process.env): string {
  const v = (env.UPDATE_REPO ?? '').trim();
  return GITHUB_REPO_RE.test(v) && !v.includes('..') ? v : DEFAULT_UPDATE_REPO;
}

/** GHCR repository (without `ghcr.io/`) of the backend image, for the manifest check. */
export function resolveImageRepo(env: Env = process.env): string {
  const v = (env.UPDATE_IMAGE_REPO ?? '')
    .trim()
    .toLowerCase()
    .replace(/^ghcr\.io\//, '');
  return IMAGE_REPO_RE.test(v) ? v : DEFAULT_IMAGE_REPO;
}

/** GHCR's token endpoint accepts any username with a PAT as the password. */
export function ghcrBasicAuth(token: string): string {
  return `Basic ${Buffer.from(`token:${token}`).toString('base64')}`;
}

function ghcrToken(): string {
  return (process.env.GHCR_TOKEN ?? '').trim();
}

/** Strip the GHCR token from anything that might end up in a log line. */
function redact(text: string): string {
  const token = ghcrToken();
  return token ? text.split(token).join('***') : text;
}
// Avoid hammering GitHub's unauthenticated rate limit (60 req/hr per IP,
// shared across every self-hosted install behind the same egress IP in the
// worst case) — a check this infrequent is still fast enough to surface a
// new release the same day it ships. Same TTL as Submify/Zulivio's own
// update checkers, for consistency across the three products.
const CACHE_TTL_MS = 60 * 60 * 1000;
// A release whose image is still being built flips to "available" within
// minutes — don't let that state sit in the cache for the full hour.
const BUILDING_CACHE_TTL_MS = 60 * 1000;

@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);
  private cache: VersionInfo | null = null;
  private cacheExpiresAt = 0;

  async checkForUpdate(): Promise<VersionInfo> {
    if (this.cache && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    const currentVersion = (process.env.APP_VERSION ?? '').trim() || 'dev';
    let latestVersion: string | null = null;
    try {
      latestVersion = await this.fetchLatestTag();
    } catch (err) {
      this.logger.warn(
        `update check failed: ${redact(err instanceof Error ? err.message : String(err))}`,
      );
    }

    let imagePublished = true;
    if (latestVersion && process.env.UPDATER_URL) {
      imagePublished = (await this.imageTagExists(latestVersion)) !== false;
    }

    const newer =
      latestVersion !== null &&
      (currentVersion === 'dev'
        ? !!process.env.UPDATER_URL
        : isNewer(latestVersion, currentVersion));
    const info: VersionInfo = {
      currentVersion,
      latestVersion,
      updateAvailable: newer && imagePublished,
      building: newer && !imagePublished,
      releaseUrl: latestVersion
        ? `https://github.com/${resolveUpdateRepo()}/releases/tag/${latestVersion}`
        : null,
      checkedAt: new Date().toISOString(),
    };
    this.cache = info;
    this.cacheExpiresAt =
      Date.now() +
      (info.building || latestVersion === null
        ? BUILDING_CACHE_TTL_MS
        : CACHE_TTL_MS);
    return info;
  }

  // Hands the update to the `updater` sidecar container (updater/server.js),
  // same design as the upstream nodedr-pos sister project. A container can't safely replace itself, and
  // giving this API the Docker socket would be far more privilege than a POS
  // backend should hold — the sidecar is reachable only on the internal
  // Docker network, only with UPDATER_TOKEN, and only ever swaps the image
  // tag of the two app containers it is told to manage. It answers 202 right
  // away and carries on in the background (restarting this very container).
  async applyUpdate(): Promise<{ status: string; message: string }> {
    const base = (process.env.UPDATER_URL ?? '').trim().replace(/\/$/, '');
    if (!base) {
      throw new BadRequestException(
        'This install has no updater. Update the app the way you installed it.',
      );
    }
    this.cache = null; // force a fresh look at the latest version
    const info = await this.checkForUpdate();
    if (!info.updateAvailable || !info.latestVersion) {
      throw new ConflictException('You are already on the latest version');
    }

    let res: Response;
    try {
      res = await fetch(`${base}/v1/update`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.UPDATER_TOKEN ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: info.latestVersion.replace(/^v/i, ''),
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new InternalServerErrorException(
        `could not reach the updater: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new InternalServerErrorException(
        `updater refused: ${body.error ?? res.status}`,
      );
    }

    return {
      status: 'update started',
      message:
        'The application is updating and will restart shortly. This page will reload when it is back.',
    };
  }

  // What the updater is doing right now, so the UI can surface a failure
  // (e.g. no internet to pull images) instead of waiting forever.
  async getProgress(): Promise<{
    state: string;
    step?: string | null;
    error?: string | null;
  }> {
    const base = (process.env.UPDATER_URL ?? '').trim().replace(/\/$/, '');
    if (!base) return { state: 'unavailable' };
    try {
      const res = await fetch(`${base}/v1/status`, {
        headers: { Authorization: `Bearer ${process.env.UPDATER_TOKEN ?? ''}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { state: 'unknown' };
      return (await res.json()) as {
        state: string;
        step?: string | null;
        error?: string | null;
      };
    } catch {
      return { state: 'unknown' };
    }
  }

  // CI publishes the image shortly after a tag appears; updating inside that
  // window would pull nothing. GHCR manifest check — anonymous for public
  // images, authenticated with GHCR_TOKEN for private ones. Anything other
  // than a clear 404 means "can't tell", and the tag is trusted.
  private async imageTagExists(tag: string): Promise<boolean | null> {
    try {
      const repo = resolveImageRepo();
      const version = tag.replace(/^v/i, '');
      const pat = ghcrToken();
      const tokRes = await fetch(
        `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
        {
          headers: pat ? { Authorization: ghcrBasicAuth(pat) } : {},
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!tokRes.ok) return null;
      const { token } = (await tokRes.json()) as { token: string };
      const res = await fetch(
        `https://ghcr.io/v2/${repo}/manifests/${version}`,
        {
          method: 'HEAD',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept:
              'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
          },
          signal: AbortSignal.timeout(6000),
        },
      );
      if (res.status === 404) return false;
      return res.ok ? true : null;
    } catch {
      return null;
    }
  }

  private async fetchLatestTag(): Promise<string | null> {
    const res = await fetch(
      `https://api.github.com/repos/${resolveUpdateRepo()}/tags?per_page=1`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nventra-pos-update-check',
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const tags = (await res.json()) as Array<{ name: string }>;
    return tags[0]?.name ?? null;
  }
}

function parseSemver(v: string): [number, number, number] {
  const parts = v
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewer(latest: string, current: string): boolean {
  const [la, lb, lc] = parseSemver(latest);
  const [ca, cb, cc] = parseSemver(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
