/**
 * Emit the published JSON Schema from the same zod definitions the server validates with.
 *
 * "Usable by any app" only means something if the document is generated from the source of truth
 * rather than written alongside it.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CheckReport, SCHEMA_VERSION, ValidateResponse, ErrorResponse } from './envelope.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'snapshots', `v${SCHEMA_VERSION}.json`);

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: `imei-check wire contract v${SCHEMA_VERSION}`,
  definitions: {
    CheckReport: zodToJsonSchema(CheckReport, { name: 'CheckReport' }).definitions?.CheckReport,
    ValidateResponse: zodToJsonSchema(ValidateResponse, { name: 'ValidateResponse' }).definitions
      ?.ValidateResponse,
    ErrorResponse: zodToJsonSchema(ErrorResponse, { name: 'ErrorResponse' }).definitions
      ?.ErrorResponse,
  },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`wrote ${out}`);
