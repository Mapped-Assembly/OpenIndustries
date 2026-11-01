#!/usr/bin/env node
// Preserve discovery for existing clients; new integrations use openindustries-mcp.mjs.
import { startMcpServer } from './openindustries-mcp.mjs';
startMcpServer({ legacyToolNames: true });
