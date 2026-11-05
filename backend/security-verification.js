"use strict";

const fs = require("fs/promises");
const path = require("path");

const DEVICE_FILES = [
    "R1-HQ.txt",
    "R2-BRANCH.txt",
    "SW1-HQ.txt",
    "SW2-SERVER.txt",
    "SW3-BRANCH.txt"
];

const PROJECT_ROOT = path.resolve(
    process.env.SECURITY_PROJECT_DIR ||
    path.join(__dirname, "..", "..", "Cisco Packet Tracer 9.0.0", "secure banking network")
);
const CONFIGURATION_DIRECTORY = path.resolve(
    process.env.SECURITY_CONFIG_DIR || path.join(PROJECT_ROOT, "configurations")
);
const DOCUMENTATION_DIRECTORY = path.resolve(
    process.env.SECURITY_DOCUMENTATION_DIR || path.join(PROJECT_ROOT, "documentation")
);
const TEST_RESULTS_FILE = path.resolve(
    process.env.SECURITY_TEST_RESULTS_FILE ||
    path.join(PROJECT_ROOT, "Testing-Results", "NETWORK-TESTING-RESULTS.txt")
);

async function readOptionalFile(filePath) {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function parseAddressingPlan(text) {
    if (!text) return [];
    return [...text.matchAll(
        /VLAN\s+(\d+)\s*-\s*([^\r\n]+)\r?\nNetwork:\s*(\d{1,3}(?:\.\d{1,3}){3}\/\d+)\r?\nGateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/gi
    )].map(match => ({
        id: Number(match[1]),
        name: match[2].trim(),
        network: match[3],
        gateway: match[4]
    }));
}

function parseInterfaceBlocks(configuration) {
    const blocks = [];
    let current = null;

    for (const line of configuration.split(/\r?\n/)) {
        const interfaceMatch = line.match(/^\s*interface\s+(.+)$/i);
        if (interfaceMatch) {
            current = { name: interfaceMatch[1].trim(), lines: [] };
            blocks.push(current);
            continue;
        }

        if (/^\s*(?:!|router\s|line\s|ip access-list\s)/i.test(line)) {
            current = null;
            continue;
        }

        if (current) current.lines.push(line.trim());
    }

    return blocks;
}

function maskFromPrefix(prefix) {
    const bits = Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [24, 16, 8, 0].map(shift => (mask >>> shift) & 255).join(".");
}

function hasGateway(blocks, address, mask, subinterfaceId) {
    return blocks.some(block => {
        if (subinterfaceId !== null && !new RegExp(`\\.${subinterfaceId}$`).test(block.name)) {
            return false;
        }
        return block.lines.some(line =>
            new RegExp(`^ip address\\s+${address.replace(/\./g, "\\.")}\\s+${mask.replace(/\./g, "\\.")}$`, "i").test(line)
        );
    });
}

function expandsAllowedVlanList(value, vlanId) {
    return value.split(",").some(item => {
        const range = item.trim().match(/^(\d+)-(\d+)$/);
        if (range) {
            return vlanId >= Number(range[1]) && vlanId <= Number(range[2]);
        }
        return Number(item.trim()) === vlanId;
    });
}

function switchHasAccessVlan(configuration, vlanId) {
    return new RegExp(`^\\s*switchport access vlan\\s+${vlanId}\\s*$`, "im").test(configuration);
}

function switchHasTrunkVlan(configuration, vlanId) {
    return [...configuration.matchAll(/^\s*switchport trunk allowed vlan\s+([\d,-]+)\s*$/gim)]
        .some(match => expandsAllowedVlanList(match[1], vlanId));
}

function makeCheck(name, passed, details, source, notConfigured = false) {
    return {
        name,
        status: passed ? "Verified" : notConfigured ? "Not Configured" : "Verification Failed",
        details,
        source
    };
}

function makeFeature(status, summary, checks) {
    return { status, summary, checks };
}

function missingConfigurationFeature(name, source) {
    return makeFeature(
        "Verification Failed",
        `Cannot verify ${name}: required device configuration or project evidence is unavailable.`,
        [makeCheck(
            "Verification evidence",
            false,
            "One or more required configuration exports or project evidence files could not be read.",
            source
        )]
    );
}

function featureTestPending(testResults, featurePattern) {
    if (!testResults) return true;
    const securitySection = testResults.match(/8\.\s*SECURITY FEATURES([\s\S]*)/i)?.[1] || "";
    return featurePattern.test(securitySection) &&
        /(?:require\s+further|still\s+require)\s+configuration\s+and\s+testing/i.test(securitySection);
}

function featureTestPassed(testResults, featurePattern) {
    if (!testResults) return false;
    const securitySection = testResults.match(/8\.\s*SECURITY FEATURES([\s\S]*)/i)?.[1] || "";
    return securitySection.split(/\r?\n/).some(line =>
        featurePattern.test(line) &&
        /tested\s+successfully|verification\s+passed|verified/i.test(line)
    );
}

function parseAclDefinitions(configuration) {
    const definitions = [];
    let current = null;

    for (const line of configuration.split(/\r?\n/)) {
        const definition = line.match(/^\s*ip access-list\s+(?:standard|extended)\s+(\S+)/i);
        if (definition) {
            current = { name: definition[1], rules: [] };
            definitions.push(current);
        } else if (/^\s*!/.test(line)) {
            current = null;
        } else if (current && /^\s*(?:permit|deny)\b/i.test(line)) {
            current.rules.push(line.trim());
        }
    }

    return definitions;
}

function evaluateVlan(plan, devices, testResults, source) {
    if (plan.length === 0 || !testResults) {
        return missingConfigurationFeature("VLANs", source);
    }

    const router1 = devices["R1-HQ.txt"];
    const router2 = devices["R2-BRANCH.txt"];
    const switches = ["SW1-HQ.txt", "SW2-SERVER.txt", "SW3-BRANCH.txt"];
    const checks = [];
    const gatewayChecks = plan.map(vlan => {
        const prefix = Number(vlan.network.split("/")[1]);
        const mask = maskFromPrefix(prefix);
        const isBranchVlan = vlan.id === 60;
        const router = isBranchVlan ? router2 : router1;
        const blocks = parseInterfaceBlocks(router);
        const subinterfaceId = isBranchVlan ? null : vlan.id;
        const gatewayBlock = blocks.find(block =>
            subinterfaceId === null
                ? block.lines.some(line => new RegExp(`^ip address\\s+${vlan.gateway.replace(/\./g, "\\.")}\\s+${mask?.replace(/\./g, "\\.")}$`, "i").test(line))
                : new RegExp(`\\.${subinterfaceId}$`).test(block.name) &&
                    block.lines.some(line => new RegExp(`^ip address\\s+${vlan.gateway.replace(/\./g, "\\.")}\\s+${mask?.replace(/\./g, "\\.")}$`, "i").test(line))
        );
        const correctEncapsulation = isBranchVlan || Boolean(gatewayBlock?.lines.some(line =>
            new RegExp(`^encapsulation dot1q\\s+${vlan.id}(?:\\s|$)`, "i").test(line)
        ));
        const configured = mask !== null &&
            hasGateway(blocks, vlan.gateway, mask, subinterfaceId) &&
            correctEncapsulation;
        return { vlan, configured };
    });
    const allGateways = gatewayChecks.every(check => check.configured);
    checks.push(makeCheck(
        "Router gateways",
        allGateways,
        gatewayChecks.map(({ vlan, configured }) =>
            `VLAN ${vlan.id} (${vlan.name}): ${configured ? "gateway and subnet mask match the addressing plan" : "gateway subinterface or address does not match the addressing plan"}`
        ).join("; "),
        ["IP-ADDRESSING.txt", "R1-HQ.txt", "R2-BRANCH.txt"]
    ));

    const switchChecks = plan.map(vlan => {
        const switchAccessPresent = vlan.id === 60
            ? switchHasAccessVlan(devices["SW3-BRANCH.txt"], vlan.id)
            : switches.slice(0, 2).some(file => switchHasAccessVlan(devices[file], vlan.id));
        const trunkFiles = vlan.id === 60 ? [] : switches.slice(0, 2);
        const trunkPresent = vlan.id === 60 || trunkFiles.every(file =>
            switchHasTrunkVlan(devices[file], vlan.id)
        );
        const configured = vlan.id === 99
            ? trunkPresent
            : switchAccessPresent && trunkPresent;
        return { vlan, configured, switchAccessPresent, trunkPresent };
    });
    const allSwitches = switchChecks.every(check => check.configured);
    checks.push(makeCheck(
        "Switch VLAN membership and trunks",
        allSwitches,
        switchChecks.map(({ vlan, configured }) =>
            `VLAN ${vlan.id}: ${configured ? "access membership and required trunk carriage verified" : "access membership or required trunk carriage is missing"}`
        ).join("; "),
        ["SW1-HQ.txt", "SW2-SERVER.txt", "SW3-BRANCH.txt"]
    ));

    const listedVlanIds = plan.map(vlan => String(vlan.id));
    const configuredTest = /VLANs?\s+[\d,\s]+(?:and\s+\d+)?\s+configured/i.test(testResults) &&
        listedVlanIds.every(id => new RegExp(`\\b${id}\\b`).test(testResults));
    const interVlanTest = /INTER-VLAN ROUTING[\s\S]{0,180}tested successfully/i.test(testResults);
    checks.push(makeCheck(
        "Project VLAN and inter-VLAN test evidence",
        configuredTest && interVlanTest,
        configuredTest && interVlanTest
            ? "The test report lists the planned VLANs as configured and reports successful inter-VLAN testing."
            : "The test report does not confirm all planned VLANs and successful inter-VLAN routing.",
        "NETWORK-TESTING-RESULTS.txt"
    ));

    const status = checks.every(check => check.status === "Verified")
        ? "Verified"
        : "Verification Failed";
    return makeFeature(status, status === "Verified"
        ? "All planned VLAN gateways, switch memberships, trunks, and documented VLAN tests were verified."
        : "One or more VLAN gateway, switch, or test-evidence checks did not pass.", checks);
}

function evaluateAcl(devices, testResults, source) {
    const definitions = Object.entries(devices).flatMap(([file, configuration]) =>
        parseAclDefinitions(configuration).map(definition => ({ ...definition, file }))
    );
    const bindings = Object.entries(devices).flatMap(([file, configuration]) =>
        parseInterfaceBlocks(configuration).flatMap(block => block.lines.flatMap(line => {
            const binding = line.match(/^\s*ip access-group\s+(\S+)\s+(in|out)\s*$/i);
            return binding ? [{
                name: binding[1],
                direction: binding[2].toUpperCase(),
                file,
                interface: block.name
            }] : [];
        }))
    );

    if (definitions.length === 0) {
        return makeFeature("Not Configured", "No ACL definitions were found in the supplied device configurations.", [
            makeCheck("ACL definitions", false, "No standard or extended ACL definitions were found.", source.deviceFiles, true)
        ]);
    }

    const appliedNames = [...new Set(bindings.map(binding => binding.name))];
    const allDefinedApplied = definitions.every(definition =>
        appliedNames.includes(definition.name) && definition.rules.length > 0
    );
    const tested = featureTestPassed(testResults, /\bACL\b/i);
    const pending = featureTestPending(testResults, /\bACL\b/i);
    const checks = [
        makeCheck("ACL definitions and rules", definitions.every(definition => definition.rules.length > 0),
            definitions.map(definition =>
                `${definition.name} on ${definition.file}: ${definition.rules.length} permit/deny rules`
            ).join("; "),
            source.deviceFiles),
        makeCheck("ACL interface bindings", allDefinedApplied,
            appliedNames.length
                ? bindings.map(binding =>
                    `${binding.name} on ${binding.file} ${binding.interface} (${binding.direction})`
                ).join("; ")
                : "No ip access-group bindings were found.",
            source.deviceFiles),
        makeCheck("ACL policy testing", tested,
            tested ? "The project test report confirms ACL verification." :
                pending ? "The project test report says ACL configuration and testing remain incomplete." :
                    "The project test report does not confirm successful ACL testing.",
            "NETWORK-TESTING-RESULTS.txt")
    ];
    const status = allDefinedApplied && tested ? "Verified" : "Verification Failed";
    return makeFeature(status,
        `${definitions.length} ACL definitions and ${bindings.length} interface bindings were found; policy validation ${tested ? "is reported as successful" : "is not reported as successful"}.`,
        checks);
}

function evaluateSsh(devices, testResults, source) {
    const deviceResults = Object.entries(devices).map(([file, configuration]) => {
        const hasVersion2 = /^\s*ip ssh version 2\s*$/im.test(configuration);
        const hasDomain = /^\s*ip domain-name\s+\S+/im.test(configuration);
        const hasLocalUser = /^\s*username\s+\S+\s+(?:privilege\s+\d+\s+)?(?:secret|password)\s+/im.test(configuration);
        const hasVtySsh = /line vty[\s\S]*?transport input ssh/im.test(configuration);
        const hasLocalLogin = /line vty[\s\S]*?login local/im.test(configuration);
        return {
            file,
            configured: hasVersion2 && hasDomain && hasLocalUser && hasVtySsh && hasLocalLogin,
            details: `SSH v2: ${hasVersion2 ? "present" : "missing"}; domain: ${hasDomain ? "present" : "missing"}; local user: ${hasLocalUser ? "present" : "missing"}; VTY restricted to SSH: ${hasVtySsh ? "yes" : "no"}; local VTY login: ${hasLocalLogin ? "yes" : "no"}.`
        };
    });
    const configuredCount = deviceResults.filter(result => result.configured).length;

    if (configuredCount === 0) {
        return makeFeature("Not Configured", "SSH management configuration was not found on the supplied devices.", [
            makeCheck("SSH management configuration", false, "No device passed the SSH v2 and VTY checks.", source.deviceFiles, true)
        ]);
    }

    const allDevicesConfigured = configuredCount === deviceResults.length;
    const tested = featureTestPassed(testResults, /\bSSH\b/i);
    const pending = featureTestPending(testResults, /\bSSH\b/i);
    const checks = [
        ...deviceResults.map(result => makeCheck(
            `${result.file} SSH configuration`,
            result.configured,
            result.details,
            result.file
        )),
        makeCheck("SSH connectivity testing", tested,
            tested ? "The project test report confirms SSH verification." :
                pending ? "The project test report says SSH configuration and testing remain incomplete." :
                    "The project test report does not confirm successful SSH testing.",
            "NETWORK-TESTING-RESULTS.txt")
    ];
    const status = allDevicesConfigured && tested ? "Verified" : "Verification Failed";
    return makeFeature(status,
        `SSH v2 and restricted VTY access passed on ${configuredCount} of ${deviceResults.length} supplied network devices; successful SSH testing ${tested ? "is reported" : "is not reported"}.`,
        checks);
}

function evaluateAbsentFeature(feature, devices, testResults, source) {
    const configurations = Object.values(devices);
    const found = configurations.some(configuration => feature.pattern.test(configuration));
    const documentedPending = featureTestPending(testResults, feature.testPattern);

    if (!found && documentedPending) {
        return makeFeature("Not Configured", `${feature.label} commands were not found, and the project test report says configuration/testing is still required.`, [
            makeCheck(`${feature.label} configuration`, false, `No ${feature.label} configuration commands were found in the supplied device exports.`, source.deviceFiles, true),
            makeCheck(`${feature.label} test evidence`, false, "The project test report lists this feature as still requiring configuration and testing.", "NETWORK-TESTING-RESULTS.txt", true)
        ]);
    }

    if (!found) {
        return makeFeature("Not Configured", `No ${feature.label} configuration commands were found in the supplied device configurations.`, [
            makeCheck(`${feature.label} configuration`, false, `No ${feature.label} configuration commands were found.`, source.deviceFiles, true)
        ]);
    }

    const tested = featureTestPassed(testResults, feature.testPattern);
    const status = tested ? "Verified" : "Verification Failed";
    return makeFeature(status,
        tested ? `${feature.label} commands were found and successful testing is documented.` :
            `${feature.label} commands were found, but successful testing is not documented.`,
        [
            makeCheck(`${feature.label} configuration`, true, `${feature.label} configuration commands were found.`, source.deviceFiles),
            makeCheck(`${feature.label} testing`, tested,
                tested ? "The project test report confirms verification." : "The project test report does not confirm successful testing.",
                "NETWORK-TESTING-RESULTS.txt")
        ]);
}

async function verifySecurityFeatures() {
    const deviceEntries = await Promise.all(DEVICE_FILES.map(async file => [
        file,
        await readOptionalFile(path.join(CONFIGURATION_DIRECTORY, file))
    ]));
    const deviceFiles = Object.fromEntries(deviceEntries);
    const addressingPlan = await readOptionalFile(path.join(DOCUMENTATION_DIRECTORY, "IP-ADDRESSING.txt"));
    const testResults = await readOptionalFile(TEST_RESULTS_FILE);
    const projectOverview = await readOptionalFile(path.join(DOCUMENTATION_DIRECTORY, "PROJECT-OVERVIEW.txt"));
    const securityEvidence = [testResults, projectOverview].filter(Boolean).join("\n");
    const missingDevices = DEVICE_FILES.filter(file => deviceFiles[file] === null);
    const source = {
        deviceFiles: DEVICE_FILES.filter(file => deviceFiles[file] !== null),
        missingDeviceFiles: missingDevices,
        addressingPlanAvailable: addressingPlan !== null,
        testResultsAvailable: testResults !== null,
        projectOverviewAvailable: projectOverview !== null
    };
    const completeDevices = missingDevices.length === 0;
    const devices = Object.fromEntries(deviceEntries.map(([file, content]) => [file, content || ""]));
    const plan = parseAddressingPlan(addressingPlan);
    const featureInputsAvailable = completeDevices && addressingPlan !== null && testResults !== null;

    const features = featureInputsAvailable
        ? {
            vlan: evaluateVlan(plan, devices, securityEvidence, source),
            acl: evaluateAcl(devices, securityEvidence, source),
            ssh: evaluateSsh(devices, securityEvidence, source),
            nat: evaluateAbsentFeature({
                label: "NAT",
                pattern: /^\s*ip nat\s+(?:inside|outside|source|pool)\b/im,
                testPattern: /\bNAT\b/i
            }, devices, securityEvidence, source),
            vpn: evaluateAbsentFeature({
                label: "VPN",
                pattern: /^\s*(?:crypto\s+(?:isakmp|ikev\d*|ipsec|map)\b|tunnel protection ipsec profile\b)/im,
                testPattern: /\bVPN\b/i
            }, devices, securityEvidence, source)
        }
        : Object.fromEntries(["vlan", "acl", "ssh", "nat", "vpn"].map(feature => [
            feature,
            missingConfigurationFeature(feature.toUpperCase(), source)
        ]));

    return {
        generatedAt: new Date().toISOString(),
        source,
        features
    };
}

module.exports = {
    verifySecurityFeatures
};
