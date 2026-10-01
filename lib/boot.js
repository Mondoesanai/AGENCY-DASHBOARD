// Process setup, imported first by every serverless entry point.
//
// Its only job is the thing that must happen before any other code runs: making
// the logging sink safe. Patching `console` is a side effect, so it lives in a
// module whose stated purpose is side effects rather than hiding inside a
// storage or utility import.
//
// This is deliberately installed at the SINK rather than by rewriting call
// sites. Rewriting every `console.log` fails the moment someone adds a new one
// while debugging — which is precisely when a whole request object, headers and
// all, gets logged.
import { installSafeConsole } from './redact.js';

installSafeConsole();

export const booted = true;
