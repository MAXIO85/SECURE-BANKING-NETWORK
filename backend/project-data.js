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

function parseAddressingPlan(text) {
    return [...text.matchAll(
        /VLAN\s+(\d+)\s*-\s*([^\r\n]+)\r?\nNetwork:\s*(\d{1,3}(?:\.\d{1,3}){3}\/\d+)\r?\nGateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/gi
    )].map(match => ({
        id: Number(match[1]),
        name: match[2].trim(),
        network: match[3],
        gateway: match[4]
    }));
}

function parseInterfaces(configuration) {
    const interfaces = [];
    let current = null;

    for (const rawLine of configuration.split(/\r?\n/)) {
        const line = rawLine.trim();
        const interfaceMatch = line.match(/^interface\s+(.+)$/i);
        if (interfaceMatch) {
            current = {
                name: interfaceMatch[1],
                ipAddresses: [],
                helperAddresses: [],
                accessGroups: []
            };
            interfaces.push(current);
            continue;
        }

        if (/^(?:!|router\s|line\s|ip access-list\s|ip nat\s)/i.test(line)) {
            current = null;
            continue;
        }
        if (!current || !line) continue;

        let match = line.match(/^ip address\s+(\S+)\s+(\S+)/i);
        if (match) current.ipAddresses.push({ address: match[1], subnetMask: match[2] });
        match = line.match(/^ip helper-address\s+(\S+)/i);
        if (match) current.helperAddresses.push(match[1]);
        match = line.match(/^encapsulation dot1q\s+(\d+)/i);
        if (match) current.vlanId = Number(match[1]);
        match = line.match(/^switchport access vlan\s+(\d+)/i);
        if (match) current.accessVlan = Number(match[1]);
        match = line.match(/^switchport trunk allowed vlan\s+(.+)/i);
        if (match) current.allowedVlans = match[1].trim();
        match = line.match(/^switchport mode\s+(\S+)/i);
        if (match) current.switchportMode = match[1].toLowerCase();
        match = line.match(/^ip access-group\s+(\S+)\s+(in|out)/i);
        if (match) current.accessGroups.push({ name: match[1], direction: match[2].toUpperCase() });
        if (/^shutdown$/i.test(line)) current.shutdown = true;
        if (/^no shutdown$/i.test(line)) current.shutdown = false;
        match = line.match(/^description\s+(.+)/i);
        if (match) current.description = match[1];
    }

    return interfaces.map(item => ({
        ...item,
        ipAddress: item.ipAddresses[0]?.address ?? null,
        subnetMask: item.ipAddresses[0]?.subnetMask ?? null
    }));
}

function parseAccessLists(configuration) {
    const lists = [];
    let current = null;

    for (const rawLine of configuration.split(/\r?\n/)) {
        const line = rawLine.trim();
        const definition = line.match(/^ip access-list\s+(standard|extended)\s+(\S+)/i);
        if (definition) {
            current = { type: definition[1].toUpperCase(), name: definition[2], rules: [] };
            lists.push(current);
        } else if (/^!/i.test(line) || /^ip\s/i.test(line) && !/^ip access-list/i.test(line)) {
            current = null;
        } else if (current && /^(?:permit|deny|remark)\b/i.test(line)) {
            current.rules.push(line);
        }
    }

    return lists;
}

function parseAccessListsForDevices(devices) {
    return Object.entries(devices).flatMap(([device, configuration]) =>
        parseAccessLists(configuration).map(list => {
            const bindings = parseInterfaces(configuration).flatMap(item =>
                item.accessGroups
                    .filter(binding => binding.name === list.name)
                    .map(binding => ({
                        device,
                        interface: item.name,
                        direction: binding.direction
                    }))
            );
            return { ...list, device, bindings };
        })
    );
}

