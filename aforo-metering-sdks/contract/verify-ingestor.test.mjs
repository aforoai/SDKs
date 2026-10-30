// Tests for verify-ingestor.mjs (G314). They build a small fake ingestor tree
// from the contract itself, prove it passes, then change one thing at a time
// and prove each change is reported as drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, parseDtoFields } from './verify-ingestor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(path.join(HERE, 'ingest-contract.json'), 'utf8'));
const PKG = 'src/main/java/com/aforo/billing/ingestor';

function javaType(spec) {
  if (spec.type === 'string') return 'String';
  if (spec.type === 'integer') return 'Integer';
  if (spec.type === 'boolean') return 'Boolean';
  if (spec.type === 'object') return 'Map<String, Object>';
  return 'BigDecimal';
}

function dtoFrom(c, mutate = (n, lines) => lines) {
  const s = c.schemas.ingestEvent;
  const parts = ['@JsonIgnoreProperties(ignoreUnknown = true)', 'public class IngestUsageEventRequest {'];
  for (const [name, spec] of Object.entries(s.properties)) {
    let lines = ['    /** Javadoc with a ; and an @Size(max = 1) inside a comment. */'];
    if (s.required.includes(name)) lines.push(spec.type === 'string' ? '    @NotBlank' : '    @NotNull');
    if (spec.maxLength !== undefined) lines.push(`    @Size(max = ${spec.maxLength})`);
    if (spec['x-digits']) lines.push(`    @Digits(integer = ${spec['x-digits'].integer}, fraction = ${spec['x-digits'].fraction})`);
    const allowable = spec.enum ? `, allowableValues = {${spec.enum.map((v) => `"${v}"`).join(', ')}}` : '';
    lines.push(`    @Schema(description = "text; with a semicolon"${allowable})`);
    lines.push(`    private ${javaType(spec)} ${name};`);
    lines = mutate(name, lines);
    parts.push(lines.join('\n'));
  }
  parts.push('    public static class TraceContext {', '        @Size(max = 999)', '        private String traceparent;', '    }', '}');
  return parts.join('\n\n');
}

function tree(c, { dto, batchMax = c.transportPolicy.batch.maxEvents, cap = c.transportPolicy.batch.maxRequestBodyBytes, retryable = true, extraMapping = '', gzip = c.transportPolicy.compression.gzip } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ingestor-'));
  const base = path.join(root, PKG);
  for (const d of ['controller', 'dto', 'config']) mkdirSync(path.join(base, d), { recursive: true });
  const single = Object.keys(c.endpoints).filter((e) => !e.startsWith('/api/v1/ingest/compound'));
  const compound = Object.keys(c.endpoints).filter((e) => e.startsWith('/api/v1/ingest/compound'));
  writeFileSync(path.join(base, 'controller/UsageEventController.java'), single.map((e) => `    @PostMapping({"${e}", "/api${e}"})`).join('\n') + extraMapping);
  writeFileSync(path.join(base, 'controller/CompoundIngestController.java'), compound.map((e) => `    @PostMapping("${e}")`).join('\n'));
  writeFileSync(path.join(base, 'dto/IngestUsageEventRequest.java'), dto ?? dtoFrom(c));
  writeFileSync(path.join(base, 'dto/IngestBatchRequest.java'), `    @NotEmpty\n    @Size(max = ${batchMax}, message = "Maximum")\n    private List<IngestUsageEventRequest> events;`);
  writeFileSync(path.join(base, 'config/RequestBodySizeLimitFilter.java'), `@Value("\${aforo.ingestion.max-request-body-bytes:${cap}}") long maxBytes`);
  writeFileSync(path.join(base, 'dto/IngestBatchResponse.java'), retryable ? '        private boolean retryable;' : '        private String message;');
  // usage-ingestor decodes gzip in config/GzipRequestFilter (wave 8, G269).
  if (gzip) writeFileSync(path.join(base, 'config/GzipRequestFilter.java'), 'GZIPInputStream');
  return root;
}

function check(opts) {
  const root = tree(contract, opts);
  try {
    return verify(root, contract);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a tree built from the contract is in step', () => {
  const { findings } = check();
  assert.deepEqual(findings, []);
});

test('gzip promised by the contract but no decompression in the ingestor is drift', () => {
  assert.ok(contract.transportPolicy.compression.gzip);
  const r = check({ gzip: false });
  assert.deepEqual(r.findings, ['transportPolicy.compression.gzip is true but the ingestor has no request decompression']);
});

test('a changed @Size is drift', () => {
  const dto = dtoFrom(contract, (n, lines) => (n === 'customerId' ? lines.map((l) => l.replace('@Size(max = 64)', '@Size(max = 128)')) : lines));
  const { findings } = check({ dto });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /customerId\.maxLength is 64, DTO @Size\(max\) is 128/);
});

test('a new constrained field on the DTO is drift', () => {
  const dto = dtoFrom(contract) .replace('public static class', '    @Size(max = 40)\n    private String regionCode;\n\n    public static class');
  const { findings } = check({ dto });
  assert.ok(findings.some((f) => /regionCode/.test(f)), findings.join('\n'));
});

test('a newly required field is drift', () => {
  const dto = dtoFrom(contract, (n, lines) => (n === 'productType' ? ['    @NotBlank', ...lines] : lines));
  const { findings } = check({ dto });
  assert.ok(findings.some((f) => /required fields differ/.test(f)), findings.join('\n'));
});

test('batch size, body cap, retryable flag and unmapped endpoints are checked', () => {
  assert.ok(check({ batchMax: 500 }).findings.some((f) => /maxEvents/.test(f)));
  assert.ok(check({ cap: 1048576 }).findings.some((f) => /maxRequestBodyBytes/.test(f)));
  assert.ok(check({ retryable: false }).findings.some((f) => /retryable/.test(f)));
  const c = structuredClone(contract);
  c.endpoints['/v1/ingest/new'] = { cardinality: 'single' };
  const root = tree(contract);
  try {
    assert.ok(verify(root, c).findings.some((f) => /\/v1\/ingest\/new/.test(f)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an executionStatus value added on the server is drift', () => {
  const dto = dtoFrom(contract).replace('"HITL_REQUIRED"}', '"HITL_REQUIRED", "SKIPPED"}');
  assert.ok(check({ dto }).findings.some((f) => /executionStatus\.enum/.test(f)));
});

test('the parser ignores comments and semicolons inside annotation strings', () => {
  const fields = parseDtoFields(`
    /** a ; b @Size(max = 1) */
    @Size(max = 20)
    @Schema(description = "a; b", allowableValues = {"A", "B"})
    private String status;
    // @NotBlank
    private String other;`);
  assert.deepEqual(fields.get('status'), { sizeMax: 20, required: false, allowableValues: ['A', 'B'], digits: undefined });
  assert.equal(fields.get('other').required, false);
});
