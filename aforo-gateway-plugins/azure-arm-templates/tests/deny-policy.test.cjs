// Structural checks for aforo-monetized-deny-policy.json (G354).
// Run: node azure-arm-templates/tests/deny-policy.test.cjs
// What this cannot prove: that Azure accepts the template. Deploy it with
// `az deployment sub what-if` before a release.
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; return; }
    failed++;
    console.error('FAIL: ' + name + (detail !== undefined ? ' — ' + detail : ''));
}

const raw = fs.readFileSync(path.join(__dirname, '..', 'aforo-monetized-deny-policy.json'), 'utf8');
let t = null;
try { t = JSON.parse(raw); } catch (e) { check('template is JSON', false, e.message); }
if (t) {
    check('subscription-scope schema (policy definitions and assignments deploy there)',
        /subscriptionDeploymentTemplate\.json#$/.test(t.$schema), t.$schema);
    const def = t.resources.find(function (r) { return r.type === 'Microsoft.Authorization/policyDefinitions'; });
    const asg = t.resources.find(function (r) { return r.type === 'Microsoft.Authorization/policyAssignments'; });
    check('has a policy definition', !!def);
    check('has a policy assignment (a definition alone enforces nothing)', !!asg);
    if (def) {
        const rule = def.properties.policyRule;
        check('effect is denyAction', rule.then.effect === 'denyAction', rule.then.effect);
        check('actionNames is ["delete"]', JSON.stringify(rule.then.details && rule.then.details.actionNames) === '["delete"]');
        const text = JSON.stringify(rule.if);
        check('no actionType field (it is not a policy field)', text.indexOf('actionType') === -1);
        check('APIs and products are matched by fullName, not by ARM tags they do not support',
            text.indexOf('"field":"fullName"') !== -1
            && !/service\/(apis|products)[^\]]*\][^}]*tags\[/.test(text));
        check('policy parameters are escaped for the policy engine ([[)', text.indexOf("[[parameters('protectedResources')]") !== -1);
        check('the service-level rule uses the aforo-monetized tag', text.indexOf("tags['aforo-monetized']") !== -1 && text.indexOf('"Microsoft.ApiManagement/service"') !== -1);
        check('cascadeBehaviors is not used with mode All', def.properties.mode !== 'All' || !(rule.then.details || {}).cascadeBehaviors);
    }
    if (asg && def) {
        check('assignment points at the definition',
            asg.properties.policyDefinitionId.indexOf("'Microsoft.Authorization/policyDefinitions', variables('definitionName')") !== -1);
        check('assignment depends on the definition', (asg.dependsOn || []).length === 1);
        check('assignment passes both policy parameters',
            Object.keys(asg.properties.parameters).sort().join(',') === Object.keys(def.properties.parameters).sort().join(','));
        check('assignment has no read-only scope property', !('scope' in asg.properties));
    }
}

// The forwarder template ships next to the APIM policies.
const fwd = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'azure-apim', 'eventhub-forwarder', 'deploy', 'aforo-eventhub-forwarder.json'), 'utf8'));
const byType = function (ty) { return fwd.resources.filter(function (r) { return r.type === ty; }); };
check('forwarder: logger id is aforo-metering-logger', byType('Microsoft.ApiManagement/service/loggers').length === 1
    && /\/aforo-metering-logger'\)\]$/.test(byType('Microsoft.ApiManagement/service/loggers')[0].name));
check('forwarder: logger uses the APIM managed identity', byType('Microsoft.ApiManagement/service/loggers')[0].properties.credentials.identityClientId === 'SystemAssigned');
check('forwarder: namespace disables SAS keys', byType('Microsoft.EventHub/namespaces')[0].properties.disableLocalAuth === true);
check('forwarder: two role assignments (APIM sends, Function receives)', byType('Microsoft.Authorization/roleAssignments').length === 2);
check('forwarder: API key parameter is secure', fwd.parameters.aforoApiKey.type === 'securestring');
const settings = byType('Microsoft.Web/sites')[0].properties.siteConfig.appSettings.map(function (s) { return s.name; });
['AFORO_EVENTHUB_CONNECTION__fullyQualifiedNamespace', 'AFORO_EVENTHUB_NAME', 'AFORO_EVENTHUB_CONSUMER_GROUP', 'AFORO_API_KEY', 'AFORO_INGEST_URL']
    .forEach(function (n) { check('forwarder: app setting ' + n, settings.indexOf(n) !== -1); });
const fnSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'azure-apim', 'eventhub-forwarder', 'src', 'functions', 'aforoMeteringForwarder.js'), 'utf8');
['AFORO_EVENTHUB_CONNECTION', '%AFORO_EVENTHUB_NAME%', '%AFORO_EVENTHUB_CONSUMER_GROUP%'].forEach(function (n) {
    check('function binding reads ' + n, fnSrc.indexOf("'" + n + "'") !== -1);
});
check('function retries forever (no checkpoint until delivered)', /maxRetryCount:\s*-1/.test(fnSrc));

console.log('\nARM template tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
