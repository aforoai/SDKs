#!/usr/bin/env node
// Drift check between contract/ingest-contract.json and the usage-ingestor
// source (wave 5, G314). The contract is written by hand from the ingestor's
// controllers and DTOs; this script re-reads those files and fails when the
// two disagree, so a server-side change can no longer leave every SDK testing
// against a stale contract.
//
//   node contract/verify-ingestor.mjs <path to aforo-nextgen-usage-ingestor-service>
//
// Exit 0 = in step, 1 = drift (each finding printed), 2 = bad usage / missing file.
// Uses only the source text, so it needs no JDK.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = 'src/main/java/com/aforo/billing/ingestor';

export function verify(ingestorRoot, contract) {
  const findings = [];
  const warnings = [];
  const read = (rel) => {
    const p = path.join(ingestorRoot, PKG, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const need = (rel) => {
    const text = read(rel);
    if (text === null) findings.push(`${rel}: file not found under ${PKG}`);
    return text ?? '';
  };

  // 1. Every endpoint the contract names is mapped.
  const controllers = need('controller/UsageEventController.java') + need('controller/CompoundIngestController.java');
  const mapped = new Set();
  for (const m of controllers.matchAll(/@PostMapping\(\s*(\{[^}]*\}|"[^"]*")\s*\)/g)) {
    for (const p of m[1].matchAll(/"([^"]+)"/g)) mapped.add(p[1]);
  }
  for (const endpoint of Object.keys(contract.endpoints)) {
    if (!mapped.has(endpoint)) findings.push(`endpoint ${endpoint} is in the contract but no @PostMapping maps it`);
  }

  // 2. Field limits and required fields on the event DTO.
  const dto = need('dto/IngestUsageEventRequest.java');
  const fields = parseDtoFields(dto);
  const schema = contract.schemas.ingestEvent;
  for (const [name, spec] of Object.entries(schema.properties)) {
    const f = fields.get(name);
    if (!f) {
      findings.push(`schemas.ingestEvent.${name}: no field "${name}" on IngestUsageEventRequest`);
      continue;
    }
    if (spec.maxLength !== undefined && f.sizeMax !== spec.maxLength) {
      findings.push(`schemas.ingestEvent.${name}.maxLength is ${spec.maxLength}, DTO @Size(max) is ${f.sizeMax ?? 'absent'}`);
    }
    if (spec.maxLength === undefined && f.sizeMax !== undefined) {
      findings.push(`schemas.ingestEvent.${name} has no maxLength, DTO has @Size(max = ${f.sizeMax})`);
    }
    if (spec.enum) {
      const allowed = f.allowableValues ?? [];
      if (allowed.join(',') !== spec.enum.join(',')) {
        findings.push(`schemas.ingestEvent.${name}.enum differs from @Schema allowableValues: contract [${spec.enum}] vs DTO [${allowed}]`);
      }
    }
    if (spec['x-digits']) {
      const d = f.digits;
      if (!d || d.integer !== spec['x-digits'].integer || d.fraction !== spec['x-digits'].fraction) {
        findings.push(`schemas.ingestEvent.${name}.x-digits differs from @Digits ${JSON.stringify(d)}`);
      }
    }
  }
  for (const [name, f] of fields) {
    if (f.sizeMax !== undefined && !(name in schema.properties)) {
      findings.push(`DTO field ${name} has @Size(max = ${f.sizeMax}) but is missing from schemas.ingestEvent`);
    }
  }
  const requiredInDto = [...fields].filter(([, f]) => f.required).map(([n]) => n).sort();
  const requiredInContract = [...schema.required].sort();
  if (requiredInDto.join(',') !== requiredInContract.join(',')) {
    findings.push(`required fields differ: contract [${requiredInContract}] vs DTO @NotBlank/@NotNull [${requiredInDto}]`);
  }
  const batchEndpoint = contract.endpoints['/v1/ingest/batch'];
  if (batchEndpoint && batchEndpoint.eventRequiredFields.slice().sort().join(',') !== requiredInDto.join(',')) {
    findings.push(`endpoints./v1/ingest/batch.eventRequiredFields differ from the DTO [${requiredInDto}]`);
  }

  // 3. Batch size.
  const batchDto = need('dto/IngestBatchRequest.java');
  const batchMax = /@Size\(\s*max\s*=\s*(\d+)/.exec(batchDto)?.[1];
  const policy = contract.transportPolicy;
  if (Number(batchMax) !== policy.batch.maxEvents) {
    findings.push(`transportPolicy.batch.maxEvents is ${policy.batch.maxEvents}, IngestBatchRequest @Size(max) is ${batchMax}`);
  }
  if (batchEndpoint && batchEndpoint.maxEvents !== policy.batch.maxEvents) {
    findings.push(`endpoints./v1/ingest/batch.maxEvents (${batchEndpoint.maxEvents}) != transportPolicy.batch.maxEvents (${policy.batch.maxEvents})`);
  }

  // 4. Body cap.
  const filter = read('config/RequestBodySizeLimitFilter.java');
  if (filter === null) {
    warnings.push('config/RequestBodySizeLimitFilter.java not found (usage-ingestor PR #88 not merged here?): body cap not checked');
  } else {
    const cap = /max-request-body-bytes:(\d+)/.exec(filter)?.[1];
    if (Number(cap) !== policy.batch.maxRequestBodyBytes) {
      findings.push(`transportPolicy.batch.maxRequestBodyBytes is ${policy.batch.maxRequestBodyBytes}, filter default is ${cap}`);
    }
  }
  if (policy.batch.targetRequestBodyBytes > policy.batch.maxRequestBodyBytes) {
    findings.push('transportPolicy.batch.targetRequestBodyBytes is above maxRequestBodyBytes');
  }

  // 5. Per-event retryable flag the SDKs act on.
  const response = need('dto/IngestBatchResponse.java');
  if (!/private\s+boolean\s+retryable\s*;/.test(response)) {
    findings.push('IngestBatchResponse.BatchError has no `retryable` field, but transportPolicy.retry.perEventRetryable relies on it');
  }

  // 6. Request compression: the contract must not promise gzip the server cannot read.
  const sources = controllers + (filter ?? '');
  const decodesGzip = /GZIPInputStream/.test(sources) || existsSync(path.join(ingestorRoot, PKG, 'config/GzipRequestFilter.java'));
  if (policy.compression.gzip && !decodesGzip) {
    findings.push('transportPolicy.compression.gzip is true but the ingestor has no request decompression');
  }
  if (!policy.compression.gzip && decodesGzip) {
    warnings.push('the ingestor now decodes gzip request bodies; transportPolicy.compression.gzip can be turned on');
  }

  return { findings, warnings };
}

/** Field name → {sizeMax, required, allowableValues, digits}, from the annotations above each field. */
export function parseDtoFields(source) {
  const out = new Map();
  // Only the top-level class body: stop at the first nested class.
  // Comments are dropped first: Javadoc and descriptions contain ';' and '@'.
  const top = source
    .split(/\n\s*public static class /)[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Each match's prefix is exactly the text since the previous field: that
  // field's annotations (the first one also carries the class annotations,
  // which have no field constraints).
  const re = /([\s\S]*?)\bprivate\s+[\w<>, ?]+\s+(\w+)\s*;/g;
  let m;
  while ((m = re.exec(top)) !== null) {
    const block = m[1] ?? '';
    const name = m[2];
    const size = /@Size\(\s*max\s*=\s*(\d+)/.exec(block)?.[1];
    const digits = /@Digits\(\s*integer\s*=\s*(\d+)\s*,\s*fraction\s*=\s*(\d+)/.exec(block);
    const allowable = /allowableValues\s*=\s*\{([^}]*)\}/.exec(block)?.[1];
    out.set(name, {
      sizeMax: size === undefined ? undefined : Number(size),
      required: /@NotBlank|@NotNull/.test(block),
      allowableValues: allowable ? [...allowable.matchAll(/"([^"]+)"/g)].map((x) => x[1]) : undefined,
      digits: digits ? { integer: Number(digits[1]), fraction: Number(digits[2]) } : undefined,
    });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root || !existsSync(path.join(root, PKG))) {
    console.error(`usage: node contract/verify-ingestor.mjs <usage-ingestor checkout>  (no ${PKG} under "${root ?? ''}")`);
    process.exit(2);
  }
  const contract = JSON.parse(readFileSync(path.join(HERE, 'ingest-contract.json'), 'utf8'));
  const { findings, warnings } = verify(root, contract);
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const f of findings) console.log(`DRIFT ${f}`);
  if (findings.length) {
    console.log(`\n${findings.length} difference(s) between contract/ingest-contract.json and ${root}. Update the contract FROM the ingestor code, then the SDKs.`);
    process.exit(1);
  }
  console.log('contract/ingest-contract.json matches the usage-ingestor source.');
}