function parseSection(text, heading) {
    const lines = text.split(/\r?\n/);
    const headingIndex = lines.findIndex(line => {
        const match = line.match(/^\s*\d+\.\s*(.*?)\s*$/);
        return match && match[1].toLowerCase() === heading.toLowerCase();
    });
    if (headingIndex < 0) return null;

    let endIndex = lines.findIndex((line, index) =>
        index > headingIndex && /^\s*\d+\.\s/.test(line)
    );
    if (endIndex < 0) endIndex = lines.length;
    return lines.slice(headingIndex + 1, endIndex).join("\n").trim();
}

function getTestEvidence(text, heading, successPattern) {
    const section = parseSection(text, heading);
    return {
        status: section
            ? successPattern.test(section) ? "Verified in project test report" : "Not confirmed by project test report"
            : "No project test evidence found",
        details: section
    };
}

function parseDocumentedServers(text) {
    const lines = text.split(/\r?\n/);
    const startIndex = lines.findIndex(line => /^\s*SERVERS\s*$/i.test(line));
    if (startIndex < 0) return [];
    const section = lines.slice(startIndex + 1).join("\n");
    return [...section.matchAll(/^\s*([A-Z][A-Z0-9-]+)\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/gim)]
        .map(match => ({
            name: match[1],
            ipAddress: match[2],
            source: "IP-ADDRESSING.txt"
        }));
}

function parseDnsRecords(testResults) {
    const section = parseSection(testResults, "DNS");
    if (!section) return [];
    const recordsText = section.match(/DNS records configured:\s*([\s\S]*)/i)?.[1] ?? "";
    return recordsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function parseSecurityConfiguration(devices) {
    const deviceConfigurations = Object.entries(devices).map(([name, text]) => {
        const vtyLines = [];
        let inVtySection = false;
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (/^line vty\b/i.test(line)) {
                inVtySection = true;
            } else if (/^line\s|^!|^end\b/i.test(line)) {
                inVtySection = false;
            } else if (inVtySection && line) {
                vtyLines.push(line);
            }
        }
        const username = [...text.matchAll(/^\s*username\s+(\S+)/gim)].map(match => match[1]);
        const sshChecks = {
            version2: /^\s*ip ssh version 2\s*$/im.test(text),
            domainName: text.match(/^\s*ip domain-name\s+(\S+)/im)?.[1] ?? null,
            localUsers: username,
            vtyLoginLocal: vtyLines.some(line => /^login local$/i.test(line)),
            vtySshOnly: vtyLines.some(line => /^transport input ssh$/i.test(line))
        };
        return {
            name: name.replace(/\.txt$/i, ""),
            ssh: {
                ...sshChecks,
                configured: sshChecks.version2 && Boolean(sshChecks.domainName) &&
                    sshChecks.localUsers.length > 0 && sshChecks.vtyLoginLocal && sshChecks.vtySshOnly
            },
            accessLists: parseAccessLists(text)
        };
    });

    const aclDefinitions = parseAccessListsForDevices(devices);
    const natCommands = Object.entries(devices).flatMap(([device, text]) =>
        text.split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => /^ip nat\b/i.test(line))
            .map(command => ({ device: device.replace(/\.txt$/i, ""), command }))
    );
    const vpnCommands = Object.entries(devices).flatMap(([device, text]) =>
        text.split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => /^(?:crypto\s+(?:isakmp|ikev\d*|ipsec|map)\b|tunnel protection ipsec profile\b)/i.test(line))
            .map(command => ({ device: device.replace(/\.txt$/i, ""), command }))
    );

    return {
        devices: deviceConfigurations,
        accessLists: aclDefinitions,
        nat: {
            configured: natCommands.length > 0,
            status: natCommands.length > 0 ? "Configured in device exports" : "Not configured in device exports",
            commands: natCommands
        },
        vpn: {
            configured: vpnCommands.length > 0,
            status: vpnCommands.length > 0 ? "Configured in device exports" : "Not configured in device exports",
            commands: vpnCommands
        }
    };
}

