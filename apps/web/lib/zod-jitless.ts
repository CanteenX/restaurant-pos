import { z } from "zod";

// Loaded from instrumentation-client.ts so it runs before any schema exists.
// Zod 4 probes `new Function("")` to decide whether it may JIT-compile object
// parsers. Under our Content-Security-Policy (no 'unsafe-eval') that probe is
// caught but still raises a CSP violation report. Turning JIT off up front
// skips the probe; the interpreted path is plenty fast for form validation.
z.config({ jitless: true });
