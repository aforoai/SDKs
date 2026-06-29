/**
 * Aforo Compound Metering for Apigee (JavaScript Callout)
 *
 * Extracts multiple metric measurements from the API response body via JSONPath
 * and buffers compound usage events for batch flush to the Aforo ingestor.
 *
 * Config via KVM (Key/Value Map):
 *   compound_metering_enabled: "true" | "false"
 *   response_extraction_paths: JSON string mapping JSONPath → metric name
 *   response_extraction_dimensions: JSON string mapping JSONPath → dimension key
 */

// ── JSONPath-lite resolution ──────────────────────────────

function resolveJsonPath(obj, path) {
    if (!obj || !path) return undefined;
    var clean = path.indexOf('$.') === 0 ? path.substring(2) : path;
    var current = obj;
    var segments = clean.split('.');
    for (var i = 0; i < segments.length; i++) {
        if (current == null) return undefined;
        var arrMatch = segments[i].match(/^(.+)\[(\d+)\]$/);
        if (arrMatch) {
            current = current[arrMatch[1]];
            if (Array.isArray(current)) current = current[parseInt(arrMatch[2])];
            else return undefined;
        } else {
            current = current[segments[i]];
        }
    }
    return current;
}

// ── Extract measurements ─────────────────────────────────

function extractMeasurements(responseBody, extractionPaths, dimensionPaths) {
    if (!responseBody) return null;
    var parsed;
    try { parsed = JSON.parse(responseBody); } catch (e) { return null; }

    var measurements = [];
    var paths = JSON.parse(extractionPaths || '{}');
    var dims = dimensionPaths ? JSON.parse(dimensionPaths) : {};

    for (var jsonPath in paths) {
        var value = resolveJsonPath(parsed, jsonPath);
        if (typeof value === 'number' && value > 0) {
            var m = { metricName: paths[jsonPath], quantity: value };
            for (var dimPath in dims) {
                var dimVal = resolveJsonPath(parsed, dimPath);
                if (typeof dimVal === 'string' && dimVal) { m.dimensionKey = dimVal; break; }
            }
            measurements.push(m);
        }
    }
    return measurements.length > 0 ? measurements : null;
}

// ── Main: PostClientFlow execution ───────────────────────

var enabled = context.getVariable('aforo.compound_metering_enabled');
if (enabled !== 'true') {
    // Compound metering disabled — skip
} else {
    var responseBody = context.getVariable('response.content');
    var extractionPaths = context.getVariable('aforo.response_extraction_paths');
    var dimensionPaths = context.getVariable('aforo.response_extraction_dimensions');

    var measurements = extractMeasurements(responseBody, extractionPaths, dimensionPaths);
    if (measurements) {
        var customerId = context.getVariable('aforo.customer_id') ||
                         context.getVariable('apiproxy.consumerkey') || '';
        var correlationId = context.getVariable('messageid') || java.util.UUID.randomUUID().toString();

        var compoundEvent = {
            correlationId: correlationId,
            customerId: customerId,
            occurredAt: new Date().toISOString(),
            metadata: {
                gateway: 'apigee',
                proxyName: context.getVariable('apiproxy.name'),
                environment: context.getVariable('environment.name'),
                statusCode: context.getVariable('response.status.code')
            },
            measurements: measurements
        };

        // Buffer in KVM for batch flush (ServiceCallout handles async POST)
        context.setVariable('aforo.compound_event', JSON.stringify(compoundEvent));
        context.setVariable('aforo.compound_event_ready', 'true');
    }
}