async function readSource(relativePath, baseDirectory, required = true) {
    const absolutePath = path.join(baseDirectory, relativePath);
    try {
        return {
            name: relativePath,
            content: await fs.readFile(absolutePath, "utf8")
        };
    } catch (error) {
        if (error.code === "ENOENT" && !required) return { name: relativePath, content: null };
        if (error.code === "ENOENT") {
            const missing = new Error(`Required project source file is missing: ${absolutePath}`);
            missing.statusCode = 503;
            throw missing;
        }
        throw error;
    }
}

async function loadProjectData() {
    const [deviceSources, addressing, overview, testResults] = await Promise.all([
        Promise.all(DEVICE_FILES.map(file => readSource(file, CONFIGURATION_DIRECTORY))),
        readSource("IP-ADDRESSING.txt", DOCUMENTATION_DIRECTORY),
        readSource("PROJECT-OVERVIEW.txt", DOCUMENTATION_DIRECTORY, false),
        readSource(path.basename(TEST_RESULTS_FILE), path.dirname(TEST_RESULTS_FILE), false)
    ]);

    const devices = Object.fromEntries(deviceSources.map(source => [source.name, source.content]));
    const plan = parseAddressingPlan(addressing.content);
    if (plan.length === 0) {
        const error = new Error(`No VLAN entries were found in ${addressing.name}`);
        error.statusCode = 503;
        throw error;
    }

    const parsedDevices = Object.entries(devices).map(([name, text]) => ({
        name: name.replace(/\.txt$/i, ""),
        interfaces: parseInterfaces(text)
    }));
    const routerByName = new Map(parsedDevices.map(device => [device.name, device]));
    const hq = routerByName.get("R1-HQ");
    const branch = routerByName.get("R2-BRANCH");
    const siteData = (device, location) => {
        const wanInterface = device.interfaces.find(item => item.ipAddresses.some(address => address.address.startsWith("10.255.")));
        return {
            name: location,
            router: device.name,
            ipAddress: wanInterface?.ipAddress ?? null,
            status: device.interfaces.some(item => item.ipAddresses.length > 0)
                ? "Configured in device export (not live-tested)"
                : "No configured interface addresses found",
            interfaces: device.interfaces,
            source: `${device.name}.txt`
        };
    };
    const headquarters = siteData(hq, "Head Office");
    const branchOffice = siteData(branch, "Branch Office");
    const publicSiteData = site => ({
        name: site.name,
        router: site.router,
        ipAddress: site.ipAddress,
        status: site.status,
        source: site.source
    });

    const switchData = Object.entries(devices)
        .filter(([name]) => name.startsWith("SW"))
        .flatMap(([name, text]) => parseInterfaces(text).map(item => ({ device: name.replace(/\.txt$/i, ""), ...item })));
    const vlans = plan.map(vlan => {
        const router = vlan.id === 60 ? branchOffice : headquarters;
        const gatewayInterface = router.interfaces.find(item =>
            item.vlanId === vlan.id || item.ipAddress === vlan.gateway
        );
        const accessPorts = switchData.filter(item => item.accessVlan === vlan.id)
            .map(item => ({ device: item.device, interface: item.name }));
        const trunkPorts = switchData.filter(item => item.switchportMode === "trunk" &&
            (item.allowedVlans === undefined || item.allowedVlans.split(",").some(entry => entry === String(vlan.id))))
            .map(item => ({ device: item.device, interface: item.name }));
        return {
            ...vlan,
            site: vlan.id === 60 ? "Branch Office" : "Head Office",
            gatewayInterface: gatewayInterface?.name ?? null,
            dhcpRelay: gatewayInterface?.helperAddresses ?? [],
            accessPorts,
            trunkPorts,
            source: addressing.name
        };
    });
    const servers = parseDocumentedServers(addressing.content).map(server => ({
        ...server,
        network: plan.find(vlan => server.ipAddress.startsWith(vlan.network.split("/")[0].split(".").slice(0, 3).join(".")))?.network ?? null,
        vlanId: 30,
        status: "IP documented; host configuration is not included in the exported files"
    }));

    const testText = testResults.content ?? "";
    const serviceEvidence = {
        dhcp: getTestEvidence(testText, "DHCP", /tested successfully/i),
        dns: getTestEvidence(testText, "DNS", /records configured/i),
        interVlanRouting: getTestEvidence(testText, "INTER-VLAN ROUTING", /tested successfully/i),
        branchConnectivity: getTestEvidence(testText, "BRANCH CONNECTIVITY", /successfully communicated/i),
        customerWifi: getTestEvidence(testText, "CUSTOMER WI-FI", /successfully tested connectivity/i)
    };
    const dnsRecords = parseDnsRecords(testText);
    const security = parseSecurityConfiguration(devices);
    const wanNetwork = addressing.content.match(/WAN NETWORK\s*\r?\nNetwork:\s*(\S+)/i)?.[1] ?? null;
    const interSiteRouting = {
        status: headquarters.ipAddress && branchOffice.ipAddress
            ? "WAN interfaces configured in device exports (not live-tested)"
            : "WAN interfaces not fully identified in device exports",
        wanNetwork,
        endpoints: [
            { site: headquarters.name, router: headquarters.router, ipAddress: headquarters.ipAddress },
            { site: branchOffice.name, router: branchOffice.router, ipAddress: branchOffice.ipAddress }
        ],
        evidence: serviceEvidence.branchConnectivity
    };

    return {
        project: {
            name: overview.content?.match(/^([^\r\n]+)/)?.[1]?.trim() ?? "Secure Banking Network Infrastructure",
            status: "Inventory parsed from project configuration exports",
            sourceFiles: [
                ...deviceSources.map(source => source.name),
                addressing.name,
                ...(overview.content ? [overview.name] : []),
                ...(testResults.content ? [testResults.name] : [])
            ]
        },
        headquarters: publicSiteData(headquarters),
        branch: publicSiteData(branchOffice),
        sites: [publicSiteData(headquarters), publicSiteData(branchOffice)],
        vlans,
        servers,
        interSiteRouting,
        services: {
            dhcp: {
                status: vlans.some(vlan => vlan.dhcpRelay.length > 0) ? "DHCP relay configured" : "No DHCP relay found",
                serverAddresses: [...new Set(vlans.flatMap(vlan => vlan.dhcpRelay))],
                evidence: serviceEvidence.dhcp
            },
            dns: {
                status: dnsRecords.length ? "DNS records documented" : "No DNS records documented",
                records: dnsRecords,
                evidence: serviceEvidence.dns
            },
            interVlanRouting: {
                status: headquarters.interfaces.some(item => item.vlanId !== undefined)
                    ? "Router-on-a-stick interfaces configured"
                    : "No inter-VLAN gateway interfaces found",
                evidence: serviceEvidence.interVlanRouting
            },
            branchConnectivity: serviceEvidence.branchConnectivity,
            customerWifi: serviceEvidence.customerWifi
        },
        connectivity: {
            headquarters: publicSiteData(headquarters),
            branch: publicSiteData(branchOffice),
            interSiteRouting,
            evidence: serviceEvidence.branchConnectivity
        },
        security: {
            ...security,
            evidence: testResults.content
                ? getTestEvidence(testText, "SECURITY FEATURES", /tested successfully|verification passed/i)
                : { status: "No project test evidence found", details: null }
        },
        sources: {
            configurations: deviceSources.map(source => source.name),
            addressingPlan: addressing.name,
            projectOverview: overview.content ? overview.name : null,
            testingResults: testResults.content ? testResults.name : null
        }
    };
}

async function loadProjectDocuments() {
    const sources = await Promise.all([
        readSource("PROJECT-OVERVIEW.txt", DOCUMENTATION_DIRECTORY, false),
        readSource("IP-ADDRESSING.txt", DOCUMENTATION_DIRECTORY),
        readSource(path.basename(TEST_RESULTS_FILE), path.dirname(TEST_RESULTS_FILE), false)
    ]);

    return sources
        .filter(source => source.content !== null)
        .map(source => ({
            name: source.name,
            content: source.content
        }));
}

module.exports = {
    loadProjectDocuments,
    loadProjectData
};
