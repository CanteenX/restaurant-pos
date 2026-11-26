const upstream = process.env.CONTROL_API_ORIGIN;
if (upstream) {
  if (!URL.canParse(upstream)) throw new Error('Invalid Control API origin');
  const url = new URL(upstream);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.origin !== upstream || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error('Invalid Control API origin');
  }
}

export default {
  poweredByHeader: false,
  async rewrites() {
    return upstream ? [{ source: '/api/control/v1/:path*', destination: upstream + '/api/control/v1/:path*' }] : [];
  },
};