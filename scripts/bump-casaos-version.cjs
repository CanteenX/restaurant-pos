const fs = require('node:fs');

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  throw new Error('Usage: node scripts/bump-casaos-version.cjs <major.minor.patch>');
}
const path = 'casaos/docker-compose.yml';
let manifest = fs.readFileSync(path, 'utf8');
const previous = manifest.match(/^  version: "(\d+\.\d+\.\d+)"/m)?.[1];
if (!previous) throw new Error('CasaOS manifest version not found');
const escaped = previous.replaceAll('.', '\\.');
const references = new RegExp(`(image: ghcr\\.io/canteenx/nventra-pos-(?:backend|web):)${escaped}(?=\\s|$)`, 'g');
if ([...manifest.matchAll(references)].length !== 4) throw new Error('Expected four matching image references');
manifest = manifest.replace(references, `$1${version}`);
manifest = manifest.replace(`  version: "${previous}"`, `  version: "${version}"`);
manifest = manifest.replace(new RegExp(`(^\\s*)${escaped}(:)`, 'm'), `$1${version}$2`);
fs.writeFileSync(path, manifest);
