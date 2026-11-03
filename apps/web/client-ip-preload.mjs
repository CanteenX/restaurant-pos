// `node --import ./apps/web/client-ip-preload.mjs apps/web/server.js`
// (see Dockerfile). Fails fast on a bad WEB_TRUST_PROXY.
import http from "node:http";
import { installClientIpHook, parseHops } from "./lib/client-ip.mjs";

installClientIpHook(http.Server, parseHops(process.env.WEB_TRUST_PROXY));
