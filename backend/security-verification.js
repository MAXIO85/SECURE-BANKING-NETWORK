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

function parseLineBlocks(configuration, lineType) {
    const blocks = [];
    let current = null;
    const headingPattern = new RegExp(`^\\s*line\\s+${lineType}\\b`, "i");

    for (const rawLine of configuration.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (headingPattern.test(line)) {
            current = { name: line, lines: [] };
            blocks.push(current);
        } else if (/^(?:line\s|!|end\b)/i.test(line)) {
            current = null;
        } else if (current && line) {
            current.lines.push(line);
        }
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

function getTestSection(testResults, heading) {
    if (!testResults) return "";
    const lines = testResults.split(/\r?\n/);
    const start = lines.findIndex(line => {
        const match = line.match(/^\s*\d+\.\s*(.*?)\s*$/);
        return match && match[1].toLowerCase() === heading.toLowerCase();
    });
    if (start < 0) return "";
    const end = lines.findIndex((line, index) => index > start && /^\s*\d+\.\s/.test(line));
    return lines.slice(start + 1, end < 0 ? lines.length : end).join("\n");
}

function successfulEvidence(text) {
    return /\b(?:tested\s+successfully|verification\s+passed|verified)\b/i.test(text) &&
        !/\b(?:not|never|failed|incomplete|require(?:s|d)?\s+further|still\s+require)\b/i.test(text);
}

function featureTestPending(testResults, featurePattern) {
    if (!testResults) return true;
    const securitySection = getTestSection(testResults, "SECURITY FEATURES");
    return featurePattern.test(securitySection) &&
        /(?:require\s+further|still\s+require)\s+configuration\s+and\s+testing/i.test(securitySection);
}

function featureTestPassed(testResults, featurePattern) {
    if (!testResults) return false;
    const securitySection = getTestSection(testResults, "SECURITY FEATURES");
    return securitySection.split(/\r?\n/).some(line =>
        featurePattern.test(line) && successfulEvidence(line)
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
    const vlanTestSection = getTestSection(testResults, "VLAN CONFIGURATION");
    const interVlanTestSection = getTestSection(testResults, "INTER-VLAN ROUTING");
    const configuredTest = /VLANs?\s+[\d,\s]+(?:and\s+\d+)?\s+configured/i.test(vlanTestSection) &&
        listedVlanIds.every(id => new RegExp(`\\b${id}\\b`).test(vlanTestSection));
    const interVlanTest = successfulEvidence(interVlanTestSection);
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
        const hasOrphanBindings = bindings.length > 0;
        return makeFeature(
            hasOrphanBindings ? "Verification Failed" : "Not Configured",
            hasOrphanBindings
                ? "ACL interface bindings were found, but no matching ACL definitions exist."
                : "No ACL definitions were found in the supplied device configurations.",
            [
                makeCheck(
                    "ACL definitions",
                    false,
                    hasOrphanBindings
                        ? `No ACL definitions were found for ${bindings.map(binding => binding.name).join(", ")}.`
                        : "No standard or extended ACL definitions were found.",
                    source.deviceFiles,
                    !hasOrphanBindings
                )
            ]
        );
    }

    const definedNames = new Set(definitions.map(definition => definition.name.toLowerCase()));
    const appliedNames = [...new Set(bindings.map(binding => binding.name))];
    const allDefinitionsValid = definitions.every(definition => definition.rules.length > 0);
    const allDefinedApplied = definitions.every(definition =>
        appliedNames.some(name => name.toLowerCase() === definition.name.toLowerCase())
    );
    const allBindingsDefined = bindings.every(binding => definedNames.has(binding.name.toLowerCase()));
    const tested = featureTestPassed(testResults, /\bACL\b/i);
    const pending = featureTestPending(testResults, /\bACL\b/i);
    const checks = [
        makeCheck("ACL definitions and rules", allDefinitionsValid,
            definitions.map(definition =>
                `${definition.name} on ${definition.file}: ${definition.rules.length} permit/deny rules`
            ).join("; "),
            source.deviceFiles),
        makeCheck("ACL interface bindings", allDefinedApplied && allBindingsDefined,
            appliedNames.length
                ? bindings.map(binding =>
                    `${binding.name} on ${binding.file} ${binding.interface} (${binding.direction})`
                ).join("; ") + (allBindingsDefined ? "" : "; one or more bindings reference an undefined ACL")
                : "No ip access-group bindings were found.",
            source.deviceFiles),
        makeCheck("ACL policy testing", tested,
            tested ? "The project test report confirms ACL verification." :
                pending ? "The project test report says ACL configuration and testing remain incomplete." :
                    "The project test report does not confirm successful ACL testing.",
            "NETWORK-TESTING-RESULTS.txt")
    ];
    const configured = allDefinitionsValid && allDefinedApplied && allBindingsDefined;
    const status = configured && tested ? "Verified" : "Verification Failed";
    return makeFeature(status,
        `${definitions.length} ACL definitions and ${bindings.length} interface bindings were found; configuration ${configured ? "is consistent" : "has errors"} and policy validation ${tested ? "is reported as successful" : "is not reported as successful"}.`,
        checks);
}

function evaluateSsh(devices, testResults, source) {
    const deviceResults = Object.entries(devices).map(([file, configuration]) => {
        const hasVersion2 = /^\s*ip ssh version 2\s*$/im.test(configuration);
        const hasDomain = /^\s*ip domain-name\s+\S+/im.test(configuration);
        const hasLocalUser = /^\s*username\s+\S+\s+(?:privilege\s+\d+\s+)?(?:secret|password)\s+/im.test(configuration);
        const vtyBlocks = parseLineBlocks(configuration, "vty");
        const hasVtySsh = vtyBlocks.length > 0 &&
            vtyBlocks.every(block => block.lines.some(line => /^transport input ssh$/i.test(line)));
        const hasLocalLogin = vtyBlocks.length > 0 &&
            vtyBlocks.every(block => block.lines.some(line => /^login local$/i.test(line)));
        const anySshConfiguration = hasVersion2 || hasDomain || hasLocalUser || vtyBlocks.some(block =>
            block.lines.some(line => /^(?:transport input|login)\b/i.test(line))
        );
        return {
            file,
            configured: hasVersion2 && hasDomain && hasLocalUser && hasVtySsh && hasLocalLogin,
            anySshConfiguration,
            details: `SSH v2: ${hasVersion2 ? "present" : "missing"}; domain: ${hasDomain ? "present" : "missing"}; local user: ${hasLocalUser ? "present" : "missing"}; VTY restricted to SSH: ${hasVtySsh ? "yes" : "no"}; local VTY login: ${hasLocalLogin ? "yes" : "no"}.`
        };
    });
    const configuredCount = deviceResults.filter(result => result.configured).length;
    const anySshConfiguration = deviceResults.some(result => result.anySshConfiguration);

    if (!anySshConfiguration) {
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

function evaluateNat(devices, testResults, source) {
    const allNatCommands = Object.entries(devices).flatMap(([file, configuration]) =>
        configuration.split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => /^ip nat\b/i.test(line))
            .map(command => ({ file, command }))
    );
    const translationRules = allNatCommands.filter(item => /^ip nat inside source\b/i.test(item.command));
    const pools = new Set(allNatCommands.flatMap(({ command }) =>
        command.match(/^ip nat pool\s+(\S+)/i)?.[1] ?? []
    ));
    const accessListNames = new Set(Object.values(devices).flatMap(configuration => [
        ...parseAclDefinitions(configuration).map(definition => definition.name.toLowerCase()),
        ...[...configuration.matchAll(/^\s*access-list\s+(\S+)/gim)].map(match => match[1].toLowerCase())
    ]));
    const interfaces = Object.entries(devices).flatMap(([file, configuration]) =>
        parseInterfaceBlocks(configuration).flatMap(block => block.lines.flatMap(line =>
            /^\s*ip nat\s+(inside|outside)\s*$/i.test(line)
                ? [{ file, interface: block.name, direction: line.match(/^ip nat\s+(inside|outside)/i)[1].toLowerCase() }]
                : []
        ))
    );
    const pending = featureTestPending(testResults, /\bNAT\b/i);

    if (allNatCommands.length === 0 && interfaces.length === 0) {
        return makeFeature("Not Configured", pending
            ? "No NAT commands were found, and the project test report says NAT configuration and testing remain incomplete."
            : "No NAT commands were found in the supplied device configurations.", [
            makeCheck("NAT configuration", false, "No ip nat commands were found.", source.deviceFiles, true),
            ...(pending ? [makeCheck(
                "NAT testing",
                false,
                "The project test report says NAT configuration and testing remain incomplete.",
                "NETWORK-TESTING-RESULTS.txt",
                true
            )] : [])
        ]);
    }

    const hasInside = interfaces.some(item => item.direction === "inside");
    const hasOutside = interfaces.some(item => item.direction === "outside");
    const supportedRules = translationRules.map(({ file, command }) => {
        const dynamic = command.match(/^ip nat inside source list\s+(\S+)\s+(interface\s+\S+|pool\s+\S+)(?:\s+overload)?$/i);
        const staticMapping = command.match(/^ip nat inside source static\s+(\S+)\s+(\S+)$/i);
        const valid = Boolean(dynamic || staticMapping);
        let detail = valid ? "recognized inside-source translation rule" : "unsupported or incomplete NAT rule syntax";

        if (dynamic) {
            const aclName = dynamic[1].toLowerCase();
            if (!accessListNames.has(aclName)) {
                detail += `; referenced access list ${dynamic[1]} is not defined`;
            }
            if (dynamic[2].toLowerCase().startsWith("interface ")) {
                const interfaceName = dynamic[2].slice("interface ".length);
                if (!interfaces.some(item => item.interface.toLowerCase() === interfaceName.toLowerCase() &&
                    item.direction === "outside")) {
                    detail += `; referenced interface ${interfaceName} is not marked ip nat outside`;
                }
            }
            if (dynamic[2].toLowerCase().startsWith("pool ")) {
                const poolName = dynamic[2].slice("pool ".length);
                if (!pools.has(poolName)) {
                    detail += `; NAT pool ${poolName} is not defined`;
                }
            }
        }

        return { file, command, valid: valid && !detail.includes(";"), detail };
    });
    const rulesValid = translationRules.length > 0 && supportedRules.every(rule => rule.valid);
    const interfacesValid = hasInside && hasOutside;
    const tested = featureTestPassed(testResults, /\bNAT\b/i);
    const checks = [
        makeCheck("NAT inside/outside interfaces", interfacesValid,
            `Inside interface: ${hasInside ? "present" : "missing"}; outside interface: ${hasOutside ? "present" : "missing"}.`,
            [...new Set(interfaces.map(item => item.file))]),
        makeCheck("NAT translation rules", rulesValid,
            supportedRules.length
                ? supportedRules.map(rule => `${rule.file}: ${rule.command} (${rule.detail})`).join("; ")
                : `${pools.size} pool definition(s) found; no inside-source translation rule was found.`,
            allNatCommands.map(item => item.file)),
        makeCheck("NAT policy testing", tested,
            tested ? "The project test report confirms NAT verification." :
                pending ? "The project test report says NAT configuration and testing remain incomplete." :
                    "The project test report does not confirm successful NAT testing.",
            "NETWORK-TESTING-RESULTS.txt")
    ];
    const status = interfacesValid && rulesValid && tested ? "Verified" : "Verification Failed";
    return makeFeature(status,
        `${allNatCommands.length} NAT commands and ${translationRules.length} translation rules were found; interface roles ${interfacesValid ? "are present" : "are incomplete"}, translation rules ${rulesValid ? "are valid" : "need verification"}, and testing ${tested ? "is verified" : "is not verified"}.`,
        checks);
}

function evaluateVpn(devices, testResults, source) {
    const configurations = Object.entries(devices).map(([file, configuration]) => ({
        file,
        configuration,
        interfaces: parseInterfaceBlocks(configuration),
        commands: configuration.split(/\r?\n/).map(line => line.trim()).filter(line =>
            /^(?:crypto\s+(?:isakmp|ikev\d*|ipsec|map)\b|tunnel protection ipsec profile\b)/i.test(line)
        )
    }));
    const commandCount = configurations.reduce((total, item) => total + item.commands.length, 0);
    const pending = featureTestPending(testResults, /\bVPN\b/i);

    if (commandCount === 0) {
        return makeFeature("Not Configured", pending
            ? "No VPN commands were found, and the project test report says VPN configuration and testing remain incomplete."
            : "No VPN commands were found in the supplied device configurations.", [
            makeCheck("VPN configuration", false, "No IPsec, crypto map, or tunnel protection commands were found.", source.deviceFiles, true),
            ...(pending ? [makeCheck(
                "VPN testing",
                false,
                "The project test report says VPN configuration and testing remain incomplete.",
                "NETWORK-TESTING-RESULTS.txt",
                true
            )] : [])
        ]);
    }

    const checksByDevice = configurations.filter(item => item.commands.length > 0).map(item => {
        const hasPolicy = /^\s*crypto\s+isakmp\s+policy\b/im.test(item.configuration) ||
            /^\s*crypto\s+ikev\d*\s+policy\b/im.test(item.configuration);
        const hasTransform = /^\s*crypto\s+ipsec\s+transform-set\b/im.test(item.configuration);
        const cryptoMaps = [...item.configuration.matchAll(/^\s*crypto\s+map\s+(\S+)\s+\S+\s+ipsec-isakmp\s*$/gim)]
            .map(match => match[1]);
        const hasMapOnInterface = item.interfaces.some(block => block.lines.some(line =>
            /^crypto map\s+\S+/i.test(line)
        ));
        const hasTunnelProtection = item.interfaces.some(block => block.lines.some(line =>
            /^tunnel protection ipsec profile\s+\S+/i.test(line)
        ));
        const hasPeer = /^\s*set peer\s+\S+/im.test(item.configuration);
        const hasMapTransform = /^\s*set transform-set\s+\S+/im.test(item.configuration);
        const hasMapAcl = /^\s*match address\s+\S+/im.test(item.configuration);
        const hasCompleteMap = cryptoMaps.length > 0 && hasMapOnInterface && hasPeer && hasMapTransform && hasMapAcl;
        const hasCompleteTunnel = hasTunnelProtection &&
            /^\s*crypto\s+ipsec\s+profile\s+\S+/im.test(item.configuration) &&
            hasTransform;
        const complete = hasPolicy && hasTransform && (hasCompleteMap || hasCompleteTunnel);
        return {
            file: item.file,
            complete,
            details: `IKE policy: ${hasPolicy ? "present" : "missing"}; transform set: ${hasTransform ? "present" : "missing"}; crypto map applied: ${hasCompleteMap ? "yes" : "no"}; IPsec tunnel protection: ${hasCompleteTunnel ? "yes" : "no"}.`
        };
    });
    const configurationValid = checksByDevice.length > 0 && checksByDevice.every(item => item.complete);
    const tested = featureTestPassed(testResults, /\bVPN\b/i);
    const checks = [
        makeCheck("VPN policy and interface binding", configurationValid,
            checksByDevice.map(item => `${item.file}: ${item.details}`).join("; "),
            checksByDevice.map(item => item.file)),
        makeCheck("VPN connectivity testing", tested,
            tested ? "The project test report confirms VPN verification." :
                pending ? "The project test report says VPN configuration and testing remain incomplete." :
                    "The project test report does not confirm successful VPN testing.",
            "NETWORK-TESTING-RESULTS.txt")
    ];
    const status = configurationValid && tested ? "Verified" : "Verification Failed";
    return makeFeature(status,
        `${commandCount} VPN commands were found; policy and interface binding ${configurationValid ? "are complete" : "are incomplete"}, and testing ${tested ? "is verified" : "is not verified"}.`,
        checks);
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
    const featureInputsAvailable = completeDevices;

    const features = featureInputsAvailable
        ? {
            vlan: evaluateVlan(plan, devices, securityEvidence, source),
            acl: evaluateAcl(devices, securityEvidence, source),
            ssh: evaluateSsh(devices, securityEvidence, source),
            nat: evaluateNat(devices, securityEvidence, source),
            vpn: evaluateVpn(devices, securityEvidence, source)
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
